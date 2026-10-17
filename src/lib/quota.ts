import "server-only";
import { getDb } from "./db";
import { HttpError } from "./errors";

// A daily AI allowance per person, plus a total for everyone, so a public deployment cannot
// run up the Gemini bill. Days are UTC. Each call is counted before it runs, in one atomic
// batch, so parallel requests cannot slip past the limit. Only calls that are allowed count
// toward the total, so one person going over their own limit cannot use it up for everyone.

/** A whole number from the environment. 0 turns that AI off; empty or invalid keeps the default. */
function limit(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

const LIMITS = {
  /** Suggestions, Sharpen and Leverage. */
  ai: limit("AI_DAILY_LIMIT", 60),
  /** Voice and typed report analysis (audio costs more). */
  report: limit("REPORT_DAILY_LIMIT", 15),
};
const IN_TOTAL = limit("AI_GLOBAL_DAILY_LIMIT", 1500);

export type QuotaKind = keyof typeof LIMITS;

/** False when AI_GLOBAL_DAILY_LIMIT is 0: AI is off for everyone, and the app hides it. */
export function aiAllowed(): boolean {
  return IN_TOTAL > 0;
}

const OFF: Record<QuotaKind, string> = {
  ai: "AI is off for now.",
  report: "Report analysis is off for now. You can still type and save reports.",
};

// The person's own count goes up on every call, refused ones too. Only while the account
// exists, so a call racing an account deletion leaves no row behind.
const MINE = `INSERT INTO ai_usage (user_id, day, kind, count)
  SELECT ?, ?, ?, 1 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)
  ON CONFLICT (user_id, day, kind) DO UPDATE SET count = count + 1
  RETURNING count`;

// The total goes up only for a call within the person's limit, and never past the total limit.
// No row back means the total is used up.
const TOTAL = `INSERT INTO ai_usage (user_id, day, kind, count)
  SELECT '*', ?, 'all', 1
  WHERE (SELECT count FROM ai_usage WHERE user_id = ? AND day = ? AND kind = ?) <= ?
  ON CONFLICT (user_id, day, kind) DO UPDATE SET count = count + 1 WHERE count < ?
  RETURNING count`;

export async function useQuota(userId: string, kind: QuotaKind): Promise<void> {
  if (!LIMITS[kind] || !IN_TOTAL) throw new HttpError(503, OFF[kind]);
  const db = await getDb();
  const day = new Date().toISOString().slice(0, 10);
  const [mine, all] = await db.batch(
    [
      { sql: MINE, args: [userId, day, kind, userId] },
      { sql: TOTAL, args: [day, userId, day, kind, LIMITS[kind], IN_TOTAL] },
    ],
    "write",
  );
  if (!mine.rows.length) throw new HttpError(401, "Not signed in"); // the account was just deleted
  if (Number(mine.rows[0].count) > LIMITS[kind]) {
    throw new HttpError(
      429,
      kind === "report"
        ? "That's today's limit for report analysis. You can still type and save reports. It resets tomorrow."
        : "That's today's AI limit. It resets tomorrow.",
    );
  }
  if (!all.rows.length) {
    throw new HttpError(429, "AI is resting for today. Try again tomorrow.");
  }
}
