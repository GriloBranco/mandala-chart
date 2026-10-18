import { beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "@/domain/errors";
import {
  createGoal,
  deleteGoal,
  deleteReport,
  exportData,
  getCell,
  getGoal,
  listEvents,
  listReports,
  loadState,
  saveReport,
  setCheckin,
  updateCell,
  updateCells,
  updateGoal,
} from "@/server/repo";
import { deleteUser, type User } from "@/server/users";
import { newAccount } from "../support/accounts";

const DAY = "2026-03-01";

async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof HttpError) return error.status;
    throw error;
  }
}

describe("a new goal", () => {
  it("has all 72 squares, with the pillars named", async () => {
    const user = await newAccount();
    const goal = await createGoal(user.id, { title: "Run a marathon", pillars: ["Base", "Speed"] });
    expect(goal.cells).toHaveLength(72);
    expect(goal.cells.find((c) => c.pillar === 1 && c.slot === -1)?.text).toBe("Speed");
  });

  it("is created once when the same client id is sent twice", async () => {
    const user = await newAccount();
    const id = crypto.randomUUID();
    await createGoal(user.id, { id, title: "Once" });
    await createGoal(user.id, { id, title: "Once" });
    expect((await loadState(user.id, DAY)).goals).toHaveLength(1);
  });
});

describe("two accounts never see or change each other's data", () => {
  let alex: User;
  let bea: User;
  let goalId: string;
  let cellId: string;
  let reportId: string;

  beforeAll(async () => {
    alex = await newAccount("alex");
    bea = await newAccount("bea");
    const goal = await createGoal(alex.id, { title: "Read 20 books", pillars: ["Habit"] });
    goalId = goal.id;
    cellId = goal.cells.find((c) => c.pillar === 0 && c.slot === 0)!.id;
    await updateCell(alex.id, cellId, { text: "Read 10 pages", kind: "habit", active: true });
    await setCheckin(alex.id, cellId, DAY, true);
    reportId = (
      await saveReport(alex.id, { goalId, source: "text", transcript: "Read today", summary: "", day: DAY, updates: [] })
    ).id;
  });

  it("shows nothing of the other account", async () => {
    const state = await loadState(bea.id, "2000-01-01");
    expect(state.goals).toEqual([]);
    expect(state.checkins).toEqual([]);
    expect(await listReports(bea.id, { limit: 50 })).toEqual([]);
    expect(await listEvents(bea.id, { limit: 50 })).toEqual([]);
    const data = await exportData(bea.id);
    expect([data.goals, data.reports, data.events, data.checkins].flat()).toEqual([]);
  });

  it("answers 404 for the other account's goal and squares", async () => {
    expect(await status(getGoal(bea.id, goalId))).toBe(404);
    expect(await status(updateGoal(bea.id, goalId, { title: "Mine now" }))).toBe(404);
    expect(await status(deleteGoal(bea.id, goalId))).toBe(404);
    expect(await status(getCell(bea.id, cellId))).toBe(404);
    expect(await status(updateCell(bea.id, cellId, { text: "Changed" }))).toBe(404);
    expect(await status(setCheckin(bea.id, cellId, "2026-03-02", true))).toBe(404);
    expect(await status(saveReport(bea.id, { goalId, source: "text", transcript: "x", summary: "", day: DAY, updates: [] }))).toBe(404);
  });

  it("skips the other account's squares in batch and report updates", async () => {
    expect(await updateCells(bea.id, [{ id: cellId, patch: { text: "Changed" } }])).toEqual([]);
    await saveReport(bea.id, {
      goalId: null,
      source: "text",
      transcript: "Done with it",
      summary: "",
      day: DAY,
      updates: [{ cellId, status: "done", note: "Not yours", quote: "", confidence: 1 }],
    });
    const cell = await getCell(alex.id, cellId);
    expect(cell.text).toBe("Read 10 pages");
    expect(cell.notes).toBe("");
  });

  it("refuses a client id that belongs to the other account", async () => {
    expect(await status(createGoal(bea.id, { id: goalId, title: "Copy" }))).toBe(409);
    expect(
      await status(saveReport(bea.id, { id: reportId, goalId: null, source: "text", transcript: "x", summary: "", day: DAY, updates: [] })),
    ).toBe(409);
  });

  it("cannot delete the other account's report", async () => {
    await deleteReport(bea.id, reportId);
    expect((await listReports(alex.id, { limit: 50 })).map((r) => r.id)).toContain(reportId);
  });

  it("leaves the owner's data as it was", async () => {
    const goal = await getGoal(alex.id, goalId);
    expect(goal.title).toBe("Read 20 books");
    expect((await loadState(alex.id, "2000-01-01")).checkins).toHaveLength(1);
  });
});

describe("limits", () => {
  it("stops at 50 goals", async () => {
    const user = await newAccount();
    for (let i = 0; i < 50; i++) await createGoal(user.id, { title: `Goal ${i}` });
    expect(await status(createGoal(user.id, { title: "One more" }))).toBe(422);
  });
});

describe("squares", () => {
  it("records when a task was finished and logs a check-in once", async () => {
    const user = await newAccount();
    const goal = await createGoal(user.id, { title: "Ship it" });
    const square = goal.cells.find((c) => c.slot === 0)!;
    const done = await updateCell(user.id, square.id, { text: "Write the post", status: "done" });
    expect(done.progress).toBe(100);
    expect(done.doneAt).not.toBeNull();
    await setCheckin(user.id, square.id, DAY, true);
    await setCheckin(user.id, square.id, DAY, true);
    const checkins = (await listEvents(user.id, { limit: 50 })).filter((e) => e.type === "checkin");
    expect(checkins).toHaveLength(1);
  });
});

describe("deleting an account", () => {
  it("removes everything in it", async () => {
    const user = await newAccount();
    const goal = await createGoal(user.id, { title: "Gone soon" });
    await saveReport(user.id, { goalId: goal.id, source: "text", transcript: "x", summary: "", day: DAY, updates: [] });
    await deleteUser(user.id);
    const data = await exportData(user.id);
    expect([data.goals, data.reports, data.events, data.checkins].flat()).toEqual([]);
  });
});
