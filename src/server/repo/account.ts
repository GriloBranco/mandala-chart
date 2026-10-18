import "server-only";
import type { InStatement, InValue } from "@libsql/client";
import { getDb } from "@/server/db";
import type { Backup } from "@/domain/backup";
import { HttpError } from "@/domain/errors";
import { PILLAR_SLOT } from "@/domain/mandala";
import { groupCells, newId, toCheckin, toEvent, toGoal, toReport, USER_CELLS } from "./shared";

// Everything in one account at once: the "Download my data" file, and importing one.

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

/** Most values in one INSERT, well under SQLite's limit on bound parameters. */
const MAX_VALUES = 500;

/** Multi-row INSERTs for many rows, so a large import is a handful of statements. */
function insertRows(table: string, columns: string[], rows: InValue[][]): InStatement[] {
  const perStatement = Math.max(1, Math.floor(MAX_VALUES / columns.length));
  const row = `(${columns.map(() => "?").join(", ")})`;
  const statements: InStatement[] = [];
  for (let i = 0; i < rows.length; i += perStatement) {
    const chunk = rows.slice(i, i + perStatement);
    statements.push({
      sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${chunk.map(() => row).join(", ")}`,
      args: chunk.flat(),
    });
  }
  return statements;
}

function duplicates(ids: string[]): boolean {
  return new Set(ids).size !== ids.length;
}

/**
 * Loads a backup into an account that has nothing in it yet. Every goal, square, report and event
 * gets a new id, so the same file can go into several accounts. Goals keep all 72 squares
 * (missing ones are added empty). Check-ins, reports and events that point at something not in
 * the file are dropped or detached, as the app does when that thing is deleted.
 */
export async function importData(userId: string, backup: Backup): Promise<{ goals: number; reports: number }> {
  const cells = backup.goals.flatMap((g) => g.cells);
  if (
    duplicates(backup.goals.map((g) => g.id)) ||
    duplicates(cells.map((c) => c.id)) ||
    duplicates(backup.reports.map((r) => r.id)) ||
    backup.goals.some((g) => duplicates(g.cells.map((c) => `${c.pillar}:${c.slot}`)))
  ) {
    throw new HttpError(400, "This file has the same goal, square or report twice. Download it again.");
  }

  const goalIds = new Map(backup.goals.map((g) => [g.id, newId()]));
  const cellIds = new Map<string, { id: string; goalId: string }>();
  const reportIds = new Map(backup.reports.map((r) => [r.id, newId()]));
  const goalRows: InValue[][] = [];
  const cellRows: InValue[][] = [];
  for (const goal of backup.goals) {
    const goalId = goalIds.get(goal.id)!;
    goalRows.push([goalId, userId, goal.title, goal.why, goal.deadline, goal.status, goal.position, goal.createdAt, goal.updatedAt]);
    const bySlot = new Map(goal.cells.map((c) => [`${c.pillar}:${c.slot}`, c]));
    for (let pillar = 0; pillar < 8; pillar++) {
      for (let slot = PILLAR_SLOT; slot < 8; slot++) {
        const cell = bySlot.get(`${pillar}:${slot}`);
        const id = newId();
        if (cell) cellIds.set(cell.id, { id, goalId });
        cellRows.push(
          cell
            ? [id, goalId, pillar, slot, cell.text, cell.notes, cell.kind, cell.status, cell.progress, cell.impact, cell.effort,
               JSON.stringify([...new Set(cell.helps)].sort()), cell.active ? 1 : 0, cell.activatedAt, cell.doneAt, cell.updatedAt]
            : [id, goalId, pillar, slot, "", "", "task", "todo", 0, null, null, "[]", 0, null, null, goal.updatedAt],
        );
      }
    }
  }

  const checkinRows: InValue[][] = [];
  const checked = new Set<string>();
  for (const checkin of backup.checkins) {
    const cell = cellIds.get(checkin.cellId);
    const key = `${cell?.id}:${checkin.day}`;
    if (!cell || checked.has(key)) continue;
    checked.add(key);
    checkinRows.push([cell.id, cell.goalId, userId, checkin.day]);
  }

  const reportRows = backup.reports.map((r) => [
    reportIds.get(r.id)!, userId, r.goalId ? (goalIds.get(r.goalId) ?? null) : null, r.source, r.transcript, r.summary, r.day, r.createdAt,
  ]);

  const eventRows: InValue[][] = [];
  const eventIds = new Set<string>();
  for (const event of backup.events) {
    const goalId = goalIds.get(event.goalId);
    if (!goalId) continue;
    const cell = event.cellId ? cellIds.get(event.cellId) : undefined;
    // One check-in event per habit and day keeps its fixed id, so checking it again logs nothing new.
    const checkin = /^checkin:.+:(\d{4}-\d{2}-\d{2})$/.exec(event.id);
    const id = checkin && cell ? `checkin:${cell.id}:${checkin[1]}` : newId();
    if (eventIds.has(id)) continue;
    eventIds.add(id);
    const reportId = event.reportId ? (reportIds.get(event.reportId) ?? null) : null;
    eventRows.push([id, userId, goalId, cell?.id ?? null, reportId, event.type, event.detail, event.createdAt]);
  }

  const headline = backup.account?.headline?.trim() ?? "";
  const statements = [
    ...insertRows("goals", ["id", "user_id", "title", "why", "deadline", "status", "position", "created_at", "updated_at"], goalRows),
    ...insertRows(
      "cells",
      ["id", "goal_id", "pillar", "slot", "text", "notes", "kind", "status", "progress", "impact", "effort", "helps", "active", "activated_at", "done_at", "updated_at"],
      cellRows,
    ),
    ...insertRows("checkins", ["cell_id", "goal_id", "user_id", "day"], checkinRows),
    ...insertRows("reports", ["id", "user_id", "goal_id", "source", "transcript", "summary", "day", "created_at"], reportRows),
    ...insertRows("events", ["id", "user_id", "goal_id", "cell_id", "report_id", "type", "detail", "created_at"], eventRows),
    ...(headline ? [{ sql: "UPDATE users SET headline = ? WHERE id = ?", args: [headline, userId] }] : []),
  ];

  // One transaction that first checks the account is still there and still empty, so two
  // imports at once (a double tap) cannot both land.
  const db = await getDb();
  const tx = await db.transaction("write");
  try {
    const found = await tx.execute({
      sql: `SELECT
        (SELECT COUNT(*) FROM users WHERE id = ?) AS account,
        (SELECT COUNT(*) FROM goals WHERE user_id = ?) + (SELECT COUNT(*) FROM reports WHERE user_id = ?)
          + (SELECT COUNT(*) FROM events WHERE user_id = ?) + (SELECT COUNT(*) FROM checkins WHERE user_id = ?) AS rows`,
      args: [userId, userId, userId, userId, userId],
    });
    if (!Number(found.rows[0].account)) throw new HttpError(401, "Not signed in");
    if (Number(found.rows[0].rows)) {
      throw new HttpError(409, "Import works only into an empty account. Create a new account for this backup, or delete what is here first.");
    }
    if (statements.length) await tx.batch(statements);
    await tx.commit();
  } finally {
    tx.close();
  }
  return { goals: goalRows.length, reports: reportRows.length };
}
