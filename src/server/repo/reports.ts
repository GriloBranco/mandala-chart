import "server-only";
import type { InStatement, ResultSet } from "@libsql/client";
import { getDb } from "@/server/db";
import { HttpError } from "@/domain/errors";
import type { ProgressEvent, Report } from "@/domain/types";
import { eventStatement, isConflict, newId, now, refusal, toEvent, toReport } from "./shared";
import { getGoalOnly } from "./goals";

// Written reports, and the change log (events).

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
    text: string;
    summary: string;
    day: string;
  },
): Promise<Report> {
  const db = await getDb();
  if (input.goalId) await getGoalOnly(userId, input.goalId); // 404 unless it is this user's goal
  const id = input.id ?? newId();
  // A retry after a lost response (same client id) must not save the report twice.
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
      // instead of being saved twice. The schema's source column is always 'text', and the
      // report's text goes in its transcript column.
      sql: `INSERT INTO reports (id, user_id, goal_id, source, transcript, summary, day, created_at)
        SELECT ?, ?, ?, 'text', ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM reports WHERE id = ?)
          OR (EXISTS (SELECT 1 FROM users WHERE id = ?)
            AND (SELECT COUNT(*) FROM reports WHERE user_id = ? AND created_at >= ?) < ?)`,
      args: [id, userId, input.goalId, input.text, input.summary, input.day, time, id, userId, userId, time.slice(0, 10), REPORTS_PER_DAY],
    },
  ];

  // Written only if the report was.
  if (input.goalId) {
    statements.push(
      eventStatement(userId, { goalId: input.goalId, cellId: null, reportId: id, type: "report", detail: input.summary || "Report" }),
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
    text: input.text,
    summary: input.summary,
    day: input.day,
    createdAt: time,
  };
}

/** The report and what it logged (its summary in events). */
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
