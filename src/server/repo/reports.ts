import "server-only";
import type { InStatement, ResultSet } from "@libsql/client";
import { getDb } from "@/server/db";
import { HttpError } from "@/domain/errors";
import { applyPatch, normalizePatch, NOTES_MAX } from "@/domain/mandala";
import type { ProgressEvent, ProposedUpdate, Report, ReportSource, ReportWithEvents } from "@/domain/types";
import { eventStatement, isConflict, newId, now, placeholders, refusal, stillOwned, toEvent, toReport } from "./shared";
import { getGoalOnly } from "./goals";
import { cellUpdateStatement, describeChange, getCells } from "./cells";

// Reports (voice or text) with the chart changes they made, and the change log (events).

/** Saved reports per account per day (UTC). */
const REPORTS_PER_DAY = 30;

const reportLimit = () => new HttpError(422, "That's today's limit for saved reports. It resets tomorrow.");

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
