import "server-only";
import type { InStatement, InValue, Row } from "@libsql/client";
import { getDb } from "@/server/db";
import { HttpError } from "@/domain/errors";
import type { Cell, Checkin, EventType, Goal, ProgressEvent, Report } from "@/domain/types";

// Helpers shared by the repo modules: row mapping, ownership guards and event logging.
// Not exported from the repo's index: route handlers use the functions in the other files.

export const now = () => new Date().toISOString();

export const newId = () => crypto.randomUUID();

/** Why a guarded insert wrote nothing: the account was deleted meanwhile, or it is at a limit. */
export async function refusal(userId: string, limit: HttpError): Promise<HttpError> {
  const db = await getDb();
  const user = await db.execute({ sql: "SELECT 1 FROM users WHERE id = ?", args: [userId] });
  return user.rows.length ? limit : new HttpError(401, "Not signed in");
}

export interface Guard {
  sql: string;
  args: InValue[];
}

/** Holds while the goal (and the report, when given) still belong to the user. */
export function stillOwned(userId: string, goalId: string, reportId: string | null = null): Guard {
  const goal = "EXISTS (SELECT 1 FROM goals WHERE id = ? AND user_id = ?)";
  if (!reportId) return { sql: goal, args: [goalId, userId] };
  return {
    sql: `${goal} AND EXISTS (SELECT 1 FROM reports WHERE id = ? AND user_id = ?)`,
    args: [goalId, userId, reportId, userId],
  };
}

/** A write lost a race on a primary key (the same client id saved twice at once). */
export function isConflict(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return /SQLITE_CONSTRAINT|UNIQUE constraint/i.test(`${String(code ?? "")} ${String(message ?? "")}`);
}

/** Squares of one user (through their goal). Append the WHERE with g.user_id = ?. */
export const USER_CELLS = "SELECT c.* FROM cells c JOIN goals g ON g.id = c.goal_id";

export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export function toGoal(row: Row): Goal {
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

export function toCell(row: Row): Cell {
  return {
    id: String(row.id),
    goalId: String(row.goal_id),
    pillar: Number(row.pillar),
    slot: Number(row.slot),
    text: String(row.text),
    notes: String(row.notes),
    kind: String(row.kind) as Cell["kind"],
    repeat: row.repeat === "week" || row.repeat === "month" ? row.repeat : "day",
    repeatOn: row.repeat_on == null ? null : Number(row.repeat_on),
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

export function toReport(row: Row): Report {
  return {
    id: String(row.id),
    goalId: row.goal_id == null ? null : String(row.goal_id),
    text: String(row.transcript),
    summary: String(row.summary),
    day: String(row.day),
    createdAt: String(row.created_at),
  };
}

export function toEvent(row: Row): ProgressEvent {
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

export function toCheckin(row: Row): Checkin {
  return { cellId: String(row.cell_id), goalId: String(row.goal_id), day: String(row.day) };
}

/** Logs a change, only while its goal (and report) still belong to the user. A repeated fixed id logs nothing. */
export function eventStatement(userId: string, event: Omit<ProgressEvent, "id" | "createdAt">, id = newId()): InStatement {
  const guard = stillOwned(userId, event.goalId, event.reportId);
  return {
    sql: `INSERT INTO events (id, user_id, goal_id, cell_id, report_id, type, detail, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql} ON CONFLICT (id) DO NOTHING`,
    args: [id, userId, event.goalId, event.cellId, event.reportId, event.type, event.detail, now(), ...guard.args],
  };
}

export function groupCells(rows: Row[]): Map<string, Cell[]> {
  const byGoal = new Map<string, Cell[]>();
  for (const row of rows) {
    const cell = toCell(row);
    const list = byGoal.get(cell.goalId) ?? [];
    list.push(cell);
    byGoal.set(cell.goalId, list);
  }
  return byGoal;
}
