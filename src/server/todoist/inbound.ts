import "server-only";
import { addDays } from "@/domain/days";
import { NOTES_MAX } from "@/domain/mandala";
import { checkinsInPeriod, periodStart, repeatOf } from "@/domain/repeat";
import {
  cleanText,
  completionDay,
  describe,
  dueDay,
  localDay,
  notesFrom,
  repeatString,
  scheduleFromDue,
  squareLink,
  taskPriority,
  todoistShape,
} from "@/domain/todoist";
import type { AppState, Cell, CellPatch, GoalWithCells } from "@/domain/types";
import { pillarName } from "@/domain/week";
import {
  deleteTodoistLink,
  loadState,
  queueTodoist,
  saveTodoistLink,
  setCheckin,
  todoistLinkForTask,
  updateCell,
  type Echo,
  type LinkState,
  type TodoistLink,
} from "@/server/repo";
import type { TodoistDue, TodoistTask } from "./api";
import { CHECKIN_DAYS, markProjectGone, projectAlive, todayFor } from "./push";
import type { TodoistWorker } from "./session";

// Todoist to Mandaala. Changes come as webhook notices, and again from the activity log and the
// incremental sync of the catch-up, so each may arrive late, twice or out of order. Notices of our
// own commands come back too: "echoes" (recent sends, on the link) tell them apart.

export type InboundEvent =
  | {
      type: "completed";
      taskId: string;
      at: string;
      recurring: boolean;
      forever: boolean;
      occurrence: string | null;
      task: TodoistTask | null;
    }
  | { type: "uncompleted"; taskId: string; at: string; recurring: boolean; task: TodoistTask | null }
  | { type: "changed"; taskId: string; at: string; task: TodoistTask }
  | { type: "deleted"; taskId: string; at: string }
  | { type: "project_gone"; projectId: string; at: string };

type EventOf<T extends InboundEvent["type"]> = Extract<InboundEvent, { type: T }>;

/** Todoist dates a notice of a completion we sent within this long of when we sent it. */
const ECHO_MS = 2 * 60_000;
/**
 * Todoist's time and ours for one command differ by a few seconds, and so do the times a notice and
 * the activity log give one tick or undo.
 */
const MOMENT_MS = 10_000;
/** A completion we sent, and the one that takes it back. */
const OPPOSITE: Record<string, string> = { forward: "back", back: "forward", done: "undone", undone: "done" };

interface Square {
  goal: GoalWithCells;
  cell: Cell;
}

interface Inbound {
  worker: TodoistWorker;
  today: string;
  /** The chart, read when first needed and again after each change made here. */
  state: Pick<AppState, "goals" | "checkins"> | null;
  changed: boolean;
  alive: boolean | null;
}

// ---------- webhook notices ----------

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

function idOf(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function toDue(value: unknown): TodoistDue | null {
  if (!isRecord(value) || typeof value.date !== "string") return null;
  const due: TodoistDue = { date: value.date, string: text(value.string), is_recurring: value.is_recurring === true };
  if (typeof value.lang === "string") due.lang = value.lang;
  return due;
}

/** The fields of a Todoist task we use, from a notice's event_data or old_item. */
function toTask(value: unknown): TodoistTask | null {
  const id = isRecord(value) ? idOf(value.id) : null;
  if (!isRecord(value) || !id) return null;
  return {
    id,
    content: text(value.content),
    description: text(value.description),
    project_id: idOf(value.project_id) ?? "",
    section_id: idOf(value.section_id),
    priority: typeof value.priority === "number" ? value.priority : 1,
    due: toDue(value.due),
    checked: value.checked === true,
    is_deleted: value.is_deleted === true,
    completed_at: text(value.completed_at) || null,
    updated_at: text(value.updated_at) || null,
  };
}

/** Reads a webhook body (already verified) into events. Unknown events give []. */
export function eventsFromWebhook(payload: unknown): InboundEvent[] {
  if (!isRecord(payload) || !isRecord(payload.event_data)) return [];
  const data = payload.event_data;
  const extra = isRecord(payload.event_data_extra) ? payload.event_data_extra : {};
  const at = text(payload.triggered_at) || text(data.updated_at) || new Date().toISOString();
  if (payload.event_name === "project:deleted" || payload.event_name === "project:archived") {
    const projectId = idOf(data.id);
    return projectId ? [{ type: "project_gone", projectId, at }] : [];
  }
  const task = toTask(data);
  if (!task) return [];
  const taskId = task.id;
  const recurring = Boolean(task.due?.is_recurring);
  switch (payload.event_name) {
    case "item:completed": {
      // A repeating task completed for good, rather than one occurrence of it.
      const forever = recurring && task.checked;
      const occurrence = forever || !task.due ? null : dueDay(task.due.date);
      return [{ type: "completed", taskId, at, recurring, forever, occurrence, task }];
    }
    case "item:uncompleted":
      return [{ type: "uncompleted", taskId, at, recurring, task }];
    case "item:deleted":
      return [{ type: "deleted", taskId, at }];
    case "item:updated": {
      // One occurrence of a repeating task done or undone comes as an update. To verify on a real
      // account: whether item:completed also fires for it.
      if (extra.update_intent === "item_completed") {
        const old = toTask(extra.old_item);
        const occurrence = old?.due ? dueDay(old.due.date) : null;
        return [{ type: "completed", taskId, at, recurring: true, forever: false, occurrence, task }];
      }
      if (extra.update_intent === "item_uncompleted") return [{ type: "uncompleted", taskId, at, recurring: true, task }];
      return [{ type: "changed", taskId, at, task }];
    }
    default:
      return [];
  }
}

// ---------- applying ----------

/** Applies Todoist changes to Mandaala. Call while holding the lease. True when Mandaala changed. */
export async function applyInbound(worker: TodoistWorker, events: InboundEvent[]): Promise<boolean> {
  const inbound: Inbound = { worker, today: todayFor(worker.account), state: null, changed: false, alive: null };
  for (const event of events) {
    // Waiting for a new sign-in, or the project is gone: Mandaala is not changed. After a new sign-in
    // the catch-up reads what happened meanwhile.
    if (worker.account.status !== "ok") break;
    await applyEvent(inbound, event);
  }
  return inbound.changed;
}

async function applyEvent(inbound: Inbound, event: InboundEvent): Promise<void> {
  const { worker } = inbound;
  if (event.type === "project_gone") {
    if (event.projectId === worker.account.projectId) await markProjectGone(worker);
    return;
  }
  const link = await todoistLinkForTask(worker.userId, event.taskId);
  if (!link) return;
  if (event.type === "deleted") return deleted(inbound, link);
  // A square that is gone: the next push deletes its task.
  const square = await squareOf(inbound, link.cellId);
  if (!square) return;
  if (event.type === "changed") await changed(inbound, link, square, event);
  else if (event.type === "completed") await completed(inbound, link, square, event);
  else await uncompleted(inbound, link, square, event);
  await saveTodoistLink(worker.userId, link);
}

/**
 * Todoist deleted the task: the square leaves this week, unless the whole project went. A square
 * that left Todoist's list (taken out, its goal archived) had its task deleted by us: the notice
 * can come before Todoist's answer did, and the square stays as it is.
 */
async function deleted(inbound: Inbound, link: TodoistLink): Promise<void> {
  inbound.alive ??= await projectAlive(inbound.worker);
  if (!inbound.alive) return markProjectGone(inbound.worker);
  const square = await squareOf(inbound, link.cellId);
  if (square && todoistShape(square.goal, square.cell, inbound.worker.account.appUrl)) {
    await write(inbound, square, { active: false });
  }
  // Forgotten last: when the write above fails, the notice sent again still finds the link.
  await deleteTodoistLink(inbound.worker.userId, link.cellId);
}

async function completed(inbound: Inbound, link: TodoistLink, square: Square, event: EventOf<"completed">) {
  // While Todoist holds the routine as done for good, a completion is that one, told again.
  if (event.recurring && !event.forever && square.cell.kind === "habit" && !link.sent?.completed) {
    return occurrenceDone(inbound, link, square, event);
  }
  // A task, a routine done for good, or a task the person gave a repeat in Todoist: done once ticked.
  return doneChanged(inbound, link, square, true, event.at);
}

async function uncompleted(inbound: Inbound, link: TodoistLink, square: Square, event: EventOf<"uncompleted">) {
  // A routine done for good and reopened is no occurrence.
  if (event.recurring && square.cell.kind === "habit" && !link.sent?.completed) {
    return occurrenceUndone(inbound, link, square, event);
  }
  return doneChanged(inbound, link, square, false, event.at);
}

/** A task (or a routine for good) completed or reopened in Todoist. */
async function doneChanged(inbound: Inbound, link: TodoistLink, square: Square, done: boolean, at: string): Promise<void> {
  // Older than a notice already applied: a late or repeated one.
  const seen = instant(link.seenDone);
  if (instant(at) <= seen) return;
  if (ours(link, done ? ["done"] : ["undone"], at, seen)) return;
  const sent = sentOf(inbound, link, square);
  const { cell } = square;
  const merged = merge(link, ["done", "undone"], sent.completed, cell.status === "done", done, at, cell.updatedAt);
  link.seenDone = at;
  sent.completed = merged.todoist;
  if (merged.apply) await write(inbound, square, done ? { status: "done", doneAt: iso(at) } : { status: "todo" });
  await pushIfApart(inbound, link, square);
}

/**
 * One occurrence of a routine done in Todoist: a check-in on its day, unless that period has one.
 * `inboundCheckin` remembers the newest tick, with the day it checked in ('' for none), for an undo.
 * Each tick applied is kept as a "ticked" echo too: the same tick comes again from a second notice
 * or the activity log, maybe after the person took its check-in back in Mandaala.
 */
async function occurrenceDone(inbound: Inbound, link: TodoistLink, square: Square, event: EventOf<"completed">) {
  if (ours(link, ["forward", "done"], event.at)) return;
  const told = toldBefore(link, "ticked", event.at);
  if (told) {
    if (!told.value) await finishTick(inbound, link, square, told);
    return;
  }
  const sent = sentOf(inbound, link, square);
  if (event.task?.due) sent.due = event.task.due.date;
  const { cell } = square;
  const day = completionDay(localDay(event.at, inbound.worker.account.timeZone || "UTC"), event.occurrence);
  const last = link.inboundCheckin;
  // A tick older than the last one applied must not take over what an undo removes.
  const newest = !last || instant(event.at) > instant(last.at);
  const { checkins } = await stateOf(inbound);
  if (checkinsInPeriod(cell, checkins, day).length) {
    // Ticked again in the period of the last tick (after an undo, say): an undo older than this
    // tick leaves that check-in. A check-in made in Mandaala is never removed by an undo there.
    if (newest) link.inboundCheckin = { day: last?.day && samePeriod(cell, last.day, day) ? last.day : "", at: event.at };
    remember(link, "ticked", day, event.at);
    return;
  }
  if (!(await tickStands(inbound, link, event))) return;
  if (newest) link.inboundCheckin = { day, at: event.at };
  // Saved before the check-in is written, with no day until it is: when a failure comes between
  // the two, the notice sent again finds the tick and writes its check-in.
  const tick = remember(link, "ticked", "", event.at);
  await saveTodoistLink(inbound.worker.userId, link);
  await check(inbound, cell.id, day, true);
  tick.value = day;
}

/**
 * A tick saved whose check-in may never have been written. Unless something took it back since
 * (an undo, the person in Mandaala, a newer tick), the check-in is written now.
 */
async function finishTick(inbound: Inbound, link: TodoistLink, { cell }: Square, tick: Echo): Promise<void> {
  const made = link.inboundCheckin;
  if (!made?.day || instant(made.at) !== tick.at) return;
  const { checkins } = await stateOf(inbound);
  if (!checkins.some((c) => c.cellId === cell.id && c.day === made.day)) await check(inbound, cell.id, made.day, true);
  tick.value = made.day;
}

/**
 * A notice of a tick can come after the tick was undone: notices come out of order, and one that
 * failed comes again later. While the tick stands, Todoist's task sits after the occurrence it
 * ticked. The activity log lists events in order, so there the undo that follows does the work.
 */
async function tickStands(inbound: Inbound, link: TodoistLink, event: EventOf<"completed">): Promise<boolean> {
  // Only a notice carries the task.
  if (!event.task || !event.occurrence || !link.taskId) return true;
  const [task] = await inbound.worker.api.tasks([link.taskId]);
  // Done for good, deleted or without a date: nothing says the tick was undone.
  if (!task?.due) return true;
  return dueDay(task.due.date) > event.occurrence;
}

/** A routine's completion undone in Todoist: only the check-in that completion made goes. */
async function occurrenceUndone(inbound: Inbound, link: TodoistLink, square: Square, event: EventOf<"uncompleted">) {
  if (ours(link, ["back", "undone"], event.at)) return;
  if (toldBefore(link, "unticked", event.at)) return;
  const sent = sentOf(inbound, link, square);
  if (event.task?.due) sent.due = event.task.due.date;
  // Never another day: that could remove a check-in the person made in Mandaala.
  const made = link.inboundCheckin;
  if (!made || instant(made.at) > instant(event.at)) return;
  // The undo put the task back on the occurrence it undid, and a tick checks in on that day or
  // later. A check-in before it came from an earlier tick: the one undone is still on its way.
  const back = event.task?.due ? dueDay(event.task.due.date) : null;
  if (made.day && back && made.day < back) return;
  link.inboundCheckin = null;
  remember(link, "unticked", made.day, event.at);
  const { checkins } = await stateOf(inbound);
  if (made.day && checkins.some((c) => c.cellId === square.cell.id && c.day === made.day)) {
    await check(inbound, square.cell.id, made.day, false);
  }
}

/** Text, notes or repeat edited in Todoist, merged with the square field by field. */
async function changed(inbound: Inbound, link: TodoistLink, square: Square, event: EventOf<"changed">) {
  const { task, at } = event;
  const seen = instant(link.seenState);
  if (instant(at) < seen) return;
  link.seenState = at;
  const { cell, goal } = square;
  const appUrl = inbound.worker.account.appUrl;
  const sent = sentOf(inbound, link, square);
  const patch: CellPatch = {};

  const content = cleanText(task.content);
  if (content && !echoed(link, "content", content, seen)) {
    const merged = merge(link, ["content"], sent.content, cell.text.trim(), content, at, cell.updatedAt);
    if (merged.apply) patch.text = content;
    sent.content = merged.todoist;
  }

  const notes = notesFrom(task.description, appUrl).slice(0, NOTES_MAX);
  if (!echoed(link, "notes", notes, seen)) {
    const base = notesFrom(sent.description, appUrl);
    const merged = merge(link, ["notes"], base, cell.notes.trim(), notes, at, cell.updatedAt);
    // Todoist holds only the start of long notes, so its copy would drop the rest. Mandaala's stay,
    // and the push below sends them back over the edit made there.
    if (merged.apply && !cutInTodoist(square, appUrl)) patch.notes = notes;
    // Kept with our footer: the person may drop or change theirs without it coming back.
    if (merged.todoist !== base) sent.description = describe(merged.todoist, footerOf(goal, cell, appUrl));
  }

  const schedule = scheduleFromDue(task.due);
  const repeat = cell.kind === "habit" ? repeatString(cell) : null;
  if (schedule === "custom") {
    // A repeat Mandaala cannot show stays in Todoist: ours is never sent over it.
    sent.repeat = repeat;
  } else {
    const theirs = schedule ? repeatString(schedule) : null;
    if (!echoed(link, "repeat", theirs ?? "", seen)) {
      const merged = merge(link, ["repeat"], sent.repeat, repeat, theirs, at, cell.updatedAt);
      if (merged.apply) Object.assign(patch, schedule ? { kind: "habit", ...schedule } : { kind: "task" });
      sent.repeat = merged.todoist;
    }
  }
  sent.due = task.due?.date ?? null;

  if (Object.keys(patch).length) await write(inbound, square, patch);
  // The catch-up's way to see a task completed or reopened there.
  if (task.checked !== sent.completed) return doneChanged(inbound, link, square, task.checked, task.completed_at ?? at);
  await pushIfApart(inbound, link, square);
}

// ---------- merging ----------

/**
 * Three-way merge of one value: `base` is what Todoist had as last known, `ours` the square now,
 * `theirs` what the notice says. Mandaala takes theirs when the square did not change since, or
 * when the notice is newer than the square. A notice older than our last send of the value is
 * stale: Todoist holds what we sent since, so `todoist` stays the base.
 */
function merge<T>(
  link: TodoistLink,
  fields: string[],
  base: T,
  ours: T,
  theirs: T,
  at: string,
  updatedAt: string,
): { apply: boolean; todoist: T } {
  if (theirs === base) return { apply: false, todoist: base };
  const stale = sentSince(link, fields, at);
  const newer = instant(at) > instant(updatedAt);
  return { apply: ours !== theirs && (newer || (!stale && ours === base)), todoist: stale ? base : theirs };
}

/**
 * A value we sent recently. Only sends after the last notice applied (`after`) count: one from
 * before cannot explain a newer notice, so the person setting a value back is not taken for ours.
 */
function echoed(link: TodoistLink, field: string, value: string, after: number): boolean {
  return link.echoes.some((echo) => echo.field === field && echo.value === value && echo.at > after);
}

/**
 * A completion we sent: Todoist dates its notice within two minutes of when we sent it. Matched by
 * time and kept, since the webhook and the activity log both bring it back. As for values, a send
 * before the last notice applied (`after`) does not count. Nor does one we took back (back after
 * forward, undone after done) before the notice's time: then the notice is the person's.
 */
function ours(link: TodoistLink, fields: string[], at: string, after = Number.NEGATIVE_INFINITY): boolean {
  const time = instant(at);
  const takenBack = (echo: Echo) =>
    link.echoes.some(
      (other) => other.field === OPPOSITE[echo.field] && other.at > echo.at && other.at + MOMENT_MS <= time,
    );
  return link.echoes.some(
    (echo) => fields.includes(echo.field) && echo.at > after && Math.abs(time - echo.at) <= ECHO_MS && !takenBack(echo),
  );
}

/** A tick or undo of the routine in Todoist applied already, now told again. */
function toldBefore(link: TodoistLink, field: "ticked" | "unticked", at: string): Echo | undefined {
  const time = instant(at);
  return link.echoes.find((echo) => echo.field === field && Math.abs(time - echo.at) <= MOMENT_MS);
}

/** Keeps a tick or undo applied, by Todoist's time for it, with the day it was for. */
function remember(link: TodoistLink, field: "ticked" | "unticked", day: string, at: string): Echo {
  const echo = { field, value: day, at: instant(at) };
  link.echoes = [...link.echoes, echo];
  return echo;
}

/** We sent one of these fields after the notice's time. */
function sentSince(link: TodoistLink, fields: string[], at: string): boolean {
  const time = instant(at);
  return link.echoes.some((echo) => fields.includes(echo.field) && echo.at > time);
}

/**
 * The square and Todoist still differ after a notice (the square changed meanwhile, or the notice
 * was older than what we sent): a push brings Todoist up to date.
 */
async function pushIfApart(inbound: Inbound, link: TodoistLink, { cell }: Square): Promise<void> {
  const sent = link.sent;
  if (!sent) return;
  const apart =
    cell.text.trim() !== sent.content ||
    cell.notes.trim() !== notesFrom(sent.description, inbound.worker.account.appUrl) ||
    (cell.kind === "habit" ? repeatString(cell) : null) !== sent.repeat ||
    (cell.status === "done") !== sent.completed;
  if (apart) await queueTodoist(inbound.worker.userId, "cell", cell.id);
}

// ---------- helpers ----------

/** ms epoch of a Todoist time (six fraction digits), or -Infinity for none. Never compare them as text. */
function instant(time: string): number {
  const ms = Date.parse(time);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

function iso(time: string): string {
  const ms = Date.parse(time);
  return new Date(Number.isNaN(ms) ? Date.now() : ms).toISOString();
}

function samePeriod(cell: Cell, a: string, b: string): boolean {
  const schedule = repeatOf(cell);
  return periodStart(schedule, a) === periodStart(schedule, b);
}

function footerOf(goal: GoalWithCells, cell: Cell, appUrl: string) {
  return {
    pillar: pillarName(goal, cell.pillar),
    goal: goal.title.trim(),
    link: squareLink(appUrl, goal.id, cell.pillar, cell.id),
  };
}

/** The square's notes are longer than a Todoist description holds: describe() sends only their start. */
function cutInTodoist({ goal, cell }: Square, appUrl: string): boolean {
  return notesFrom(describe(cell.notes, footerOf(goal, cell, appUrl)), appUrl).length < cell.notes.trim().length;
}

/** What Todoist was last sent; for a link that never had it, the square as Todoist would show it. */
function sentOf(inbound: Inbound, link: TodoistLink, { goal, cell }: Square): LinkState {
  link.sent ??= {
    content: cell.text.trim(),
    description: describe(cell.notes, footerOf(goal, cell, inbound.worker.account.appUrl)),
    priority: taskPriority(cell),
    repeat: cell.kind === "habit" ? repeatString(cell) : null,
    completed: cell.status === "done",
    activatedAt: cell.activatedAt,
    due: null,
  };
  return link.sent;
}

async function stateOf(inbound: Inbound): Promise<Pick<AppState, "goals" | "checkins">> {
  inbound.state ??= await loadState(inbound.worker.userId, addDays(inbound.today, -CHECKIN_DAYS));
  return inbound.state;
}

async function squareOf(inbound: Inbound, cellId: string): Promise<Square | null> {
  for (const goal of (await stateOf(inbound)).goals) {
    const cell = goal.cells.find((c) => c.id === cellId);
    if (cell) return { goal, cell };
  }
  return null;
}

/** A change from Todoist, so it is not sent back there. */
async function write(inbound: Inbound, square: Square, patch: CellPatch): Promise<void> {
  square.cell = await updateCell(inbound.worker.userId, square.cell.id, patch, { fromTodoist: true });
  inbound.changed = true;
  inbound.state = null;
}

async function check(inbound: Inbound, cellId: string, day: string, done: boolean): Promise<void> {
  await setCheckin(inbound.worker.userId, cellId, day, done, { fromTodoist: true });
  inbound.changed = true;
  inbound.state = null;
}
