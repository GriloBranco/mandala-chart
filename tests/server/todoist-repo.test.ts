import { beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "@/domain/errors";
import { getDb } from "@/server/db";
import {
  cellOutboxStatement,
  checkinOutboxStatement,
  claimTodoistLease,
  createGoal,
  deleteGoal,
  deleteTodoistData,
  deleteTodoistLink,
  deleteTodoistSection,
  dueTodoistOutbox,
  findTodoistOwner,
  finishTodoistOutbox,
  getGoal,
  getTodoistAccount,
  goalOutboxStatement,
  listTodoistLinks,
  listTodoistSections,
  loadState,
  nextTodoistOutbox,
  queueTodoist,
  recordTodoistDelivery,
  releaseTodoistLease,
  releaseTodoistOutbox,
  retryTodoistOutbox,
  saveTodoistAccount,
  saveTodoistLink,
  saveTodoistSection,
  setCheckin,
  sweepTodoistDeliveries,
  todoistDeliverySeen,
  todoistLinkForTask,
  todoistUserIds,
  updateCell,
  updateCells,
  updateGoal,
  updateTodoistAccount,
  type TodoistAccountRow,
  type TodoistLink,
} from "@/server/repo";
import { deleteUser, getUser, type User } from "@/server/users";
import { newAccount } from "../support/accounts";

const DAY = "2026-03-01";
const TABLES = ["todoist_accounts", "todoist_links", "todoist_sections", "todoist_outbox"];

async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof HttpError) return error.status;
    throw error;
  }
}

/** A Todoist connection as connect.ts saves it, for a Todoist user of its own. */
function connection(todoistUserId: string = crypto.randomUUID()): Omit<TodoistAccountRow, "userId"> {
  return {
    todoistUserId,
    email: "me@example.com",
    accessToken: "v1.sealed.access",
    refreshToken: "v1.sealed.refresh",
    expiresAt: 1_800_000_000_000,
    projectId: "project-1",
    appUrl: "https://mandaala.online",
    timeZone: "Europe/Lisbon",
    weekStart: 1,
    status: "ok",
    lastError: "",
    syncToken: null,
    activitySince: "2026-03-01T08:00:00.000Z",
    lastSyncAt: null,
    lastCatchupAt: 0,
    rolloverDay: "",
    connectedAt: "2026-03-01T08:00:00.000Z",
  };
}

async function connectedAccount(name?: string): Promise<User> {
  const user = await newAccount(name);
  await saveTodoistAccount(user.id, connection());
  return user;
}

/** A goal with three named routines, none picked yet. */
async function goalWithActions(userId: string): Promise<{ goalId: string; ids: string[] }> {
  const goal = await createGoal(userId, { title: "Read 20 books", pillars: ["Habit"] });
  const ids = goal.cells.filter((c) => c.pillar === 0 && c.slot >= 0).slice(0, 3).map((c) => c.id);
  await updateCells(userId, ids.map((id, i) => ({ id, patch: { text: `Routine ${i + 1}`, kind: "habit" as const } })));
  return { goalId: goal.id, ids };
}

function link(cellId: string, goalId: string, taskId: string | null = crypto.randomUUID()): TodoistLink {
  return {
    cellId,
    goalId,
    taskId,
    sent: {
      content: "Routine 1",
      description: "",
      priority: 1,
      repeat: "every day",
      completed: false,
      activatedAt: null,
      due: DAY,
    },
    echoes: [],
    seenState: "",
    seenDone: "",
    inboundCheckin: null,
    version: 1,
    createdAt: new Date().toISOString(),
  };
}

/** "kind:target" of each change waiting in the user's outbox, oldest first. */
async function queued(userId: string): Promise<string[]> {
  return (await dueTodoistOutbox(userId, Date.now(), 100)).map((row) => `${row.kind}:${row.target}`);
}

/** Empties the user's outbox, as a push would. */
async function drain(userId: string): Promise<void> {
  const rows = await dueTodoistOutbox(userId, Number.MAX_SAFE_INTEGER, 1000);
  await finishTodoistOutbox(userId, rows.map((row) => row.id));
}

/** How many rows the user has in each Todoist table. */
async function todoistRows(userId: string): Promise<Record<string, number>> {
  const db = await getDb();
  const counts = await db.batch(
    TABLES.map((table) => ({ sql: `SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, args: [userId] })),
    "read",
  );
  return Object.fromEntries(TABLES.map((table, i) => [table, Number(counts[i].rows[0].n)]));
}

describe("a Todoist connection", () => {
  it("is saved, read back and updated", async () => {
    const user = await newAccount();
    expect(await getTodoistAccount(user.id)).toBeNull();
    expect((await getUser(user.id))?.todoist).toBe(false);

    const saved = connection();
    await saveTodoistAccount(user.id, saved);
    expect(await getTodoistAccount(user.id)).toEqual({ userId: user.id, ...saved });
    expect((await getUser(user.id))?.todoist).toBe(true);
    expect(await findTodoistOwner(saved.todoistUserId)).toBe(user.id);

    await updateTodoistAccount(user.id, {});
    await updateTodoistAccount(user.id, { status: "reauth", lastError: "Todoist asked you to connect again.", projectId: null });
    expect(await getTodoistAccount(user.id)).toEqual({
      userId: user.id,
      ...saved,
      status: "reauth",
      lastError: "Todoist asked you to connect again.",
      projectId: null,
    });
  });

  it("is replaced when the same account connects again", async () => {
    const user = await connectedAccount();
    const again = { ...connection(), accessToken: "v1.sealed.new" };
    await saveTodoistAccount(user.id, again);
    expect(await getTodoistAccount(user.id)).toEqual({ userId: user.id, ...again });
  });

  it("refuses a Todoist user connected to another account", async () => {
    const alex = await newAccount("alex");
    const bea = await connectedAccount("bea");
    const todoistUserId = crypto.randomUUID();
    await saveTodoistAccount(alex.id, connection(todoistUserId));
    const beaBefore = await getTodoistAccount(bea.id);

    expect(await status(saveTodoistAccount(bea.id, connection(todoistUserId)))).toBe(409);
    expect(await getTodoistAccount(bea.id)).toEqual(beaBefore);
    expect(await findTodoistOwner(todoistUserId)).toBe(alex.id);
    // The same account connecting it again is fine.
    expect(await status(saveTodoistAccount(alex.id, connection(todoistUserId)))).toBe(200);
  });

  it("is not saved once the Mandaala account is gone", async () => {
    const user = await newAccount();
    await deleteUser(user.id);
    expect(await status(saveTodoistAccount(user.id, connection()))).toBe(401);
    expect(await getTodoistAccount(user.id)).toBeNull();
  });

  it("is listed for the daily job, the longest without a catch-up first", async () => {
    const recent = await connectedAccount();
    const stale = await connectedAccount();
    const unconnected = await newAccount();
    await updateTodoistAccount(recent.id, { lastCatchupAt: Date.now() });
    await updateTodoistAccount(stale.id, { lastCatchupAt: Date.now() - 86_400_000 });
    const ids = await todoistUserIds();
    expect(ids).not.toContain(unconnected.id);
    expect(ids.indexOf(stale.id)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(stale.id)).toBeLessThan(ids.indexOf(recent.id));
  });
});

describe("the lease", () => {
  it("goes to one worker at a time, and to another once it runs out", async () => {
    const user = await connectedAccount();
    expect(await claimTodoistLease(user.id, "a", 61_000, 1_000)).toBe(true);
    expect(await claimTodoistLease(user.id, "b", 62_000, 2_000)).toBe(false);
    // The holder extends it.
    expect(await claimTodoistLease(user.id, "a", 121_000, 60_000)).toBe(true);
    expect(await claimTodoistLease(user.id, "b", 130_000, 70_000)).toBe(false);
    // Not extended in time: someone else takes it, and the old holder has lost it.
    expect(await claimTodoistLease(user.id, "b", 181_000, 121_000)).toBe(true);
    expect(await claimTodoistLease(user.id, "a", 190_000, 130_000)).toBe(false);
  });

  it("is freed only by its holder", async () => {
    const user = await connectedAccount();
    await claimTodoistLease(user.id, "a", 61_000, 1_000);
    await releaseTodoistLease(user.id, "b");
    expect(await claimTodoistLease(user.id, "b", 62_000, 2_000)).toBe(false);
    await releaseTodoistLease(user.id, "a");
    expect(await claimTodoistLease(user.id, "b", 62_000, 2_000)).toBe(true);
  });

  it("stays with its holder when the connection is saved again", async () => {
    const user = await connectedAccount();
    await claimTodoistLease(user.id, "a", 61_000, 1_000);
    await saveTodoistAccount(user.id, connection());
    expect(await claimTodoistLease(user.id, "b", 62_000, 2_000)).toBe(false);
  });

  it("is never given for an account without Todoist", async () => {
    const user = await newAccount();
    expect(await claimTodoistLease(user.id, "a", 61_000, 1_000)).toBe(false);
  });
});

describe("the outbox", () => {
  it("queues nothing for an account without Todoist", async () => {
    const user = await newAccount();
    const { goalId, ids } = await goalWithActions(user.id);
    await updateCell(user.id, ids[0], { active: true });
    await updateCells(user.id, [{ id: ids[1], patch: { active: true } }]);
    await setCheckin(user.id, ids[0], DAY, true);
    await setCheckin(user.id, ids[0], DAY, false);
    await updateGoal(user.id, goalId, { title: "Read 30 books", status: "archived" });
    await queueTodoist(user.id, "all");
    await deleteGoal(user.id, goalId);
    expect((await todoistRows(user.id)).todoist_outbox).toBe(0);
    expect(await nextTodoistOutbox(user.id)).toBeNull();
  });

  it("queues square changes only for squares that are linked or picked", async () => {
    const user = await connectedAccount();
    const { goalId, ids } = await goalWithActions(user.id);
    const [picked, linked, other] = ids;
    expect(await queued(user.id)).toEqual([]);

    await updateCell(user.id, picked, { notes: "Before bed" });
    expect(await queued(user.id)).toEqual([]);
    await updateCell(user.id, picked, { active: true });
    expect(await queued(user.id)).toEqual([`cell:${picked}`]);
    await drain(user.id);
    // Removed from this week and never linked: Todoist never had it.
    await updateCell(user.id, picked, { active: false });
    expect(await queued(user.id)).toEqual([]);

    await saveTodoistLink(user.id, link(linked, goalId));
    await updateCell(user.id, linked, { notes: "Fiction first" });
    expect(await queued(user.id)).toEqual([`cell:${linked}`]);
    await drain(user.id);
    // Removed from this week while linked: its task has to go.
    await updateCell(user.id, linked, { active: true });
    await updateCell(user.id, linked, { active: false });
    expect(await queued(user.id)).toEqual([`cell:${linked}`, `cell:${linked}`]);
    await drain(user.id);

    // A batch sees the picks made in it, and queues one row per changed square.
    await updateCells(user.id, [
      { id: picked, patch: { active: true } },
      { id: linked, patch: { notes: "One" } },
      { id: linked, patch: { notes: "Two" } },
      { id: other, patch: { impact: 3 } },
    ]);
    expect(await queued(user.id)).toEqual([`cell:${picked}`, `cell:${linked}`]);
  });

  it("queues check-ins only for linked squares, once per change", async () => {
    const user = await connectedAccount();
    const { goalId, ids } = await goalWithActions(user.id);
    const habit = ids[0];
    await updateCell(user.id, habit, { active: true });
    await drain(user.id);
    await setCheckin(user.id, habit, DAY, true);
    expect(await queued(user.id)).toEqual([]);

    await saveTodoistLink(user.id, link(habit, goalId));
    await setCheckin(user.id, habit, "2026-03-02", true);
    await setCheckin(user.id, habit, "2026-03-02", true); // a retried request changes nothing
    await setCheckin(user.id, habit, "2026-03-02", false);
    const rows = await dueTodoistOutbox(user.id, Date.now(), 100);
    expect(rows.map((row) => [row.kind, row.target, JSON.parse(row.detail)])).toEqual([
      ["checkin", habit, { day: "2026-03-02", done: true }],
      ["checkin", habit, { day: "2026-03-02", done: false }],
    ]);
  });

  it("queues an Undo of a pick while the pick is still on its way to Todoist", async () => {
    const user = await connectedAccount();
    const { ids } = await goalWithActions(user.id);
    const [square, other] = ids;
    await updateCell(user.id, square, { active: true });
    // Not linked yet: the push of the pick may still make its task, so the Undo follows it.
    await updateCell(user.id, square, { active: false });
    expect(await queued(user.id)).toEqual([`cell:${square}`, `cell:${square}`]);
    await drain(user.id);

    // Not linked and nothing waits: Todoist has no task of it to change.
    await setCheckin(user.id, square, DAY, true);
    expect(await queued(user.id)).toEqual([]);
    // Nor when only a change for another square waits.
    await queueTodoist(user.id, "cell", other);
    await updateCell(user.id, square, { notes: "Before bed" });
    await setCheckin(user.id, square, DAY, false);
    expect(await queued(user.id)).toEqual([`cell:${other}`]);
  });

  it("queues ticks and Undos while a change for the whole goal or for everything is on its way", async () => {
    const user = await connectedAccount();
    const { goalId, ids } = await goalWithActions(user.id);
    const [habit, square] = ids;
    await updateCells(user.id, [
      { id: habit, patch: { active: true } },
      { id: square, patch: { active: true } },
    ]);
    await drain(user.id);

    // The first send after connecting may still make the routine's task: the tick follows it.
    await queueTodoist(user.id, "all");
    await setCheckin(user.id, habit, DAY, true);
    expect(await queued(user.id)).toEqual(["all:", `checkin:${habit}`]);
    await drain(user.id);

    // A goal brought back may still make the square's task: the Undo of its pick follows it.
    await queueTodoist(user.id, "goal", goalId);
    await updateCell(user.id, square, { active: false });
    expect(await queued(user.id)).toEqual([`goal:${goalId}`, `cell:${square}`]);
  });

  it("queues goal renames, status changes and deletes", async () => {
    const user = await connectedAccount();
    const { goalId } = await goalWithActions(user.id);
    await updateGoal(user.id, goalId, { why: "To think better", position: 3 });
    expect(await queued(user.id)).toEqual([]);
    await updateGoal(user.id, goalId, { title: "Read 30 books" });
    await updateGoal(user.id, goalId, { status: "archived" });
    await deleteGoal(user.id, goalId);
    expect(await queued(user.id)).toEqual([`goal:${goalId}`, `goal:${goalId}`, `goal:${goalId}`]);
  });

  it("queues nothing for changes that came from Todoist", async () => {
    const user = await connectedAccount();
    const { goalId, ids } = await goalWithActions(user.id);
    const habit = ids[0];
    await updateCell(user.id, habit, { active: true });
    await saveTodoistLink(user.id, link(habit, goalId));
    await drain(user.id);

    const cell = await updateCell(user.id, habit, { text: "Read 15 pages" }, { fromTodoist: true });
    expect(cell.text).toBe("Read 15 pages");
    await setCheckin(user.id, habit, DAY, true, { fromTodoist: true });
    expect((await loadState(user.id, DAY)).checkins.map((c) => c.day)).toEqual([DAY]);
    await setCheckin(user.id, habit, DAY, false, { fromTodoist: true });
    expect((await loadState(user.id, DAY)).checkins).toEqual([]);
    expect(await queued(user.id)).toEqual([]);
  });

  it("hands out due changes oldest first, and holds back a failed one", async () => {
    const user = await connectedAccount();
    await queueTodoist(user.id, "all");
    await queueTodoist(user.id, "goal", "goal-1");
    await queueTodoist(user.id, "cell", "cell-1");
    const [all, goal, cell] = await dueTodoistOutbox(user.id, Date.now(), 100);
    expect([all, goal, cell].map((row) => [row.kind, row.target, row.attempts, row.nextAt])).toEqual([
      ["all", "", 0, 0],
      ["goal", "goal-1", 0, 0],
      ["cell", "cell-1", 0, 0],
    ]);
    expect(await dueTodoistOutbox(user.id, Date.now(), 2)).toEqual([all, goal]);
    expect(await nextTodoistOutbox(user.id)).toBe(0);

    const later = Date.now() + 60_000;
    await retryTodoistOutbox(user.id, [all.id, goal.id], later);
    expect(await dueTodoistOutbox(user.id, Date.now(), 100)).toEqual([cell]);
    await finishTodoistOutbox(user.id, [cell.id]);
    expect(await nextTodoistOutbox(user.id)).toBe(later);
    const retried = await dueTodoistOutbox(user.id, later, 100);
    expect(retried.map((row) => [row.id, row.attempts])).toEqual([
      [all.id, 1],
      [goal.id, 1],
    ]);
    await finishTodoistOutbox(user.id, [all.id, goal.id]);
    expect(await nextTodoistOutbox(user.id)).toBeNull();
  });

  it("releases the changes held back after a failure, for that account only", async () => {
    const user = await connectedAccount();
    const other = await connectedAccount();
    await queueTodoist(user.id, "checkin", "cell-1", JSON.stringify({ day: DAY, done: true }));
    await queueTodoist(other.id, "cell", "cell-2");
    const later = Date.now() + 60 * 60_000;
    for (const { id } of [user, other]) {
      const rows = await dueTodoistOutbox(id, Date.now(), 100);
      await retryTodoistOutbox(id, rows.map((row) => row.id), later);
    }
    expect(await queued(user.id)).toEqual([]);

    await releaseTodoistOutbox(user.id);
    const released = await dueTodoistOutbox(user.id, Date.now(), 100);
    expect(released.map((row) => [row.kind, row.target, row.attempts, row.nextAt])).toEqual([["checkin", "cell-1", 1, 0]]);
    expect(await nextTodoistOutbox(user.id)).toBe(0);
    expect(await queued(other.id)).toEqual([]);
    expect(await nextTodoistOutbox(other.id)).toBe(later);
  });
});

describe("links and sections", () => {
  it("are saved, replaced, found by task and deleted", async () => {
    const user = await connectedAccount();
    const { goalId, ids } = await goalWithActions(user.id);
    const first = link(ids[0], goalId);
    await saveTodoistLink(user.id, first);
    expect(await listTodoistLinks(user.id)).toEqual([first]);
    expect(await todoistLinkForTask(user.id, first.taskId!)).toEqual(first);

    const second: TodoistLink = { ...first, taskId: crypto.randomUUID(), version: 2, seenDone: "2026-03-01T10:00:00Z" };
    await saveTodoistLink(user.id, second);
    expect(await listTodoistLinks(user.id)).toEqual([second]);
    expect(await todoistLinkForTask(user.id, first.taskId!)).toBeNull();

    // Before Todoist confirms the create: no task and nothing sent yet.
    const pending: TodoistLink = { ...link(ids[1], goalId, null), sent: null };
    await saveTodoistLink(user.id, pending);
    expect(await listTodoistLinks(user.id)).toEqual([second, pending]);

    await deleteTodoistLink(user.id, ids[0]);
    expect(await listTodoistLinks(user.id)).toEqual([pending]);

    await saveTodoistSection(user.id, { goalId, sectionId: "section-1", name: "Read 20 books", archived: false });
    await saveTodoistSection(user.id, { goalId, sectionId: "section-1", name: "Read 30 books", archived: true });
    expect(await listTodoistSections(user.id)).toEqual([
      { goalId, sectionId: "section-1", name: "Read 30 books", archived: true },
    ]);
    await deleteTodoistSection(user.id, goalId);
    expect(await listTodoistSections(user.id)).toEqual([]);
  });

  it("keep sent values for 10 minutes and sent completions for 8 days", async () => {
    const user = await connectedAccount();
    const { goalId, ids } = await goalWithActions(user.id);
    const minute = 60_000;
    const day = 24 * 60 * minute;
    const recent = { field: "content", value: "Routine 1", at: Date.now() - minute };
    const oldValue = { field: "content", value: "Routine 0", at: Date.now() - 11 * minute };
    const oldDone = { field: "done", value: "", at: Date.now() - 11 * minute };
    const weekOld = { field: "forward", value: DAY, at: Date.now() - 7 * day };
    const tooOld = { field: "back", value: DAY, at: Date.now() - 9 * day };
    const inboundCheckin = { day: DAY, at: "2026-03-01T09:00:00.000Z" };
    await saveTodoistLink(user.id, {
      ...link(ids[0], goalId),
      echoes: [oldValue, oldDone, weekOld, tooOld, recent],
      inboundCheckin,
    });
    const [saved] = await listTodoistLinks(user.id);
    expect(saved.echoes).toEqual([oldDone, weekOld, recent]);
    expect(saved.inboundCheckin).toEqual(inboundCheckin);
  });

  it("keep the Todoist ticks and undos already applied for 8 days", async () => {
    const user = await connectedAccount();
    const { goalId, ids } = await goalWithActions(user.id);
    const day = 24 * 60 * 60_000;
    const ticked = { field: "ticked", value: DAY, at: Date.now() - 7 * day };
    const unticked = { field: "unticked", value: DAY, at: Date.now() - 7 * day + 60_000 };
    const tooOld = { field: "ticked", value: "2026-02-20", at: Date.now() - 9 * day };
    await saveTodoistLink(user.id, { ...link(ids[0], goalId), echoes: [tooOld, ticked, unticked] });
    const [saved] = await listTodoistLinks(user.id);
    expect(saved.echoes).toEqual([ticked, unticked]);
  });

  it("are not saved for an account without Todoist", async () => {
    const user = await newAccount();
    const { goalId, ids } = await goalWithActions(user.id);
    await saveTodoistLink(user.id, link(ids[0], goalId));
    await saveTodoistSection(user.id, { goalId, sectionId: "section-1", name: "Read 20 books", archived: false });
    expect(await todoistRows(user.id)).toEqual({ todoist_accounts: 0, todoist_links: 0, todoist_sections: 0, todoist_outbox: 0 });
  });

  it("read a broken JSON column as empty", async () => {
    const user = await connectedAccount();
    const { goalId, ids } = await goalWithActions(user.id);
    const [broken, partial] = ids;
    await saveTodoistLink(user.id, link(broken, goalId));
    await saveTodoistLink(user.id, link(partial, goalId));
    const db = await getDb();
    const corrupt = "UPDATE todoist_links SET sent = ?, echoes = ?, inbound_checkin = ? WHERE cell_id = ?";
    await db.execute({ sql: corrupt, args: ["{oops", "not json", "[1,", broken] });
    await db.execute({
      sql: corrupt,
      args: [
        `{"content":"Read","priority":"high"}`,
        `[{"field":"done","value":"","at":1},{"field":2},null]`,
        `{"day":"2026-03-01"}`,
        partial,
      ],
    });

    const links = await listTodoistLinks(user.id);
    expect(links.find((l) => l.cellId === broken)).toMatchObject({ sent: null, echoes: [], inboundCheckin: null });
    expect(links.find((l) => l.cellId === partial)).toMatchObject({
      sent: { content: "Read", description: "", priority: 1, repeat: null, completed: false, activatedAt: null, due: null },
      echoes: [{ field: "done", value: "", at: 1 }],
      inboundCheckin: null,
    });
  });
});

describe("two accounts never see or change each other's Todoist rows", () => {
  let alex: User;
  let bea: User;
  let goalId: string;
  let cellId: string;
  let taskId: string;

  beforeAll(async () => {
    alex = await connectedAccount("alex");
    bea = await connectedAccount("bea");
    const made = await goalWithActions(alex.id);
    goalId = made.goalId;
    cellId = made.ids[0];
    taskId = crypto.randomUUID();
    await updateCell(alex.id, cellId, { active: true });
    await saveTodoistLink(alex.id, link(cellId, goalId, taskId));
    await saveTodoistSection(alex.id, { goalId, sectionId: "section-1", name: "Read 20 books", archived: false });
    await claimTodoistLease(alex.id, "alex-worker", Date.now() + 60_000, Date.now());
  });

  it("shows nothing of the other account", async () => {
    expect(await listTodoistLinks(bea.id)).toEqual([]);
    expect(await todoistLinkForTask(bea.id, taskId)).toBeNull();
    expect(await listTodoistSections(bea.id)).toEqual([]);
    expect(await dueTodoistOutbox(bea.id, Date.now(), 100)).toEqual([]);
    expect(await nextTodoistOutbox(bea.id)).toBeNull();
    expect((await getTodoistAccount(bea.id))?.userId).toBe(bea.id);
  });

  it("queues nothing for the other account's squares and goals", async () => {
    // Not even while a change of bea's own waits that may make tasks.
    await queueTodoist(bea.id, "all");
    const db = await getDb();
    await db.batch(
      [
        cellOutboxStatement(bea.id, cellId),
        checkinOutboxStatement(bea.id, cellId, DAY, true),
        goalOutboxStatement(bea.id, goalId),
      ],
      "write",
    );
    expect(await queued(bea.id)).toEqual(["all:"]);
  });

  it("changes nothing of the other account", async () => {
    const alexRows = await dueTodoistOutbox(alex.id, Date.now(), 100);
    const ids = alexRows.map((row) => row.id);
    await saveTodoistLink(bea.id, link(cellId, goalId));
    await saveTodoistSection(bea.id, { goalId, sectionId: "section-2", name: "Mine now", archived: true });
    await deleteTodoistLink(bea.id, cellId);
    await deleteTodoistSection(bea.id, goalId);
    await retryTodoistOutbox(bea.id, ids, Date.now() + 60_000);
    await finishTodoistOutbox(bea.id, ids);
    await releaseTodoistLease(bea.id, "alex-worker");
    await updateTodoistAccount(bea.id, { status: "reauth" });
    await deleteTodoistData(bea.id);

    expect(await todoistLinkForTask(alex.id, taskId)).toMatchObject({ cellId, goalId, taskId });
    expect(await listTodoistSections(alex.id)).toEqual([
      { goalId, sectionId: "section-1", name: "Read 20 books", archived: false },
    ]);
    expect(await dueTodoistOutbox(alex.id, Date.now(), 100)).toEqual(alexRows);
    expect(await claimTodoistLease(alex.id, "someone-else", Date.now() + 60_000, Date.now())).toBe(false);
    expect((await getTodoistAccount(alex.id))?.status).toBe("ok");
    expect(await getTodoistAccount(bea.id)).toBeNull();
  });
});

describe("forgetting Todoist", () => {
  /** A connected account with a goal, a link, a section and a queued change. */
  async function connectedWithData(): Promise<{ user: User; goalId: string }> {
    const user = await connectedAccount();
    const { goalId, ids } = await goalWithActions(user.id);
    await updateCell(user.id, ids[0], { active: true });
    await saveTodoistLink(user.id, link(ids[0], goalId));
    await saveTodoistSection(user.id, { goalId, sectionId: crypto.randomUUID(), name: "Read 20 books", archived: false });
    expect(await todoistRows(user.id)).toEqual({ todoist_accounts: 1, todoist_links: 1, todoist_sections: 1, todoist_outbox: 1 });
    return { user, goalId };
  }

  const none = { todoist_accounts: 0, todoist_links: 0, todoist_sections: 0, todoist_outbox: 0 };

  it("on disconnect removes the connection and what it kept, but not the goals", async () => {
    const { user, goalId } = await connectedWithData();
    await deleteTodoistData(user.id);
    expect(await todoistRows(user.id)).toEqual(none);
    expect((await getUser(user.id))?.todoist).toBe(false);
    expect((await getGoal(user.id, goalId)).title).toBe("Read 20 books");
  });

  it("with the account removes everything, and only that account's", async () => {
    const { user } = await connectedWithData();
    const { user: other } = await connectedWithData();
    const todoistUserId = (await getTodoistAccount(user.id))!.todoistUserId;
    await deleteUser(user.id);
    expect(await todoistRows(user.id)).toEqual(none);
    expect(await findTodoistOwner(todoistUserId)).toBeNull();
    expect(await todoistRows(other.id)).toEqual({ todoist_accounts: 1, todoist_links: 1, todoist_sections: 1, todoist_outbox: 1 });
  });
});

describe("webhook deliveries", () => {
  it("are recorded once and swept when old", async () => {
    const id = crypto.randomUUID();
    expect(await todoistDeliverySeen(id)).toBe(false);
    await recordTodoistDelivery(id, 1_000);
    await recordTodoistDelivery(id, 2_000); // Todoist sent it again
    expect(await todoistDeliverySeen(id)).toBe(true);
    await sweepTodoistDeliveries(1_000);
    expect(await todoistDeliverySeen(id)).toBe(true);
    await sweepTodoistDeliveries(1_001);
    expect(await todoistDeliverySeen(id)).toBe(false);
  });
});
