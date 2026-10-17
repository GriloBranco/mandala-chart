import "server-only";
import type { InStatement, InValue, ResultSet, Row } from "@libsql/client";
import { getDb } from "./db";
import { HttpError } from "./errors";
import { applyPatch, normalizePatch, NOTES_MAX, PILLAR_SLOT } from "./mandala";
import type {
  AppState,
  Cell,
  CellPatch,
  Checkin,
  EventType,
  Goal,
  GoalPatch,
  GoalWithCells,
  ProgressEvent,
  ProposedUpdate,
  Report,
  ReportSource,
  ReportWithEvents,
} from "./types";

// Every function takes the signed-in user's id first and only reads or writes that user's
// rows: goals, reports, events and check-ins by user_id, squares through their goal. Anything
// that belongs to someone else behaves exactly as if it did not exist (404, or skipped).
// New rows are written only while what they belong to still exists (the account, the goal, the
// report), checked inside the same write transaction: a request that passed the session check
// just before its account or goal was deleted leaves nothing behind.

const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();

/** Goals per account, archived ones included, so one account cannot fill the database. */
const GOAL_LIMIT = 50;
/** Saved reports per account per day (UTC). */
const REPORTS_PER_DAY = 30;

const goalLimit = () =>
  new HttpError(422, `You've reached the limit of ${GOAL_LIMIT} goals. Delete one to add another.`);
const reportLimit = () => new HttpError(422, "That's today's limit for saved reports. It resets tomorrow.");

/** Why a guarded insert wrote nothing: the account was deleted meanwhile, or it is at a limit. */
async function refusal(userId: string, limit: HttpError): Promise<HttpError> {
  const db = await getDb();
  const user = await db.execute({ sql: "SELECT 1 FROM users WHERE id = ?", args: [userId] });
  return user.rows.length ? limit : new HttpError(401, "Not signed in");
}

interface Guard {
  sql: string;
  args: InValue[];
}

/** Holds while the goal (and the report, when given) still belong to the user. */
function stillOwned(userId: string, goalId: string, reportId: string | null = null): Guard {
  const goal = "EXISTS (SELECT 1 FROM goals WHERE id = ? AND user_id = ?)";
  if (!reportId) return { sql: goal, args: [goalId, userId] };
  return {
    sql: `${goal} AND EXISTS (SELECT 1 FROM reports WHERE id = ? AND user_id = ?)`,
    args: [goalId, userId, reportId, userId],
  };
}

/** A write lost a race on a primary key (the same client id saved twice at once). */
function isConflict(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return /SQLITE_CONSTRAINT|UNIQUE constraint/i.test(`${String(code ?? "")} ${String(message ?? "")}`);
}

/** Squares of one user (through their goal). Append the WHERE with g.user_id = ?. */
const USER_CELLS = "SELECT c.* FROM cells c JOIN goals g ON g.id = c.goal_id";

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function toGoal(row: Row): Goal {
  return {
    id: String(row.id),
    title: String(row.title),
    why: String(row.why),
    deadline: row.deadline == null ? null : String(row.deadline),
    status: String(row.status) as Goal["status"],
    position: Number(row.position),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toCell(row: Row): Cell {
  return {
    id: String(row.id),
    goalId: String(row.goal_id),
    pillar: Number(row.pillar),
    slot: Number(row.slot),
    text: String(row.text),
    notes: String(row.notes),
    kind: String(row.kind) as Cell["kind"],
    status: String(row.status) as Cell["status"],
    progress: Number(row.progress),
    impact: row.impact == null ? null : Number(row.impact),
    effort: row.effort == null ? null : Number(row.effort),
    helps: parseHelps(row.helps),
    active: Number(row.active) === 1,
    activatedAt: row.activated_at == null ? null : String(row.activated_at),
    doneAt: row.done_at == null ? null : String(row.done_at),
    updatedAt: String(row.updated_at),
  };
}

function parseHelps(value: unknown): number[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter((n) => Number.isInteger(n) && n >= 0 && n < 8) : [];
  } catch {
    return [];
  }
}

function toReport(row: Row): Report {
  return {
    id: String(row.id),
    goalId: row.goal_id == null ? null : String(row.goal_id),
    source: String(row.source) as ReportSource,
    transcript: String(row.transcript),
    summary: String(row.summary),
    day: String(row.day),
    createdAt: String(row.created_at),
  };
}

function toEvent(row: Row): ProgressEvent {
  return {
    id: String(row.id),
    goalId: String(row.goal_id),
    cellId: row.cell_id == null ? null : String(row.cell_id),
    reportId: row.report_id == null ? null : String(row.report_id),
    type: String(row.type) as EventType,
    detail: String(row.detail),
    createdAt: String(row.created_at),
  };
}

function toCheckin(row: Row): Checkin {
  return { cellId: String(row.cell_id), goalId: String(row.goal_id), day: String(row.day) };
}

/** Logs a change, only while its goal (and report) still belong to the user. A repeated fixed id logs nothing. */
function eventStatement(userId: string, event: Omit<ProgressEvent, "id" | "createdAt">, id = newId()): InStatement {
  const guard = stillOwned(userId, event.goalId, event.reportId);
  return {
    sql: `INSERT INTO events (id, user_id, goal_id, cell_id, report_id, type, detail, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql} ON CONFLICT (id) DO NOTHING`,
    args: [id, userId, event.goalId, event.cellId, event.reportId, event.type, event.detail, now(), ...guard.args],
  };
}

function groupCells(rows: Row[]): Map<string, Cell[]> {
  const byGoal = new Map<string, Cell[]>();
  for (const row of rows) {
    const cell = toCell(row);
    const list = byGoal.get(cell.goalId) ?? [];
    list.push(cell);
    byGoal.set(cell.goalId, list);
  }
  return byGoal;
}

// ---------- reads ----------

export async function loadState(userId: string, checkinsSince: string): Promise<Pick<AppState, "goals" | "checkins">> {
  const db = await getDb();
  const [goals, cells, checkins] = await db.batch(
    [
      { sql: "SELECT * FROM goals WHERE user_id = ? ORDER BY position, created_at", args: [userId] },
      { sql: `${USER_CELLS} WHERE g.user_id = ? ORDER BY c.goal_id, c.pillar, c.slot`, args: [userId] },
      { sql: "SELECT cell_id, goal_id, day FROM checkins WHERE user_id = ? AND day >= ?", args: [userId, checkinsSince] },
    ],
    "read",
  );
  const byGoal = groupCells(cells.rows);
  return {
    goals: goals.rows.map((row) => {
      const goal = toGoal(row);
      return { ...goal, cells: byGoal.get(goal.id) ?? [] };
    }),
    checkins: checkins.rows.map(toCheckin),
  };
}

export async function getGoal(userId: string, id: string): Promise<GoalWithCells> {
  const db = await getDb();
  const [goal, cells] = await db.batch(
    [
      { sql: "SELECT * FROM goals WHERE id = ? AND user_id = ?", args: [id, userId] },
      { sql: `${USER_CELLS} WHERE c.goal_id = ? AND g.user_id = ? ORDER BY c.pillar, c.slot`, args: [id, userId] },
    ],
    "read",
  );
  if (!goal.rows.length) throw new HttpError(404, "Goal not found");
  return { ...toGoal(goal.rows[0]), cells: cells.rows.map(toCell) };
}

async function getGoalOnly(userId: string, id: string): Promise<Goal> {
  const db = await getDb();
  const result = await db.execute({ sql: "SELECT * FROM goals WHERE id = ? AND user_id = ?", args: [id, userId] });
  if (!result.rows.length) throw new HttpError(404, "Goal not found");
  return toGoal(result.rows[0]);
}

export async function getCell(userId: string, id: string): Promise<Cell> {
  const db = await getDb();
  const result = await db.execute({ sql: `${USER_CELLS} WHERE c.id = ? AND g.user_id = ?`, args: [id, userId] });
  if (!result.rows.length) throw new HttpError(404, "Cell not found");
  return toCell(result.rows[0]);
}

async function getCells(userId: string, ids: string[]): Promise<Map<string, Cell>> {
  if (!ids.length) return new Map();
  const db = await getDb();
  const result = await db.execute({
    sql: `${USER_CELLS} WHERE c.id IN (${placeholders(ids.length)}) AND g.user_id = ?`,
    args: [...ids, userId],
  });
  return new Map(result.rows.map((row) => [String(row.id), toCell(row)]));
}

export async function listActiveGoals(userId: string): Promise<GoalWithCells[]> {
  const state = await loadState(userId, "9999-12-31");
  return state.goals.filter((goal) => goal.status === "active");
}

export async function listReports(userId: string, options: { goalId?: string; limit: number }): Promise<Report[]> {
  const db = await getDb();
  const result = options.goalId
    ? await db.execute({
        sql: "SELECT * FROM reports WHERE user_id = ? AND goal_id = ? ORDER BY created_at DESC LIMIT ?",
        args: [userId, options.goalId, options.limit],
      })
    : await db.execute({
        sql: "SELECT * FROM reports WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
        args: [userId, options.limit],
      });
  return result.rows.map(toReport);
}

export async function listReportsWithEvents(
  userId: string,
  options: { goalId?: string; limit: number },
): Promise<ReportWithEvents[]> {
  const reports = await listReports(userId, options);
  if (!reports.length) return [];
  const db = await getDb();
  const events = await db.execute({
    sql: `SELECT * FROM events WHERE user_id = ? AND report_id IN (${placeholders(reports.length)}) AND cell_id IS NOT NULL ORDER BY created_at`,
    args: [userId, ...reports.map((r) => r.id)],
  });
  const byReport = new Map<string, ProgressEvent[]>();
  for (const row of events.rows) {
    const event = toEvent(row);
    const list = byReport.get(event.reportId!) ?? [];
    list.push(event);
    byReport.set(event.reportId!, list);
  }
  return reports.map((report) => ({ ...report, events: byReport.get(report.id) ?? [] }));
}

export async function listEvents(userId: string, options: { goalId?: string; limit: number }): Promise<ProgressEvent[]> {
  const db = await getDb();
  const result = options.goalId
    ? await db.execute({
        sql: "SELECT * FROM events WHERE user_id = ? AND goal_id = ? ORDER BY created_at DESC LIMIT ?",
        args: [userId, options.goalId, options.limit],
      })
    : await db.execute({
        sql: "SELECT * FROM events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
        args: [userId, options.limit],
      });
  return result.rows.map(toEvent);
}

/** Everything the user has, for "Download my data". */
export async function exportData(userId: string) {
  const db = await getDb();
  const [goals, cells, checkins, reports, events] = await db.batch(
    [
      { sql: "SELECT * FROM goals WHERE user_id = ? ORDER BY position, created_at", args: [userId] },
      { sql: `${USER_CELLS} WHERE g.user_id = ? ORDER BY c.goal_id, c.pillar, c.slot`, args: [userId] },
      { sql: "SELECT cell_id, goal_id, day FROM checkins WHERE user_id = ? ORDER BY day", args: [userId] },
      { sql: "SELECT * FROM reports WHERE user_id = ? ORDER BY created_at", args: [userId] },
      { sql: "SELECT * FROM events WHERE user_id = ? ORDER BY created_at", args: [userId] },
    ],
    "read",
  );
  const byGoal = groupCells(cells.rows);
  return {
    goals: goals.rows.map((row) => {
      const goal = toGoal(row);
      return { ...goal, cells: byGoal.get(goal.id) ?? [] };
    }),
    checkins: checkins.rows.map(toCheckin),
    reports: reports.rows.map(toReport),
    events: events.rows.map(toEvent),
  };
}

// ---------- goals ----------

/** Where a client-chosen id already exists: the same goal again (a retry), or someone else's. */
async function existingGoal(userId: string, id: string): Promise<GoalWithCells | null> {
  const db = await getDb();
  const found = await db.execute({ sql: "SELECT user_id FROM goals WHERE id = ?", args: [id] });
  if (!found.rows.length) return null;
  if (String(found.rows[0].user_id) !== userId) throw new HttpError(409, "Could not create the goal. Try again.");
  return getGoal(userId, id);
}

export async function createGoal(
  userId: string,
  input: { id?: string; title: string; why?: string; deadline?: string | null; pillars?: string[] },
): Promise<GoalWithCells> {
  const db = await getDb();
  const id = input.id ?? newId();
  // A retry after a lost response (same client id) gets the goal that was already made.
  if (input.id) {
    const existing = await existingGoal(userId, id);
    if (existing) return existing;
  }
  const time = now();
  const last = await db.execute({
    sql: "SELECT COALESCE(MIN(position), 0) AS p, COUNT(*) AS n FROM goals WHERE user_id = ?",
    args: [userId],
  });
  if (Number(last.rows[0].n) >= GOAL_LIMIT) throw goalLimit();
  const position = Number(last.rows[0].p) - 1; // newest goal goes to the top of the list

  const statements: InStatement[] = [
    {
      // The limit is checked again inside the write, so parallel requests cannot pass it. A taken
      // id still tries the insert, so a retry racing itself fails as a conflict (handled below).
      sql: `INSERT INTO goals (id, user_id, title, why, deadline, status, position, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, 'active', ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM goals WHERE id = ?)
          OR (EXISTS (SELECT 1 FROM users WHERE id = ?) AND (SELECT COUNT(*) FROM goals WHERE user_id = ?) < ?)`,
      args: [id, userId, input.title.trim(), input.why?.trim() ?? "", input.deadline ?? null, position, time, time, id, userId, userId, GOAL_LIMIT],
    },
  ];
  // Every goal always has all 72 squares, so the client never has to create rows.
  const guard = stillOwned(userId, id);
  for (let pillar = 0; pillar < 8; pillar++) {
    for (let slot = PILLAR_SLOT; slot < 8; slot++) {
      const text = slot === PILLAR_SLOT ? (input.pillars?.[pillar]?.trim() ?? "") : "";
      statements.push({
        sql: `INSERT INTO cells (id, goal_id, pillar, slot, text, updated_at) SELECT ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`,
        args: [newId(), id, pillar, slot, text, time, ...guard.args],
      });
    }
  }
  statements.push(eventStatement(userId, { goalId: id, cellId: null, reportId: null, type: "goal", detail: "Goal created" }));
  let inserted: ResultSet;
  try {
    [inserted] = await db.batch(statements, "write");
  } catch (error) {
    if (input.id && isConflict(error)) {
      const existing = await existingGoal(userId, id);
      if (existing) return existing;
    }
    throw error;
  }
  if (!inserted.rowsAffected) throw await refusal(userId, goalLimit());
  return getGoal(userId, id);
}

export async function updateGoal(userId: string, id: string, patch: GoalPatch): Promise<Goal> {
  const db = await getDb();
  const columns: Record<keyof GoalPatch, string> = {
    title: "title",
    why: "why",
    deadline: "deadline",
    status: "status",
    position: "position",
  };
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  for (const key of Object.keys(patch) as (keyof GoalPatch)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    sets.push(`${columns[key]} = ?`);
    args.push(typeof value === "string" ? value : (value ?? null));
  }
  const before = await getGoalOnly(userId, id);
  if (sets.length) {
    const statements: InStatement[] = [
      {
        sql: `UPDATE goals SET ${sets.join(", ")}, updated_at = ? WHERE id = ? AND user_id = ?`,
        args: [...args, now(), id, userId],
      },
    ];
    if (patch.status && patch.status !== before.status) {
      statements.push(
        eventStatement(userId, {
          goalId: id,
          cellId: null,
          reportId: null,
          type: "goal",
          detail: patch.status === "achieved" ? "Goal achieved" : `Goal ${patch.status}`,
        }),
      );
    }
    await db.batch(statements, "write");
  }
  return getGoalOnly(userId, id);
}

export async function deleteGoal(userId: string, id: string): Promise<void> {
  await getGoalOnly(userId, id); // 404 unless it is this user's goal
  const db = await getDb();
  await db.batch(
    [
      { sql: "DELETE FROM cells WHERE goal_id = ?", args: [id] },
      { sql: "DELETE FROM checkins WHERE goal_id = ? AND user_id = ?", args: [id, userId] },
      { sql: "DELETE FROM events WHERE goal_id = ? AND user_id = ?", args: [id, userId] },
      // Its reports go too, with what they logged on other goals.
      {
        sql: "DELETE FROM events WHERE user_id = ? AND report_id IN (SELECT id FROM reports WHERE goal_id = ? AND user_id = ?)",
        args: [userId, id, userId],
      },
      { sql: "DELETE FROM reports WHERE goal_id = ? AND user_id = ?", args: [id, userId] },
      { sql: "DELETE FROM goals WHERE id = ? AND user_id = ?", args: [id, userId] },
    ],
    "write",
  );
}

// ---------- cells ----------

function describeChange(before: Cell, patch: CellPatch): { type: EventType; detail: string } | null {
  const name = before.text || "Untitled";
  if (patch.status && patch.status !== before.status) {
    const label = { todo: "To do", doing: "In progress", done: "Done" }[patch.status];
    return { type: "status", detail: `${name}: ${label}` };
  }
  if (patch.progress !== undefined && patch.progress !== before.progress) {
    return { type: "progress", detail: `${name}: ${before.progress}% to ${patch.progress}%` };
  }
  if (patch.active !== undefined && patch.active !== before.active) {
    return { type: "status", detail: patch.active ? `${name}: started this week` : `${name}: paused` };
  }
  return null;
}

/** An UPDATE for a square already checked to belong to the user; with a guard, only while it holds. */
function cellUpdateStatement(before: Cell, patch: CellPatch, guard?: Guard): InStatement | null {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  const add = (column: string, value: string | number | null) => {
    sets.push(`${column} = ?`);
    args.push(value);
  };
  if (patch.text !== undefined) add("text", patch.text);
  if (patch.notes !== undefined) add("notes", patch.notes);
  if (patch.kind !== undefined) add("kind", patch.kind);
  if (patch.status !== undefined) {
    add("status", patch.status);
    if (patch.status !== before.status) add("done_at", patch.status === "done" ? (patch.doneAt ?? now()) : null);
  }
  if (patch.progress !== undefined) add("progress", patch.progress);
  if (patch.impact !== undefined) add("impact", patch.impact);
  if (patch.effort !== undefined) add("effort", patch.effort);
  if (patch.helps !== undefined) add("helps", JSON.stringify([...new Set(patch.helps)].sort()));
  if (patch.active !== undefined) {
    add("active", patch.active ? 1 : 0);
    if (patch.active && !before.active) add("activated_at", patch.activatedAt ?? now());
    if (!patch.active) add("activated_at", null);
  }
  if (!sets.length) return null;
  return {
    sql: `UPDATE cells SET ${sets.join(", ")}, updated_at = ? WHERE id = ?${guard ? ` AND ${guard.sql}` : ""}`,
    args: [...args, now(), before.id, ...(guard?.args ?? [])],
  };
}

export async function updateCell(userId: string, id: string, patch: CellPatch): Promise<Cell> {
  const db = await getDb();
  const before = await getCell(userId, id);
  const normalized = normalizePatch(before, patch);
  const update = cellUpdateStatement(before, normalized);
  if (!update) return before;
  const statements: InStatement[] = [update];
  const change = describeChange(before, normalized);
  if (change) statements.push(eventStatement(userId, { goalId: before.goalId, cellId: id, reportId: null, ...change }));
  await db.batch(statements, "write");
  return getCell(userId, id);
}

/** Several cell changes in one transaction (leverage ratings, weekly picks, accepted suggestions). */
export async function updateCells(userId: string, updates: { id: string; patch: CellPatch }[]): Promise<Cell[]> {
  if (!updates.length) return [];
  const db = await getDb();
  const ids = [...new Set(updates.map((u) => u.id))];
  const cells = await getCells(userId, ids);
  const statements: InStatement[] = [];
  for (const { id, patch } of updates) {
    const before = cells.get(id);
    // Deleted meanwhile, or not this user's: skip it so the rest still saves.
    if (!before) continue;
    const normalized = normalizePatch(before, patch);
    const statement = cellUpdateStatement(before, normalized);
    if (!statement) continue;
    statements.push(statement);
    cells.set(id, applyPatch(before, normalized, now()));
    const change = describeChange(before, normalized);
    if (change) statements.push(eventStatement(userId, { goalId: before.goalId, cellId: id, reportId: null, ...change }));
  }
  if (statements.length) await db.batch(statements, "write");
  return [...(await getCells(userId, ids)).values()];
}

export async function setCheckin(userId: string, cellId: string, day: string, done: boolean): Promise<void> {
  const db = await getDb();
  const cell = await getCell(userId, cellId);
  if (done) {
    // A retried request must not log the check-in twice.
    const exists = await db.execute({
      sql: "SELECT 1 FROM checkins WHERE cell_id = ? AND day = ?",
      args: [cellId, day],
    });
    if (exists.rows.length) return;
    const guard = stillOwned(userId, cell.goalId);
    await db.batch(
      [
        {
          sql: `INSERT INTO checkins (cell_id, goal_id, user_id, day) SELECT ?, ?, ?, ? WHERE ${guard.sql} ON CONFLICT DO NOTHING`,
          args: [cellId, cell.goalId, userId, day, ...guard.args],
        },
        // One event per habit and day, so checking it again after an undo logs nothing new.
        eventStatement(
          userId,
          { goalId: cell.goalId, cellId, reportId: null, type: "checkin", detail: `${cell.text || "Habit"}: checked ${day}` },
          `checkin:${cellId}:${day}`,
        ),
      ],
      "write",
    );
  } else {
    await db.execute({
      sql: "DELETE FROM checkins WHERE cell_id = ? AND day = ? AND user_id = ?",
      args: [cellId, day, userId],
    });
  }
}

// ---------- reports ----------

export async function saveReport(
  userId: string,
  input: {
    id?: string;
    goalId: string | null;
    source: ReportSource;
    transcript: string;
    summary: string;
    day: string;
    updates: ProposedUpdate[];
  },
): Promise<Report> {
  const db = await getDb();
  if (input.goalId) await getGoalOnly(userId, input.goalId); // 404 unless it is this user's goal
  const id = input.id ?? newId();
  // A retry after a lost response (same client id) must not apply the report twice.
  const existing = async () => {
    const found = await db.execute({ sql: "SELECT * FROM reports WHERE id = ?", args: [id] });
    if (!found.rows.length) return null;
    if (String(found.rows[0].user_id) !== userId) throw new HttpError(409, "Could not save the report. Try again.");
    return toReport(found.rows[0]);
  };
  if (input.id) {
    const saved = await existing();
    if (saved) return saved;
  }

  const time = now();
  const statements: InStatement[] = [
    {
      // Today's limit (UTC) is checked inside the write, so parallel saves cannot pass it. A taken
      // id still tries the insert, so a retry racing itself fails as a conflict (handled below)
      // instead of being applied twice.
      sql: `INSERT INTO reports (id, user_id, goal_id, source, transcript, summary, day, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM reports WHERE id = ?)
          OR (EXISTS (SELECT 1 FROM users WHERE id = ?)
            AND (SELECT COUNT(*) FROM reports WHERE user_id = ? AND created_at >= ?) < ?)`,
      args: [id, userId, input.goalId, input.source, input.transcript, input.summary, input.day, time, id, userId, userId, time.slice(0, 10), REPORTS_PER_DAY],
    },
  ];

  // Everything below is written only if the report was.
  const cells = await getCells(userId, [...new Set(input.updates.map((u) => u.cellId))]);
  const touchedGoals = new Set<string>();
  for (const update of input.updates) {
    const before = cells.get(update.cellId);
    if (!before) continue; // deleted after the report was analyzed, or not this user's
    touchedGoals.add(before.goalId);
    const guard = stillOwned(userId, before.goalId, id);
    const notes = update.note ? appendNote(before.notes, input.day, update.note) : null;
    const patch = normalizePatch(before, {
      status: update.status && update.status !== before.status ? update.status : undefined,
      notes: notes ?? undefined,
    });
    const statement = cellUpdateStatement(before, patch, guard);
    if (statement) statements.push(statement);
    // Two updates for one square build on each other.
    cells.set(before.id, applyPatch(before, patch, time));
    if (update.checkin && before.kind === "habit") {
      statements.push({
        sql: `INSERT INTO checkins (cell_id, goal_id, user_id, day) SELECT ?, ?, ?, ? WHERE ${guard.sql} ON CONFLICT DO NOTHING`,
        args: [before.id, before.goalId, userId, input.day, ...guard.args],
      });
    }
    const change = describeChange(before, patch);
    statements.push(
      eventStatement(userId, {
        goalId: before.goalId,
        cellId: before.id,
        reportId: id,
        type: change?.type ?? (update.checkin ? "checkin" : "note"),
        detail:
          change?.detail ??
          `${before.text || "Untitled"}: ${update.checkin ? `checked ${input.day}` : (update.note ?? update.quote)}`,
      }),
    );
  }

  const reportGoals = input.goalId ? new Set([input.goalId, ...touchedGoals]) : touchedGoals;
  for (const goalId of reportGoals) {
    statements.push(
      eventStatement(userId, { goalId, cellId: null, reportId: id, type: "report", detail: input.summary || "Report" }),
    );
  }

  let inserted: ResultSet;
  try {
    [inserted] = await db.batch(statements, "write");
  } catch (error) {
    if (input.id && isConflict(error)) {
      const saved = await existing();
      if (saved) return saved;
    }
    throw error;
  }
  if (!inserted.rowsAffected) throw await refusal(userId, reportLimit());
  return {
    id,
    goalId: input.goalId,
    source: input.source,
    transcript: input.transcript,
    summary: input.summary,
    day: input.day,
    createdAt: time,
  };
}

/**
 * Adds a dated report line to a square's notes. Stays within NOTES_MAX by dropping the oldest
 * report lines first, never the user's own lines; if it still does not fit, the line is skipped
 * (it stays in the report's history either way).
 */
function appendNote(notes: string, day: string, note: string): string | null {
  const lines = notes.trim() ? notes.trim().split("\n") : [];
  lines.push(`${day}: ${note.trim()}`);
  const dated = /^\d{4}-\d{2}-\d{2}: /;
  let total = lines.join("\n").length;
  for (let i = 0; total > NOTES_MAX && i < lines.length - 1; ) {
    if (dated.test(lines[i])) {
      total -= lines[i].length + 1;
      lines.splice(i, 1);
    } else {
      i++;
    }
  }
  return total <= NOTES_MAX ? lines.join("\n") : null;
}

/** The report and everything it logged (its summary and notes in events). Its changes to the chart stay. */
export async function deleteReport(userId: string, id: string): Promise<void> {
  const db = await getDb();
  await db.batch(
    [
      { sql: "DELETE FROM events WHERE report_id = ? AND user_id = ?", args: [id, userId] },
      { sql: "DELETE FROM reports WHERE id = ? AND user_id = ?", args: [id, userId] },
    ],
    "write",
  );
}
