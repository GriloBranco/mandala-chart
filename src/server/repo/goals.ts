import "server-only";
import type { InStatement, ResultSet } from "@libsql/client";
import { getDb } from "@/server/db";
import { HttpError } from "@/domain/errors";
import { PILLAR_SLOT } from "@/domain/mandala";
import type { AppState, Goal, GoalPatch, GoalWithCells } from "@/domain/types";
import { eventStatement, groupCells, isConflict, newId, now, refusal, stillOwned, toCell, toCheckin, toGoal, USER_CELLS } from "./shared";
import { goalOutboxStatement } from "./todoist";

// Goals and their 72 squares: reading the whole chart, creating, editing and deleting goals.

/** Goals per account, archived ones included, so one account cannot fill the database. */
const GOAL_LIMIT = 50;

const goalLimit = () =>
  new HttpError(422, `You've reached the limit of ${GOAL_LIMIT} goals. Delete one to add another.`);

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

export async function getGoalOnly(userId: string, id: string): Promise<Goal> {
  const db = await getDb();
  const result = await db.execute({ sql: "SELECT * FROM goals WHERE id = ? AND user_id = ?", args: [id, userId] });
  if (!result.rows.length) throw new HttpError(404, "Goal not found");
  return toGoal(result.rows[0]);
}

export async function listActiveGoals(userId: string): Promise<GoalWithCells[]> {
  const state = await loadState(userId, "9999-12-31");
  return state.goals.filter((goal) => goal.status === "active");
}

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
    // Todoist names a section after the goal, and holds its tasks only while it is active.
    if (patch.title !== undefined || patch.status !== undefined) statements.push(goalOutboxStatement(userId, id));
    await db.batch(statements, "write");
  }
  return getGoalOnly(userId, id);
}

export async function deleteGoal(userId: string, id: string): Promise<void> {
  await getGoalOnly(userId, id); // 404 unless it is this user's goal
  const db = await getDb();
  await db.batch(
    [
      // First, while the goal still exists: its tasks in Todoist go too.
      goalOutboxStatement(userId, id),
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
