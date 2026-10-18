import "server-only";
import type { InStatement } from "@libsql/client";
import { getDb } from "../db";
import { HttpError } from "@/domain/errors";
import { applyPatch, normalizePatch } from "@/domain/mandala";
import type { Cell, CellPatch, EventType } from "@/domain/types";
import { eventStatement, type Guard, now, placeholders, stillOwned, toCell, USER_CELLS } from "./shared";

// Squares: edits one at a time or in a batch, and daily check-ins of habits.

export async function getCell(userId: string, id: string): Promise<Cell> {
  const db = await getDb();
  const result = await db.execute({ sql: `${USER_CELLS} WHERE c.id = ? AND g.user_id = ?`, args: [id, userId] });
  if (!result.rows.length) throw new HttpError(404, "Cell not found");
  return toCell(result.rows[0]);
}

export async function getCells(userId: string, ids: string[]): Promise<Map<string, Cell>> {
  if (!ids.length) return new Map();
  const db = await getDb();
  const result = await db.execute({
    sql: `${USER_CELLS} WHERE c.id IN (${placeholders(ids.length)}) AND g.user_id = ?`,
    args: [...ids, userId],
  });
  return new Map(result.rows.map((row) => [String(row.id), toCell(row)]));
}

export function describeChange(before: Cell, patch: CellPatch): { type: EventType; detail: string } | null {
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
export function cellUpdateStatement(before: Cell, patch: CellPatch, guard?: Guard): InStatement | null {
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
