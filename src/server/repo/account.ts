import "server-only";
import { getDb } from "@/server/db";
import { groupCells, toCheckin, toEvent, toGoal, toReport, USER_CELLS } from "./shared";

// Everything in one account at once: the "Download my data" file.

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
