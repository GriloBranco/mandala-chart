import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { HttpError } from "@/domain/errors";
import { isTimeZone } from "@/domain/todoist";
import type { TodoistInfo } from "@/domain/types";
import {
  deleteTodoistData,
  deleteTodoistLink,
  deleteTodoistSection,
  findTodoistOwner,
  getTodoistAccount,
  listTodoistLinks,
  listTodoistSections,
  queueTodoist,
  saveTodoistAccount,
  type TodoistAccountRow,
} from "@/server/repo";
import { authorizeUrl, exchangeCode, revokeToken, todoistApi, type TodoistUser, type TokenSet } from "./api";
import { todoistAvailable, todoistPaused } from "./config";
import { openToken, sealToken, signValue } from "./crypto";
import { ensureProject, projectAlive } from "./push";
import { withTodoist, type TodoistWorker } from "./session";

// Connecting a Todoist account (OAuth), disconnecting it, and setting the project up again.

export const STATE_COOKIE = "mandala_todoist_state";
const STATE_PURPOSE = "todoist-state";
/** How long the person has to approve the app in Todoist, as long as the cookie lives. */
const STATE_MS = 10 * 60_000;

function redirectUri(origin: string): string {
  return `${origin}/api/todoist/callback`;
}

/** The Todoist approval URL and the cookie value proving the answer comes back to this account. */
export function startTodoistConnect(userId: string, origin: string): { url: string; cookie: string } {
  const state = randomBytes(32).toString("base64url");
  // The issue time is signed too: the cookie's own expiry binds only the browser.
  const value = `${state}.${userId}.${Date.now()}`;
  return { url: authorizeUrl(state, redirectUri(origin)), cookie: `${value}.${signValue(STATE_PURPOSE, value)}` };
}

/** The cookie was made by startTodoistConnect for this account and this state, less than 10 minutes ago. */
function stateMatches(cookie: string | undefined, state: string | null, userId: string): boolean {
  const [own, owner, issued, signature, ...rest] = (cookie ?? "").split(".");
  if (!state || rest.length || own !== state || owner !== userId || !issued || !signature) return false;
  const expected = Buffer.from(signValue(STATE_PURPOSE, `${own}.${owner}.${issued}`));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  return Date.now() - Number(issued) <= STATE_MS;
}

/** Swaps the code, stores the account, finds or makes the project and queues everything. */
export async function finishTodoistConnect(
  userId: string,
  input: { code: string | null; state: string | null; error: string | null; cookie: string | undefined; origin: string },
): Promise<"connected" | "denied" | "taken" | "error"> {
  // Paused, or the app is not set up: an approval still on its way connects nothing.
  if (!todoistAvailable()) return "error";
  if (input.error) return "denied";
  if (!input.code || !stateMatches(input.cookie, input.state, userId)) return "error";
  try {
    const tokens = await exchangeCode(input.code, redirectUri(input.origin));
    const user = await todoistApi({ token: async () => tokens.accessToken, refresh: async () => tokens.accessToken }).user();
    // The new token is not revoked: when Todoist handed back the same grant, that would cut off
    // the other account's connection.
    const owner = await findTodoistOwner(user.id);
    if (owner && owner !== userId) return "taken";
    await saveConnection(userId, user, tokens, input.origin);
    await queueTodoist(userId, "all");
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) return "taken";
    console.error(error);
    return "error";
  }
  // Connected from here on: what fails below, the first send does again.
  try {
    await withTodoist(userId, setUp, { waitMs: 5000 });
  } catch (error) {
    console.error(error);
  }
  return "connected";
}

/**
 * Stores the connection. The same Todoist user connecting again (after Todoist asked for a new
 * sign-in) keeps the project, the links and where the catch-up left off, so nothing done meanwhile
 * is lost. Another Todoist user starts over.
 */
async function saveConnection(userId: string, user: TodoistUser, tokens: TokenSet, origin: string): Promise<void> {
  const before = await getTodoistAccount(userId);
  const same = before?.todoistUserId === user.id ? before : null;
  if (before && !same) {
    // Never for the same Todoist user: Todoist may have handed back the same grant.
    await revokeTodoist(userId);
    await deleteTodoistData(userId);
  }
  const now = new Date().toISOString();
  const zone = user.tz_info?.timezone;
  const row: Omit<TodoistAccountRow, "userId"> = {
    todoistUserId: user.id,
    email: user.email ?? "",
    accessToken: sealToken(tokens.accessToken),
    refreshToken: tokens.refreshToken ? sealToken(tokens.refreshToken) : null,
    expiresAt: tokens.expiresAt,
    projectId: same?.projectId ?? null,
    appUrl: origin,
    timeZone: zone && isTimeZone(zone) ? zone : (same?.timeZone ?? ""),
    weekStart: user.start_day ?? 1,
    status: "ok",
    lastError: "",
    syncToken: same?.syncToken ?? null,
    activitySince: same?.activitySince || now,
    lastSyncAt: same?.lastSyncAt ?? null,
    lastCatchupAt: same?.lastCatchupAt ?? 0,
    rolloverDay: same?.rolloverDay ?? "",
    connectedAt: now,
  };
  await saveTodoistAccount(userId, row);
}

/** The starting point for incremental sync, and the project, checked again when it was kept. */
async function setUp(worker: TodoistWorker): Promise<void> {
  if (!worker.account.syncToken) {
    // Only the token: what is in Todoist now is not news.
    const read = await worker.api.sync({ syncToken: "*", resourceTypes: ["items", "projects", "user"] });
    if (read.sync_token) await worker.update({ syncToken: read.sync_token });
  }
  if (worker.account.projectId && !(await projectAlive(worker))) await forgetProject(worker);
  await ensureProject(worker);
}

/** Forgets the project's tasks and sections, so everything goes to a new one. */
async function forgetProject(worker: TodoistWorker): Promise<void> {
  for (const link of await listTodoistLinks(worker.userId)) await deleteTodoistLink(worker.userId, link.cellId);
  for (const section of await listTodoistSections(worker.userId)) await deleteTodoistSection(worker.userId, section.goalId);
  await worker.update({ projectId: null });
}

/** Revokes the token (best effort) and forgets the connection. Tasks already in Todoist stay. */
export async function disconnectTodoist(userId: string): Promise<void> {
  await revokeTodoist(userId);
  try {
    await deleteTodoistData(userId);
  } catch (error) {
    console.error(error);
  }
}

/** Best-effort token revoke only, before the account itself is deleted. */
export async function revokeTodoist(userId: string): Promise<void> {
  try {
    const account = await getTodoistAccount(userId);
    if (account) await revokeToken(openToken(account.accessToken));
  } catch (error) {
    console.error(error);
  }
}

/** After the project was deleted in Todoist: forget links and sections, make a new project, send everything. */
export async function rebuildTodoist(userId: string): Promise<void> {
  try {
    await withTodoist(
      userId,
      async (worker) => {
        // Only once it is gone: pressed twice, it must not make a second project.
        if (worker.account.status !== "project_gone") return;
        await forgetProject(worker);
        await worker.update({ status: "ok", lastError: "" });
        await queueTodoist(userId, "all");
        await ensureProject(worker);
      },
      { waitMs: 5000 },
    );
  } catch (error) {
    // The first send makes the project when this could not.
    console.error(error);
  }
}

/** What the account page shows. */
export async function todoistInfo(user: { id: string; todoist: boolean }): Promise<TodoistInfo> {
  const available = todoistAvailable();
  const none: TodoistInfo = { available, connected: false, status: null, email: "", lastSyncAt: null, error: "" };
  // Runs on every /api/state: no lookup for an account that never connected. While paused the app
  // shows no connection, so it does not ask for syncs either.
  if (!user.todoist || todoistPaused()) return none;
  const account = await getTodoistAccount(user.id);
  if (!account) return none;
  return {
    available,
    connected: true,
    status: account.status,
    email: account.email,
    lastSyncAt: account.lastSyncAt,
    error: account.lastError,
  };
}
