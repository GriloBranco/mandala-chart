import "server-only";
import type { InStatement, ResultSet, Row } from "@libsql/client";
import { getDb } from "@/server/db";
import { HttpError } from "@/domain/errors";
import { isConflict, newId, placeholders, stillOwned, USER_CELLS, type Guard } from "./shared";

// Todoist sync: the connection, the task each square became, one section per goal, and the
// Mandaala changes waiting to be sent (the outbox). Every function takes the Mandaala user id
// first and touches only that user's rows, except the few marked otherwise: webhooks name only
// the Todoist user, and the daily job runs for every account.

export type TodoistStatus = "ok" | "reauth" | "project_gone";

export interface TodoistAccountRow {
  userId: string;
  todoistUserId: string;
  email: string;
  /** Sealed (see crypto.ts). */
  accessToken: string;
  /** Sealed (see crypto.ts). */
  refreshToken: string | null;
  /** When the access token stops working (ms epoch); null for a token that never expires. */
  expiresAt: number | null;
  projectId: string | null;
  appUrl: string;
  timeZone: string;
  /** Todoist's first day of the week: 1 = Monday ... 7 = Sunday. */
  weekStart: number;
  status: TodoistStatus;
  lastError: string;
  syncToken: string | null;
  /** Time of the newest Todoist activity already handled. */
  activitySince: string;
  lastSyncAt: string | null;
  /** ms epoch */
  lastCatchupAt: number;
  /** The last local day missed daily routines were moved to today. */
  rolloverDay: string;
  connectedAt: string;
}

export interface LinkState {
  content: string;
  description: string;
  priority: number;
  repeat: string | null;
  completed: boolean;
  /** The pick (cells.activated_at) the due date was set for, so a new pick moves it to this week. */
  activatedAt: string | null;
  /** Todoist's due date as last known ("YYYY-MM-DD" or with time), null when none. */
  due: string | null;
}

export interface Echo {
  /**
   * A value we sent ("content" | "notes" | "repeat" | "due"), matched by value; a completion we
   * sent ("done" | "undone" | "forward" | "back"), matched by when Todoist says it happened; or a
   * routine's tick or undo in Todoist already applied ("ticked" | "unticked", value: the day), so
   * the activity log does not apply it again.
   */
  field: string;
  value: string;
  /** ms epoch: when we sent it, or when Todoist says the tick or undo happened. */
  at: number;
}

export interface TodoistLink {
  cellId: string;
  goalId: string;
  taskId: string | null;
  sent: LinkState | null;
  echoes: Echo[];
  seenState: string;
  seenDone: string;
  inboundCheckin: { day: string; at: string } | null;
  version: number;
  createdAt: string;
}

export interface TodoistSection {
  goalId: string;
  sectionId: string;
  name: string;
  archived: boolean;
}

export interface OutboxRow {
  id: string;
  kind: "cell" | "checkin" | "goal" | "all";
  target: string;
  detail: string;
  attempts: number;
  nextAt: number;
  createdAt: string;
}

/** A late Todoist notice of a value we sent comes within this long, so older echoes are dropped. */
const ECHO_MS = 10 * 60_000;
/**
 * Completions we sent, and ticks and undos of a routine already applied, come back in Todoist's
 * activity log, which the daily catch-up reads and which keeps a week of events, so they are
 * remembered a little longer than that.
 */
const LONG_ECHO_MS = 8 * 24 * 60 * 60_000;
export const LONG_ECHOES = new Set(["done", "undone", "forward", "back", "ticked", "unticked"]);

/** "a = excluded.a, ...": an upsert's update takes every new value. */
const takeNew = (columns: string[]) => columns.map((column) => `${column} = excluded.${column}`).join(", ");

const nullable = (value: unknown) => (value == null ? null : String(value));

/** Holds while the user has a Todoist account. */
function hasTodoist(userId: string): Guard {
  return { sql: "EXISTS (SELECT 1 FROM todoist_accounts WHERE user_id = ?)", args: [userId] };
}

// ---------- accounts ----------

type AccountPatch = Partial<Omit<TodoistAccountRow, "userId" | "todoistUserId">>;

/** The column of each field a save or an update sets. */
const ACCOUNT_COLUMNS: Record<keyof AccountPatch, string> = {
  email: "email",
  accessToken: "access_token",
  refreshToken: "refresh_token",
  expiresAt: "expires_at",
  projectId: "project_id",
  appUrl: "app_url",
  timeZone: "time_zone",
  weekStart: "week_start",
  status: "status",
  lastError: "last_error",
  syncToken: "sync_token",
  activitySince: "activity_since",
  lastSyncAt: "last_sync_at",
  lastCatchupAt: "last_catchup_at",
  rolloverDay: "rollover_day",
  connectedAt: "connected_at",
};
const ACCOUNT_FIELDS = Object.keys(ACCOUNT_COLUMNS) as (keyof AccountPatch)[];

function toAccount(row: Row): TodoistAccountRow {
  return {
    userId: String(row.user_id),
    todoistUserId: String(row.todoist_user_id),
    email: String(row.email),
    accessToken: String(row.access_token),
    refreshToken: nullable(row.refresh_token),
    expiresAt: row.expires_at == null ? null : Number(row.expires_at),
    projectId: nullable(row.project_id),
    appUrl: String(row.app_url),
    timeZone: String(row.time_zone),
    weekStart: Number(row.week_start),
    status: row.status === "reauth" || row.status === "project_gone" ? row.status : "ok",
    lastError: String(row.last_error),
    syncToken: nullable(row.sync_token),
    activitySince: String(row.activity_since),
    lastSyncAt: nullable(row.last_sync_at),
    lastCatchupAt: Number(row.last_catchup_at),
    rolloverDay: String(row.rollover_day),
    connectedAt: String(row.connected_at),
  };
}

export async function getTodoistAccount(userId: string): Promise<TodoistAccountRow | null> {
  const db = await getDb();
  const result = await db.execute({ sql: "SELECT * FROM todoist_accounts WHERE user_id = ?", args: [userId] });
  return result.rows.length ? toAccount(result.rows[0]) : null;
}

/** The Mandaala account a Todoist user is connected to (for webhooks, which name only the Todoist user). */
export async function findTodoistOwner(todoistUserId: string): Promise<string | null> {
  const db = await getDb();
  const result = await db.execute({
    sql: "SELECT user_id FROM todoist_accounts WHERE todoist_user_id = ?",
    args: [todoistUserId],
  });
  return result.rows.length ? String(result.rows[0].user_id) : null;
}

/** Insert or replace. HttpError 409 when that Todoist user is connected to another Mandaala account. */
export async function saveTodoistAccount(userId: string, row: Omit<TodoistAccountRow, "userId">): Promise<void> {
  const db = await getDb();
  const columns = ["todoist_user_id", ...ACCOUNT_FIELDS.map((field) => ACCOUNT_COLUMNS[field])];
  let saved: ResultSet;
  try {
    // Written only while the Mandaala account exists. A replace keeps the lease of a worker that
    // holds it. Not INSERT OR REPLACE: that would delete another account's row for the same
    // Todoist user instead of failing.
    saved = await db.execute({
      sql: `INSERT INTO todoist_accounts (user_id, ${columns.join(", ")})
        SELECT ?, ${placeholders(columns.length)} WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)
        ON CONFLICT (user_id) DO UPDATE SET ${takeNew(columns)}`,
      args: [userId, row.todoistUserId, ...ACCOUNT_FIELDS.map((field) => row[field]), userId],
    });
  } catch (error) {
    // todoist_user_id is unique: another account connected this Todoist user first.
    if (isConflict(error)) {
      const owner = await findTodoistOwner(row.todoistUserId);
      if (owner && owner !== userId) throw new HttpError(409, "That Todoist account is linked to another account.");
    }
    throw error;
  }
  if (!saved.rowsAffected) throw new HttpError(401, "Not signed in");
}

export async function updateTodoistAccount(userId: string, patch: AccountPatch): Promise<void> {
  const fields = ACCOUNT_FIELDS.filter((field) => patch[field] !== undefined);
  if (!fields.length) return;
  const db = await getDb();
  await db.execute({
    sql: `UPDATE todoist_accounts SET ${fields.map((field) => `${ACCOUNT_COLUMNS[field]} = ?`).join(", ")} WHERE user_id = ?`,
    args: [...fields.map((field) => patch[field] ?? null), userId],
  });
}

/** Forgets the connection: account, links, sections and queued changes. */
export async function deleteTodoistData(userId: string): Promise<void> {
  const db = await getDb();
  await db.batch(
    [
      { sql: "DELETE FROM todoist_outbox WHERE user_id = ?", args: [userId] },
      { sql: "DELETE FROM todoist_sections WHERE user_id = ?", args: [userId] },
      { sql: "DELETE FROM todoist_links WHERE user_id = ?", args: [userId] },
      { sql: "DELETE FROM todoist_accounts WHERE user_id = ?", args: [userId] },
    ],
    "write",
  );
}

/**
 * Every connected Mandaala user id, the longest without a catch-up first (for the daily job).
 * Not user-scoped by design.
 */
export async function todoistUserIds(): Promise<string[]> {
  const db = await getDb();
  const result = await db.execute("SELECT user_id FROM todoist_accounts ORDER BY last_catchup_at, connected_at");
  return result.rows.map((row) => String(row.user_id));
}

/** Takes the account's lease (or extends it for the same owner). False when someone else holds it. */
export async function claimTodoistLease(userId: string, owner: string, until: number, now: number): Promise<boolean> {
  const db = await getDb();
  // One conditional write, so two workers can never both get it.
  const result = await db.execute({
    sql: `UPDATE todoist_accounts SET lease_owner = ?, lease_until = ?
      WHERE user_id = ? AND (lease_owner = ? OR lease_until <= ?)`,
    args: [owner, until, userId, owner, now],
  });
  return result.rowsAffected === 1;
}

export async function releaseTodoistLease(userId: string, owner: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: "UPDATE todoist_accounts SET lease_owner = '', lease_until = 0 WHERE user_id = ? AND lease_owner = ?",
    args: [userId, owner],
  });
}

// ---------- links ----------

/** Columns a link save replaces (cell_id and user_id are its key). */
const LINK_COLUMNS = ["goal_id", "task_id", "sent", "echoes", "seen_state", "seen_done", "inbound_checkin", "version", "created_at"];

/** A JSON column's value, or undefined when it is empty or not valid JSON. */
function parseJson(value: unknown): unknown {
  try {
    return JSON.parse(String(value ?? ""));
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const textOr = <T>(value: unknown, fallback: T) => (typeof value === "string" ? value : fallback);

/** What Todoist has as last sent; null when it was never confirmed or cannot be read. */
function toLinkState(value: unknown): LinkState | null {
  const sent = parseJson(value);
  if (!isObject(sent)) return null;
  return {
    content: textOr(sent.content, ""),
    description: textOr(sent.description, ""),
    priority: typeof sent.priority === "number" ? sent.priority : 1,
    repeat: textOr(sent.repeat, null),
    completed: sent.completed === true,
    activatedAt: textOr(sent.activatedAt, null),
    due: textOr(sent.due, null),
  };
}

function isEcho(value: unknown): value is Echo {
  return isObject(value) && typeof value.field === "string" && typeof value.value === "string" && typeof value.at === "number";
}

function toEchoes(value: unknown): Echo[] {
  const echoes = parseJson(value);
  return Array.isArray(echoes) ? echoes.filter(isEcho).map(({ field, value, at }) => ({ field, value, at })) : [];
}

function toInboundCheckin(value: unknown): TodoistLink["inboundCheckin"] {
  const checkin = parseJson(value);
  return isObject(checkin) && typeof checkin.day === "string" && typeof checkin.at === "string"
    ? { day: checkin.day, at: checkin.at }
    : null;
}

function toLink(row: Row): TodoistLink {
  return {
    cellId: String(row.cell_id),
    goalId: String(row.goal_id),
    taskId: nullable(row.task_id),
    sent: toLinkState(row.sent),
    echoes: toEchoes(row.echoes),
    seenState: String(row.seen_state),
    seenDone: String(row.seen_done),
    inboundCheckin: toInboundCheckin(row.inbound_checkin),
    version: Number(row.version),
    createdAt: String(row.created_at),
  };
}

export async function listTodoistLinks(userId: string): Promise<TodoistLink[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: "SELECT * FROM todoist_links WHERE user_id = ? ORDER BY created_at",
    args: [userId],
  });
  return result.rows.map(toLink);
}

export async function todoistLinkForTask(userId: string, taskId: string): Promise<TodoistLink | null> {
  const db = await getDb();
  const result = await db.execute({
    sql: "SELECT * FROM todoist_links WHERE task_id = ? AND user_id = ?",
    args: [taskId, userId],
  });
  return result.rows.length ? toLink(result.rows[0]) : null;
}

/**
 * Insert or replace by cell id, dropping old echoes (values after 10 minutes, completions and
 * applied ticks after 8 days). Writes nothing when the user has no Todoist account, so a worker
 * that finishes after a disconnect leaves nothing behind.
 */
export async function saveTodoistLink(userId: string, link: TodoistLink): Promise<void> {
  const now = Date.now();
  const echoes = link.echoes.filter((echo) => echo.at >= now - (LONG_ECHOES.has(echo.field) ? LONG_ECHO_MS : ECHO_MS));
  const guard = hasTodoist(userId);
  const db = await getDb();
  await db.execute({
    // The update never touches a row of another account.
    sql: `INSERT INTO todoist_links (cell_id, user_id, ${LINK_COLUMNS.join(", ")})
      SELECT ?, ?, ${placeholders(LINK_COLUMNS.length)} WHERE ${guard.sql}
      ON CONFLICT (cell_id) DO UPDATE SET ${takeNew(LINK_COLUMNS)}
      WHERE todoist_links.user_id = excluded.user_id`,
    args: [
      link.cellId,
      userId,
      link.goalId,
      link.taskId,
      link.sent ? JSON.stringify(link.sent) : null,
      JSON.stringify(echoes),
      link.seenState,
      link.seenDone,
      link.inboundCheckin ? JSON.stringify(link.inboundCheckin) : "",
      link.version,
      link.createdAt,
      ...guard.args,
    ],
  });
}

export async function deleteTodoistLink(userId: string, cellId: string): Promise<void> {
  const db = await getDb();
  await db.execute({ sql: "DELETE FROM todoist_links WHERE cell_id = ? AND user_id = ?", args: [cellId, userId] });
}

// ---------- sections ----------

export async function listTodoistSections(userId: string): Promise<TodoistSection[]> {
  const db = await getDb();
  const result = await db.execute({ sql: "SELECT * FROM todoist_sections WHERE user_id = ?", args: [userId] });
  return result.rows.map((row) => ({
    goalId: String(row.goal_id),
    sectionId: String(row.section_id),
    name: String(row.name),
    archived: Number(row.archived) === 1,
  }));
}

/** Insert or replace by goal id. Like a link, written only while the user has a Todoist account. */
export async function saveTodoistSection(userId: string, section: TodoistSection): Promise<void> {
  const guard = hasTodoist(userId);
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO todoist_sections (goal_id, user_id, section_id, name, archived)
      SELECT ?, ?, ?, ?, ? WHERE ${guard.sql}
      ON CONFLICT (goal_id) DO UPDATE SET ${takeNew(["section_id", "name", "archived"])}
      WHERE todoist_sections.user_id = excluded.user_id`,
    args: [section.goalId, userId, section.sectionId, section.name, section.archived ? 1 : 0, ...guard.args],
  });
}

export async function deleteTodoistSection(userId: string, goalId: string): Promise<void> {
  const db = await getDb();
  await db.execute({ sql: "DELETE FROM todoist_sections WHERE goal_id = ? AND user_id = ?", args: [goalId, userId] });
}

// ---------- outbox ----------

function toOutboxRow(row: Row): OutboxRow {
  return {
    id: String(row.id),
    kind: String(row.kind) as OutboxRow["kind"],
    target: String(row.target),
    detail: String(row.detail),
    attempts: Number(row.attempts),
    nextAt: Number(row.next_at),
    createdAt: String(row.created_at),
  };
}

/** Queues a change, only when the user has a Todoist account (and `when` holds). */
function outboxStatement(userId: string, kind: OutboxRow["kind"], target: string, detail: string, when?: Guard): InStatement {
  const guards = when ? [hasTodoist(userId), when] : [hasTodoist(userId)];
  return {
    sql: `INSERT INTO todoist_outbox (id, user_id, kind, target, detail, attempts, next_at, created_at)
      SELECT ?, ?, ?, ?, ?, 0, 0, ? WHERE ${guards.map((guard) => guard.sql).join(" AND ")}`,
    args: [newId(), userId, kind, target, detail, new Date().toISOString(), ...guards.flatMap((guard) => guard.args)],
  };
}

/** Queued changes due now, oldest first. */
export async function dueTodoistOutbox(userId: string, now: number, limit: number): Promise<OutboxRow[]> {
  const db = await getDb();
  // rowid breaks ties between rows queued in the same millisecond.
  const result = await db.execute({
    sql: "SELECT * FROM todoist_outbox WHERE user_id = ? AND next_at <= ? ORDER BY created_at, rowid LIMIT ?",
    args: [userId, now, limit],
  });
  return result.rows.map(toOutboxRow);
}

export async function finishTodoistOutbox(userId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const db = await getDb();
  await db.execute({
    sql: `DELETE FROM todoist_outbox WHERE user_id = ? AND id IN (${placeholders(ids.length)})`,
    args: [userId, ...ids],
  });
}

/** Counts a failed try and waits until `nextAt` before the next one. */
export async function retryTodoistOutbox(userId: string, ids: string[], nextAt: number): Promise<void> {
  if (!ids.length) return;
  const db = await getDb();
  await db.execute({
    sql: `UPDATE todoist_outbox SET attempts = attempts + 1, next_at = ?
      WHERE user_id = ? AND id IN (${placeholders(ids.length)})`,
    args: [nextAt, userId, ...ids],
  });
}

/** Makes every queued change due now, so "Sync now" also sends the ones held back after a failure. */
export async function releaseTodoistOutbox(userId: string): Promise<void> {
  const db = await getDb();
  await db.execute({ sql: "UPDATE todoist_outbox SET next_at = 0 WHERE user_id = ?", args: [userId] });
}

/** Queues a change (only when the user has a Todoist account). */
export async function queueTodoist(userId: string, kind: OutboxRow["kind"], target = "", detail = ""): Promise<void> {
  const db = await getDb();
  await db.execute(outboxStatement(userId, kind, target, detail));
}

/** When the oldest queued change becomes due (ms), or null when nothing waits. */
export async function nextTodoistOutbox(userId: string): Promise<number | null> {
  const db = await getDb();
  const result = await db.execute({
    sql: "SELECT MIN(next_at) AS next_at FROM todoist_outbox WHERE user_id = ?",
    args: [userId],
  });
  const next = result.rows[0]?.next_at;
  return next == null ? null : Number(next);
}

// ---------- webhook deliveries (not user-scoped: keyed by Todoist's delivery id) ----------

export async function todoistDeliverySeen(id: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({ sql: "SELECT 1 FROM todoist_deliveries WHERE id = ?", args: [id] });
  return result.rows.length > 0;
}

export async function recordTodoistDelivery(id: string, now: number): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: "INSERT INTO todoist_deliveries (id, received_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING",
    args: [id, now],
  });
}

export async function sweepTodoistDeliveries(before: number): Promise<void> {
  const db = await getDb();
  await db.execute({ sql: "DELETE FROM todoist_deliveries WHERE received_at < ?", args: [before] });
}

// ---------- statements for the write batches in cells.ts and goals.ts ----------
// Each writes an outbox row only when the user has a Todoist account, so accounts without
// Todoist pay nothing but a lookup inside a write they make anyway.

/** Holds when one of the guards holds. */
function anyOf(...guards: Guard[]): Guard {
  return { sql: `(${guards.map((guard) => guard.sql).join(" OR ")})`, args: guards.flatMap((guard) => guard.args) };
}

/** The square is linked to a Todoist task. */
function linked(userId: string, cellId: string): Guard {
  return { sql: "EXISTS (SELECT 1 FROM todoist_links WHERE cell_id = ? AND user_id = ?)", args: [cellId, userId] };
}

/** The square is picked for this week. */
function picked(userId: string, cellId: string): Guard {
  return { sql: `EXISTS (${USER_CELLS} WHERE c.id = ? AND g.user_id = ? AND c.active = 1)`, args: [cellId, userId] };
}

/**
 * A queued change may still make or change the square's task: one for the square, for its goal or
 * for everything. Its push may have read the square already, so a change made while it is on its
 * way has to follow it, even before the square is linked (an Undo of a pick during the first
 * create, say).
 */
function queuedFor(userId: string, cellId: string): Guard {
  return {
    sql: `EXISTS (${USER_CELLS} JOIN todoist_outbox o ON o.user_id = g.user_id
      AND (o.kind = 'all' OR o.target IN (c.id, c.goal_id)) WHERE c.id = ? AND g.user_id = ?)`,
    args: [cellId, userId],
  };
}

/**
 * For a square change: only when the square is linked, picked, or has a change queued that may
 * still make its task. Put it after the change in the same batch, so it sees the square as
 * changed (a square just removed from this week still counts while it is linked).
 */
export function cellOutboxStatement(userId: string, cellId: string): InStatement {
  const when = anyOf(linked(userId, cellId), picked(userId, cellId), queuedFor(userId, cellId));
  return outboxStatement(userId, "cell", cellId, "", when);
}

/** For a check-in change: only when the square is linked, or has a change queued that may still make its task. */
export function checkinOutboxStatement(userId: string, cellId: string, day: string, done: boolean): InStatement {
  const when = anyOf(linked(userId, cellId), queuedFor(userId, cellId));
  return outboxStatement(userId, "checkin", cellId, JSON.stringify({ day, done }), when);
}

/** For a goal change: only while the goal is the user's, so a delete puts it first in its batch. */
export function goalOutboxStatement(userId: string, goalId: string): InStatement {
  return outboxStatement(userId, "goal", goalId, "", stillOwned(userId, goalId));
}
