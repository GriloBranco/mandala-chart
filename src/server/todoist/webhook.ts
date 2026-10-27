import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  findTodoistOwner,
  getTodoistAccount,
  nextTodoistOutbox,
  recordTodoistDelivery,
  todoistDeliverySeen,
  todoistLinkForTask,
} from "@/server/repo";
import { todoistApp } from "./config";
import { applyInbound, eventsFromWebhook, type InboundEvent } from "./inbound";
import { pushQueued } from "./push";
import { withTodoist, type TodoistWorker } from "./session";

// Todoist's notices of changes made there. They carry Todoist's signature instead of a session,
// and Todoist sends a notice again (same delivery id) until it gets a 200.

/** How long a notice waits for a worker of the same account to finish. */
const WAIT_MS = 8000;

/** Constant-time check of X-Todoist-Hmac-SHA256 (base64 HMAC-SHA256 of the raw body with the client secret). */
export function verifyTodoistSignature(raw: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  const given = Buffer.from(signature, "base64");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Handles one webhook delivery. Answers the HTTP status to send (200 when done or ignored, 401 bad signature,
 *  503 when the account is busy so Todoist retries, 500 on failure). */
export async function handleTodoistWebhook(raw: string, headers: Headers): Promise<number> {
  const app = todoistApp();
  if (!app) return 404;
  if (!verifyTodoistSignature(raw, headers.get("x-todoist-hmac-sha256"), app.clientSecret)) return 401;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return 400;
  }
  try {
    const delivery = headers.get("x-todoist-delivery-id");
    if (delivery && (await todoistDeliverySeen(delivery))) return 200;
    const todoistUserId = (payload as { user_id?: unknown } | null)?.user_id;
    const owner =
      typeof todoistUserId === "string" || typeof todoistUserId === "number"
        ? await findTodoistOwner(String(todoistUserId))
        : null;
    // Not connected (any more): nothing to do, and nothing to send again.
    if (!owner) return 200;
    const events = await aboutMandaala(owner, eventsFromWebhook(payload));
    if (events.length) {
      const applied = await withTodoist(owner, (worker) => applyAndSend(worker, events), { waitMs: WAIT_MS });
      // Busy for longer than Todoist waits: it sends the notice again later.
      if (applied === null) return 503;
    }
    if (delivery) await recordTodoistDelivery(delivery, Date.now());
    return 200;
  } catch (error) {
    console.error(error);
    return 500;
  }
}

/**
 * Only the notices about Mandaala's own tasks and project. Todoist sends one for every change the
 * person makes there, and the others must neither wait for the account's lease nor hold it.
 */
async function aboutMandaala(owner: string, events: InboundEvent[]): Promise<InboundEvent[]> {
  const kept: InboundEvent[] = [];
  for (const event of events) {
    const known =
      event.type === "project_gone"
        ? (await getTodoistAccount(owner))?.projectId === event.projectId
        : Boolean(await todoistLinkForTask(owner, event.taskId));
    if (known) kept.push(event);
  }
  return kept;
}

/**
 * Applies the notice, then sends what waits now: a change the notice left for Todoist, or one
 * whose own send gave up while this worker held the lease.
 */
async function applyAndSend(worker: TodoistWorker, events: InboundEvent[]): Promise<boolean> {
  const changed = await applyInbound(worker, events);
  const next = await nextTodoistOutbox(worker.userId);
  if (next !== null && next <= Date.now()) {
    // The notice is applied either way: a send that fails waits for its next try.
    await pushQueued(worker).catch((error: unknown) => console.error(error));
  }
  return changed;
}
