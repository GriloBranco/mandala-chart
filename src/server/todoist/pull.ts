import "server-only";
import { repeatOf } from "@/domain/repeat";
import { dueDay, dueTime, isTimeZone, scheduleFromDue, todoistShape } from "@/domain/todoist";
import {
  listTodoistLinks,
  loadState,
  nextTodoistOutbox,
  saveTodoistLink,
  sweepTodoistDeliveries,
  todoistUserIds,
  type TodoistLink,
} from "@/server/repo";
import { TodoistError, type ActivityEvent, type TodoistTask, type TodoistUser } from "./api";
import { applyInbound, type InboundEvent } from "./inbound";
import { DOWN, markProjectGone, pushQueued, taskCommand, todayFor } from "./push";
import { withTodoist, type TodoistWorker } from "./session";

// The catch-up: Todoist's notices can come late or not at all, so the app asks for what changed
// there when it opens (at most once a minute), and a daily job does it for every account.

const CATCH_UP_EVERY_MS = 60_000;
/** The daily job stops starting new accounts after this, within the cron's minute. */
const DAILY_MS = 50_000;
/** Todoist delivers a failed notice again three times, 15 minutes apart: a day covers it. */
const DELIVERY_MS = 24 * 60 * 60_000;

/**
 * Catch-up: applies what changed in Todoist since the last look (activity log and incremental sync),
 * sends what is queued, then moves missed daily routines to today. Reads Todoist at most once a minute
 * unless forced, and always sends what waits. Returns changed = true when Mandaala changed, and
 * synced = false when an error stopped it (Todoist not answering is also saved as the account's
 * lastError, for the account page). Never throws; null when another worker is busy, or while paused.
 */
export async function catchUpTodoist(
  userId: string,
  options: { force?: boolean; timeZone?: string } = {},
): Promise<{ changed: boolean; synced: boolean } | null> {
  const result = { changed: false, synced: true };
  try {
    return await withTodoist(
      userId,
      async (worker) => {
        try {
          await catchUp(worker, options, result);
          // Changes that must wait for Todoist, or a project or sign-in lost on the way, are no sync.
          if (worker.account.status !== "ok" || worker.account.lastError === DOWN) result.synced = false;
        } catch (error) {
          // The account page says so, rather than show the last sync as if this one worked.
          if (error instanceof TodoistError && down(error)) await worker.update({ lastError: DOWN });
          throw error;
        }
        return result;
      },
      { waitMs: 5000 },
    );
  } catch (error) {
    console.error(error);
    return { ...result, synced: false };
  }
}

/** No answer, too many requests, or Todoist's own trouble. */
function down(error: TodoistError): boolean {
  return error.status === 0 || error.status === 429 || error.status >= 500;
}

async function catchUp(
  worker: TodoistWorker,
  { force, timeZone }: { force?: boolean; timeZone?: string },
  result: { changed: boolean },
): Promise<void> {
  // The browser knows the person's zone best, so "today" here is their day.
  if (timeZone && timeZone !== worker.account.timeZone && isTimeZone(timeZone)) await worker.update({ timeZone });
  if (worker.account.status !== "ok") return;
  const now = Date.now();
  const reading = force || now - worker.account.lastCatchupAt >= CATCH_UP_EVERY_MS;
  if (reading) {
    if (await readActivity(worker)) result.changed = true;
    await worker.keepAlive();
    if (await readChanges(worker)) result.changed = true;
    if (worker.account.status !== "ok") return;
  }
  // Before the rollover: a tick that waited (Todoist down overnight) completes the occurrence it
  // was for, where the rollover would only move it to today.
  await pushQueued(worker);
  if (!reading || worker.account.status !== "ok") return;
  await worker.keepAlive();
  await rollOver(worker);
  await worker.update({ lastCatchupAt: now, lastSyncAt: new Date().toISOString() });
  // Todoist answered all of it: an earlier "not answering" is over, unless changes still wait.
  if (worker.account.lastError === DOWN && (await nextTodoistOutbox(worker.userId)) === null) {
    await worker.update({ lastError: "" });
  }
}

/** Linked tasks by Todoist id. */
async function linksByTask(worker: TodoistWorker): Promise<Map<string, TodoistLink>> {
  const links = await listTodoistLinks(worker.userId);
  return new Map(links.filter((link) => link.taskId).map((link) => [link.taskId!, link]));
}

/**
 * Completions, undos and deletes from Todoist's activity log since the last one handled. The only
 * record of a routine ticked in Todoist while its notice was lost: the task itself just moves on.
 */
async function readActivity(worker: TodoistWorker): Promise<boolean> {
  let activity: ActivityEvent[];
  try {
    activity = await worker.api.activities(worker.account.activitySince || worker.account.connectedAt);
  } catch (error) {
    // Plans without an activity log: the notices and the incremental sync bring the rest.
    const refused = error instanceof TodoistError && error.status >= 400 && error.status < 500;
    if (refused && error.status !== 401 && error.status !== 429) return false;
    throw error;
  }
  if (!activity.length) return false;
  const links = await linksByTask(worker);
  const changed = await applyInbound(
    worker,
    activity.flatMap((event) => eventFromActivity(event, links.get(event.object_id))),
  );
  await worker.update({ activitySince: activity[activity.length - 1].event_date });
  return changed;
}

function eventFromActivity(event: ActivityEvent, link: TodoistLink | undefined): InboundEvent[] {
  if (!link) return [];
  const taskId = event.object_id;
  const at = event.event_date;
  const recurring = link.sent?.repeat != null;
  if (event.event_type === "completed") {
    return [{ type: "completed", taskId, at, recurring, forever: false, occurrence: occurrenceOf(event), task: null }];
  }
  if (event.event_type === "uncompleted") return [{ type: "uncompleted", taskId, at, recurring, task: null }];
  if (event.event_type === "deleted") return [{ type: "deleted", taskId, at }];
  return [];
}

/** The day of the occurrence a completion was for. To verify on a real account: these extra_data fields. */
function occurrenceOf(event: ActivityEvent): string | null {
  const extra = event.extra_data ?? {};
  const date = [extra.last_due_date, extra.due_date].find((value) => typeof value === "string");
  return typeof date === "string" ? dueDay(date) : null;
}

/** What changed in Todoist since the last sync token: edits, tasks completed or deleted, the project, the user. */
async function readChanges(worker: TodoistWorker): Promise<boolean> {
  const { account } = worker;
  const read = await worker.api.sync({
    syncToken: account.syncToken ?? "*",
    resourceTypes: ["items", "projects", "user"],
  });
  let changed = false;
  // A full sync only sets the starting point: it says nothing about what changed.
  if (!read.full_sync) {
    const project = read.projects?.find((p) => p.id === account.projectId);
    if (project?.is_deleted || project?.is_archived) {
      await markProjectGone(worker);
    } else {
      const links = await linksByTask(worker);
      changed = await applyInbound(worker, (read.items ?? []).filter((item) => links.has(item.id)).map(eventFromItem));
    }
  }
  await worker.update({ syncToken: read.sync_token ?? account.syncToken, ...userFacts(worker, read.user) });
  return changed;
}

function eventFromItem(task: TodoistTask): InboundEvent {
  const at = task.updated_at ?? new Date().toISOString();
  return task.is_deleted ? { type: "deleted", taskId: task.id, at } : { type: "changed", taskId: task.id, at, task };
}

/** The week's first day from Todoist, and its time zone until the browser tells us one. */
function userFacts(worker: TodoistWorker, user: TodoistUser | undefined) {
  const zone = user?.tz_info?.timezone;
  return {
    weekStart: user?.start_day,
    timeZone: !worker.account.timeZone && zone && isTimeZone(zone) ? zone : undefined,
  };
}

/**
 * Once a day, daily routines missed in Todoist move to today there, so they do not pile up as
 * overdue. The task keeps its own wording, language and time of day.
 */
async function rollOver(worker: TodoistWorker): Promise<void> {
  const today = todayFor(worker.account);
  if (worker.account.rolloverDay === today) return;
  const state = await loadState(worker.userId, today);
  const cells = new Map(state.goals.flatMap((goal) => goal.cells.map((cell) => [cell.id, { goal, cell }] as const)));
  const daily = new Map<string, TodoistLink>();
  for (const link of await listTodoistLinks(worker.userId)) {
    const square = cells.get(link.cellId);
    if (!square || !link.taskId || square.cell.kind !== "habit" || repeatOf(square.cell).repeat !== "day") continue;
    const shape = todoistShape(square.goal, square.cell, worker.account.appUrl);
    if (shape && !shape.completed) daily.set(link.taskId, link);
  }
  const moves = daily.size ? (await worker.api.tasks([...daily.keys()])).filter((task) => missed(task, today)) : [];
  for (let i = 0; i < moves.length; i += 100) {
    const commands = moves.slice(i, i + 100).map((task) => {
      const link = daily.get(task.id)!;
      const due = { string: task.due!.string, date: today + dueTime(task.due!.date), lang: task.due!.lang ?? "en" };
      return { link, due, command: taskCommand(worker.userId, link, "item_update", { id: task.id, due }) };
    });
    await worker.keepAlive();
    const sentAt = Date.now();
    const result = await worker.api.sync({ commands: commands.map(({ command }) => command) });
    for (const { link, due, command } of commands) {
      if (result.sync_status?.[command.uuid] !== "ok" || !link.sent) continue;
      link.sent = { ...link.sent, due: due.date };
      link.version += 1;
      link.echoes = [...link.echoes, { field: "due", value: due.date, at: sentAt }];
      await saveTodoistLink(worker.userId, link);
    }
  }
  await worker.update({ rolloverDay: today });
}

/** Due before today and still repeating every day in Todoist. */
function missed(task: TodoistTask, today: string): boolean {
  if (!task.due || dueDay(task.due.date) >= today) return false;
  const schedule = scheduleFromDue(task.due);
  return typeof schedule === "object" && schedule?.repeat === "day";
}

/** The daily job: catch-up (forced) for every connected account, oldest first, within ~50 s; sweeps old deliveries. */
export async function runTodoistDaily(): Promise<{ accounts: number }> {
  const started = Date.now();
  await sweepTodoistDeliveries(started - DELIVERY_MS);
  let accounts = 0;
  for (const userId of await todoistUserIds()) {
    if (Date.now() - started > DAILY_MS) break;
    if (await catchUpTodoist(userId, { force: true })) accounts++;
  }
  return { accounts };
}
