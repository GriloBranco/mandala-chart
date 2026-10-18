import { describe, expect, it } from "vitest";
import { backupSchema } from "@/domain/backup";
import { HttpError } from "@/domain/errors";
import { createGoal, exportData, importData, saveReport, setCheckin, updateCell } from "@/server/repo";
import { getUser } from "@/server/users";
import { newAccount } from "../support/accounts";

const DAY = "2026-03-01";

async function filledAccount() {
  const user = await newAccount("source");
  const goal = await createGoal(user.id, { title: "Read 20 books", why: "Think better", deadline: "2027-06-30", pillars: ["Habit", "List"] });
  const habit = goal.cells.find((c) => c.pillar === 0 && c.slot === 0)!;
  const task = goal.cells.find((c) => c.pillar === 1 && c.slot === 2)!;
  await updateCell(user.id, habit.id, { text: "Read 10 pages", kind: "habit", active: true, impact: 3, effort: 1, helps: [1] });
  await updateCell(user.id, task.id, { text: "Pick the next 5 books", status: "done", notes: "Asked friends" });
  await setCheckin(user.id, habit.id, DAY, true);
  await saveReport(user.id, {
    goalId: goal.id,
    source: "text",
    transcript: "Read 12 pages",
    summary: "Read",
    day: DAY,
    updates: [{ cellId: habit.id, checkin: true, note: "12 pages", quote: "", confidence: 1 }],
  });
  await createGoal(user.id, { title: "Run a half marathon" });
  return user;
}

/** A copy of `value` without the given keys. */
function without<T extends object>(value: T, ...keys: string[]): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))) as Partial<T>;
}

/** What a backup holds, without ids, so two accounts can be compared. */
function content(data: Awaited<ReturnType<typeof exportData>>) {
  const cellText = new Map(data.goals.flatMap((g) => g.cells.map((c) => [c.id, c.text])));
  return {
    goals: data.goals.map((goal) => ({
      ...without(goal, "id", "cells"),
      cells: goal.cells.map((cell) => without(cell, "id", "goalId")),
    })),
    checkins: data.checkins.map((c) => ({ text: cellText.get(c.cellId), day: c.day })),
    reports: data.reports.map((report) => ({ ...without(report, "id", "goalId"), hasGoal: report.goalId !== null })),
    events: data.events.map((e) => ({ type: e.type, detail: e.detail, createdAt: e.createdAt, text: e.cellId ? cellText.get(e.cellId) : null })),
  };
}

describe("backups", () => {
  it("move everything into a new account, with new ids", async () => {
    const source = await filledAccount();
    const file = JSON.parse(JSON.stringify(await exportData(source.id)));
    const target = await newAccount("target");
    const result = await importData(target.id, backupSchema.parse({ ...file, account: { headline: "My own line" } }));
    expect(result).toEqual({ goals: 2, reports: 1 });
    const before = await exportData(source.id);
    const after = await exportData(target.id);
    expect(content(after)).toEqual(content(before));
    expect(after.goals.map((g) => g.id)).not.toContain(before.goals[0].id);
    expect((await getUser(target.id))?.headline).toBe("My own line");
    // The check-in event keeps its one-per-day id, on the new square.
    const habit = after.goals.flatMap((g) => g.cells).find((c) => c.text === "Read 10 pages")!;
    expect(after.events.map((e) => e.id)).toContain(`checkin:${habit.id}:${DAY}`);
  });

  it("only go into an empty account", async () => {
    const source = await filledAccount();
    const file = backupSchema.parse(JSON.parse(JSON.stringify(await exportData(source.id))));
    const target = await newAccount("target");
    await importData(target.id, file);
    await expect(importData(target.id, file)).rejects.toMatchObject({ status: 409 });
    await expect(importData(source.id, file)).rejects.toBeInstanceOf(HttpError);
  });

  it("fill in missing squares and drop links to things not in the file", async () => {
    const target = await newAccount("target");
    const file = backupSchema.parse({
      goals: [
        {
          id: "g1",
          title: "Learn Spanish",
          why: "",
          deadline: null,
          status: "active",
          position: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          cells: [
            {
              id: "p0",
              pillar: 0,
              slot: -1,
              text: "Speaking",
              notes: "",
              kind: "task",
              status: "todo",
              progress: 0,
              impact: null,
              effort: null,
              helps: [],
              active: false,
              activatedAt: null,
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      ],
      checkins: [{ cellId: "missing", goalId: "g1", day: DAY }],
      reports: [{ id: "r1", goalId: "gone", source: "text", transcript: "Hola", summary: "", day: DAY, createdAt: "2026-01-02T00:00:00.000Z" }],
      events: [{ id: "e1", goalId: "gone", cellId: null, reportId: null, type: "goal", detail: "Goal created", createdAt: "2026-01-01T00:00:00.000Z" }],
    });
    await importData(target.id, file);
    const data = await exportData(target.id);
    expect(data.goals[0].cells).toHaveLength(72);
    expect(data.goals[0].cells.find((c) => c.slot === -1 && c.pillar === 0)?.text).toBe("Speaking");
    expect(data.checkins).toEqual([]);
    expect(data.reports[0].goalId).toBeNull();
    expect(data.events).toEqual([]);
  });

  it("refuse a file that is not a backup", () => {
    expect(backupSchema.safeParse({ hello: "world" }).success).toBe(false);
    expect(backupSchema.safeParse({ goals: [{ id: "g", title: 3 }] }).success).toBe(false);
  });
});
