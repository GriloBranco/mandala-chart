import { createHmac, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { squareLink, describe as withFooter } from "@/domain/todoist";
import {
  claimTodoistLease,
  createGoal,
  deleteGoal,
  dueTodoistOutbox,
  getCell,
  getTodoistAccount,
  listTodoistLinks,
  listTodoistSections,
  loadState,
  nextTodoistOutbox,
  queueTodoist,
  releaseTodoistLease,
  setCheckin,
  updateCell,
  updateCells,
  updateGoal,
  updateTodoistAccount,
} from "@/server/repo";
import {
  catchUpTodoist,
  disconnectTodoist,
  drainTodoist,
  finishTodoistConnect,
  handleTodoistWebhook,
  rebuildTodoist,
  revokeTodoist,
  runTodoistDaily,
  startTodoistConnect,
  todoistInfo,
} from "@/server/todoist";
import { setTodoistFetch, todoistApi } from "@/server/todoist/api";
import { openToken, sealToken } from "@/server/todoist/crypto";
import { applyInbound, eventsFromWebhook } from "@/server/todoist/inbound";
import { withTodoist } from "@/server/todoist/session";
import { verifyTodoistSignature } from "@/server/todoist/webhook";
import { newAccount } from "../support/accounts";
import { FakeTodoist } from "../support/fake-todoist";

process.env.TODOIST_CLIENT_ID = "engine-client-id";
process.env.TODOIST_CLIENT_SECRET = "engine-client-secret";

const ORIGIN = "https://mandaala.test";
/** A Wednesday. Weeks start on Monday, so this week ends on Sunday 2026-11-01. */
const NOW = new Date("2026-10-28T12:00:00Z");
const MINUTE = 60_000;

let fake: FakeTodoist;
/** How many of Todoist's notices were delivered (or dropped) so far. */
let delivered = 0;

beforeEach(() => {
  // Only Date: the lease waits with real timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fake = new FakeTodoist();
  setTodoistFetch(fake.fetch);
  delivered = 0;
});

afterEach(() => {
  setTodoistFetch(null);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** Moves the clock on, so what happens next is clearly later. */
function later(ms = 5 * MINUTE): void {
  vi.setSystemTime(Date.now() + ms);
}

/** Delivers Todoist's notices not delivered yet, ours and the person's, in order. Returns the answers. */
async function deliver(): Promise<number[]> {
  const pending = fake.webhooks().slice(delivered);
  delivered += pending.length;
  const answers: number[] = [];
  for (const { raw, headers } of pending) answers.push(await handleTodoistWebhook(raw, headers));
  return answers;
}

/** Loses Todoist's notices sent so far, as when the webhook never arrives. */
function lose(): void {
  delivered = fake.webhooks().length;
}

interface Chart {
  goalId: string;
  /** Daily, with notes and the most leverage. */
  daily: string;
  /** Weekly, on Sundays. */
  sunday: string;
  /** Monthly, on the last day. */
  monthly: string;
  task: string;
  /** Named but not picked this week: never sent. */
  idle: string;
}

/** A goal with three routines and a task picked for this week, and one action not picked. */
async function chart(userId: string, title = "Read 20 books"): Promise<Chart> {
  const goal = await createGoal(userId, { title, pillars: ["Habit", "Library"] });
  const [daily, sunday, monthly, task, idle] = goal.cells.filter((c) => c.pillar === 0 && c.slot >= 0).map((c) => c.id);
  await updateCells(userId, [
    {
      id: daily,
      patch: { text: "Read 10 pages", kind: "habit", repeat: "day", notes: "Before bed", impact: 3, effort: 1, helps: [1], active: true },
    },
    { id: sunday, patch: { text: "Plan the reading", kind: "habit", repeat: "week", repeatOn: 0, active: true } },
    { id: monthly, patch: { text: "Visit the library", kind: "habit", repeat: "month", repeatOn: 31, active: true } },
    { id: task, patch: { text: "Buy a reading lamp", kind: "task", impact: 2, effort: 2, active: true } },
    { id: idle, patch: { text: "Join a book club", kind: "task" } },
  ]);
  return { goalId: goal.id, daily, sunday, monthly, task, idle };
}

/** Connects the account to a Todoist user of its own, through the real approval flow. */
async function connect(userId: string, todoistUserId: string = crypto.randomUUID()): Promise<string> {
  fake.addUser({ id: todoistUserId });
  const { url, cookie } = startTodoistConnect(userId, ORIGIN);
  const { code, state } = fake.approve(url, todoistUserId);
  expect(await finishTodoistConnect(userId, { code, state, error: null, cookie, origin: ORIGIN })).toBe("connected");
  return todoistUserId;
}

/** An account with a chart, connected, and everything sent. */
async function synced() {
  const user = await newAccount();
  const squares = await chart(user.id);
  const todoistUserId = await connect(user.id);
  await drainTodoist(user.id);
  lose();
  return { userId: user.id, todoistUserId, ...squares };
}

async function taskIdOf(userId: string, cellId: string): Promise<string> {
  const link = (await listTodoistLinks(userId)).find((l) => l.cellId === cellId);
  if (!link?.taskId) throw new Error(`No task for square ${cellId}`);
  return link.taskId;
}

async function taskOf(userId: string, cellId: string) {
  return fake.task(await taskIdOf(userId, cellId))!;
}

/** The commands Todoist received after `mark` (an earlier fake.commands().length). */
function commandsSince(mark: number) {
  return fake.commands().slice(mark).map(({ type, args }) => ({ type, args }));
}

async function checkinDays(userId: string, cellId: string): Promise<string[]> {
  const { checkins } = await loadState(userId, "2026-01-01");
  return checkins.filter((c) => c.cellId === cellId).map((c) => c.day).sort();
}

describe("the first send", () => {
  it("puts a whole chart in one Mandaala project: a section per goal, each task with its due, priority and notes", async () => {
    const user = await newAccount();
    const squares = await chart(user.id);
    const old = await chart(user.id, "Run a marathon");
    await updateGoal(user.id, old.goalId, { status: "archived" });
    await connect(user.id);
    await drainTodoist(user.id);

    const project = fake.projects().find((p) => p.name === "Mandaala")!;
    const sections = fake.sections().filter((s) => s.project_id === project.id);
    expect(sections.map((s) => s.name)).toEqual(["Read 20 books"]);
    const open = fake.tasks().filter((t) => !t.is_deleted);
    expect(open).toHaveLength(4);
    expect(open.every((t) => t.project_id === project.id && t.section_id === sections[0].id)).toBe(true);

    const footer = (cellId: string) => ({
      pillar: "Habit",
      goal: "Read 20 books",
      link: squareLink(ORIGIN, squares.goalId, 0, cellId),
    });
    expect(await taskOf(user.id, squares.daily)).toMatchObject({
      content: "Read 10 pages",
      description: withFooter("Before bed", footer(squares.daily)),
      priority: 3,
      due: { date: "2026-10-28", string: "every day", lang: "en", is_recurring: true },
    });
    // Picked after this week's Sunday: the first one is next Sunday.
    expect(await taskOf(user.id, squares.sunday)).toMatchObject({
      description: withFooter("", footer(squares.sunday)),
      priority: 1,
      due: { date: "2026-11-01", string: "every sunday", is_recurring: true },
    });
    expect((await taskOf(user.id, squares.monthly)).due).toMatchObject({ date: "2026-10-31", string: "every last day" });
    expect(await taskOf(user.id, squares.task)).toMatchObject({
      content: "Buy a reading lamp",
      priority: 1,
      due: { date: "2026-11-01", lang: "en", is_recurring: false },
    });
    expect(await nextTodoistOutbox(user.id)).toBeNull();

    // Everything again ("Sync now"): nothing to send.
    const mark = fake.commands().length;
    await queueTodoist(user.id, "all");
    await drainTodoist(user.id);
    expect(commandsSince(mark)).toEqual([]);
  });
});

describe("pushing a change", () => {
  it("sends only what changed", async () => {
    const s = await synced();
    const id = await taskIdOf(s.userId, s.daily);
    let mark = fake.commands().length;
    await updateCell(s.userId, s.daily, { text: "Read 20 pages" });
    await drainTodoist(s.userId);
    expect(commandsSince(mark)).toEqual([{ type: "item_update", args: { id, content: "Read 20 pages" } }]);

    mark = fake.commands().length;
    await updateCell(s.userId, s.daily, { notes: "In bed" });
    await updateCell(s.userId, s.daily, { impact: 1 });
    await drainTodoist(s.userId);
    const footer = { pillar: "Habit", goal: "Read 20 books", link: squareLink(ORIGIN, s.goalId, 0, s.daily) };
    expect(commandsSince(mark)).toEqual([
      { type: "item_update", args: { id, description: withFooter("In bed", footer), priority: 1 } },
    ]);

    mark = fake.commands().length;
    await updateCell(s.userId, s.daily, { repeat: "week", repeatOn: 1 });
    await drainTodoist(s.userId);
    // This week's Monday was before the pick: next Monday.
    expect(commandsSince(mark)).toEqual([
      { type: "item_update", args: { id, due: { string: "every monday", date: "2026-11-02", lang: "en" } } },
    ]);

    mark = fake.commands().length;
    await updateCell(s.userId, s.daily, { kind: "task" });
    await drainTodoist(s.userId);
    expect(commandsSince(mark)).toEqual([{ type: "item_update", args: { id, due: { date: "2026-11-01", lang: "en" } } }]);
    expect(fake.task(id)!.due).toMatchObject({ date: "2026-11-01", is_recurring: false });
  });

  it("completes and reopens a task, moving a late one to this week", async () => {
    const s = await synced();
    const id = await taskIdOf(s.userId, s.task);
    let mark = fake.commands().length;
    await updateCell(s.userId, s.task, { status: "done" });
    const { doneAt } = await getCell(s.userId, s.task);
    await drainTodoist(s.userId);
    expect(commandsSince(mark)).toEqual([{ type: "item_complete", args: { id, date_completed: doneAt } }]);
    expect(fake.task(id)!.checked).toBe(true);

    // Reopened the next week: it was due last Sunday.
    vi.setSystemTime(new Date("2026-11-03T09:00:00Z"));
    mark = fake.commands().length;
    await updateCell(s.userId, s.task, { status: "todo" });
    await drainTodoist(s.userId);
    expect(commandsSince(mark)).toEqual([
      { type: "item_uncomplete", args: { id } },
      { type: "item_update", args: { id, due: { date: "2026-11-08", lang: "en" } } },
    ]);
    expect(fake.task(id)).toMatchObject({ checked: false, due: { date: "2026-11-08" } });
  });

  it("archives a routine done for good, and brings it back on its day", async () => {
    const s = await synced();
    const id = await taskIdOf(s.userId, s.daily);
    await updateCell(s.userId, s.daily, { status: "done" });
    await drainTodoist(s.userId);
    expect(fake.task(id)).toMatchObject({ checked: true, due: { is_recurring: true } });

    later(24 * 60 * MINUTE);
    const mark = fake.commands().length;
    await updateCell(s.userId, s.daily, { status: "todo" });
    await drainTodoist(s.userId);
    expect(commandsSince(mark)).toEqual([
      { type: "item_uncomplete", args: { id } },
      { type: "item_update", args: { id, due: { string: "every day", date: "2026-10-29", lang: "en" } } },
    ]);
  });

  it("gives a task picked again this week's end", async () => {
    const s = await synced();
    const id = await taskIdOf(s.userId, s.task);
    vi.setSystemTime(new Date("2026-11-03T09:00:00Z"));
    // Out of this week and back in before anything was sent: the same task, due this week.
    await updateCell(s.userId, s.task, { active: false });
    await updateCell(s.userId, s.task, { active: true });
    const mark = fake.commands().length;
    await drainTodoist(s.userId);
    expect(commandsSince(mark)).toEqual([{ type: "item_update", args: { id, due: { date: "2026-11-08", lang: "en" } } }]);
  });

  it("deletes the task of a square taken out of this week, but only unlinks a completed one", async () => {
    const s = await synced();
    const routine = await taskIdOf(s.userId, s.daily);
    const task = await taskIdOf(s.userId, s.task);
    await updateCell(s.userId, s.task, { status: "done" });
    await drainTodoist(s.userId);

    const mark = fake.commands().length;
    await updateCell(s.userId, s.daily, { active: false });
    await updateCell(s.userId, s.task, { active: false });
    await drainTodoist(s.userId);
    expect(commandsSince(mark)).toEqual([{ type: "item_delete", args: { id: routine } }]);
    expect(fake.task(routine)!.is_deleted).toBe(true);
    expect(fake.task(task)).toMatchObject({ checked: true, is_deleted: false });
    const linked = (await listTodoistLinks(s.userId)).map((l) => l.cellId);
    expect(linked).not.toContain(s.daily);
    expect(linked).not.toContain(s.task);
  });
});

describe("check-ins", () => {
  it("move the routine's occurrence forward, and back when removed", async () => {
    const s = await synced();
    const id = await taskIdOf(s.userId, s.daily);
    let mark = fake.commands().length;
    await setCheckin(s.userId, s.daily, "2026-10-28", true);
    await drainTodoist(s.userId);
    expect(commandsSince(mark)).toEqual([
      {
        type: "item_update_date_complete",
        args: { id, due: { date: "2026-10-29", string: "every day", lang: "en" }, is_forward: 1 },
      },
    ]);
    expect(fake.task(id)!.due!.date).toBe("2026-10-29");

    mark = fake.commands().length;
    await setCheckin(s.userId, s.daily, "2026-10-28", false);
    await drainTodoist(s.userId);
    expect(commandsSince(mark)).toEqual([
      {
        type: "item_update_date_complete",
        args: { id, due: { date: "2026-10-28", string: "every day", lang: "en" }, is_forward: 0 },
      },
    ]);
    expect(fake.task(id)!.due!.date).toBe("2026-10-28");

    // Fixing an earlier day stays in Mandaala.
    mark = fake.commands().length;
    await setCheckin(s.userId, s.daily, "2026-10-26", true);
    await drainTodoist(s.userId);
    expect(commandsSince(mark)).toEqual([]);
    expect(await nextTodoistOutbox(s.userId)).toBeNull();
  });

  it("keep the time of day the person gave the routine in Todoist", async () => {
    const s = await synced();
    const id = await taskIdOf(s.userId, s.daily);
    fake.edit(id, { due: { string: "every day at 7am", date: "2026-10-28T07:00:00" } });
    await deliver();
    later();
    const mark = fake.commands().length;
    await setCheckin(s.userId, s.daily, "2026-10-28", true);
    await drainTodoist(s.userId);
    expect(commandsSince(mark)).toEqual([
      {
        type: "item_update_date_complete",
        args: { id, due: { date: "2026-10-29T07:00:00", string: "every day at 7am", lang: "en" }, is_forward: 1 },
      },
    ]);
  });

  it("let Todoist move the person's own repeat on a tick, and leave an untick to them", async () => {
    const s = await synced();
    const id = await taskIdOf(s.userId, s.daily);
    fake.edit(id, { due: { string: "every other day", date: "2026-10-28" } });
    await deliver();
    expect((await getCell(s.userId, s.daily)).repeat).toBe("day");

    let mark = fake.commands().length;
    later();
    await setCheckin(s.userId, s.daily, "2026-10-28", true);
    await drainTodoist(s.userId);
    expect(commandsSince(mark)).toEqual([{ type: "item_close", args: { id } }]);
    expect(fake.task(id)!.due).toMatchObject({ date: "2026-10-30", string: "every other day" });

    mark = fake.commands().length;
    await setCheckin(s.userId, s.daily, "2026-10-28", false);
    await drainTodoist(s.userId);
    expect(commandsSince(mark)).toEqual([]);
  });

  it("leave a weekly routine picked after its day where it is", async () => {
    const s = await synced();
    const mark = fake.commands().length;
    await setCheckin(s.userId, s.sunday, "2026-10-28", true);
    await drainTodoist(s.userId);
    await setCheckin(s.userId, s.sunday, "2026-10-28", false);
    await drainTodoist(s.userId);
    expect(commandsSince(mark)).toEqual([]);
    expect((await taskOf(s.userId, s.sunday)).due!.date).toBe("2026-11-01");
  });

  it("still move the routine on when Todoist can take them only after their period ended", async () => {
    const s = await synced();
    const id = await taskIdOf(s.userId, s.sunday);
    // Saturday evening, the last day of the week that began on Sunday 11-01: late in Todoist.
    vi.setSystemTime(new Date("2026-11-07T21:00:00Z"));
    fake.failNext(1, 503, { path: "/api/v1/sync" });
    await setCheckin(s.userId, s.sunday, "2026-11-07", true);
    await drainTodoist(s.userId);
    expect(fake.task(id)!.due!.date).toBe("2026-11-01");

    // Todoist answers again on Sunday morning, in the next week.
    vi.setSystemTime(new Date("2026-11-08T09:00:00Z"));
    const mark = fake.commands().length;
    await drainTodoist(s.userId);
    expect(commandsSince(mark)).toEqual([
      {
        type: "item_update_date_complete",
        args: { id, due: { date: "2026-11-08", string: "every sunday", lang: "en" }, is_forward: 1 },
      },
    ]);
    expect(await nextTodoistOutbox(s.userId)).toBeNull();
  });
});

describe("a retry", () => {
  /** The command ids of each /sync request with commands, in order. */
  function syncRequests(): string[][] {
    return fake
      .requests()
      .filter((r) => r.url.pathname === "/api/v1/sync" && new URLSearchParams(r.body).has("commands"))
      .map((r) => (JSON.parse(new URLSearchParams(r.body).get("commands")!) as { uuid: string }[]).map((c) => c.uuid));
  }

  it("waits while Todoist is down, then sends the same commands with the same ids", async () => {
    const user = await newAccount();
    await chart(user.id);
    await connect(user.id);
    const before = syncRequests().length;
    fake.failNext(1, 503, { path: "/api/v1/sync" });
    await drainTodoist(user.id);
    expect(fake.tasks()).toEqual([]);
    const [row] = await dueTodoistOutbox(user.id, Number.MAX_SAFE_INTEGER, 10);
    expect(row).toMatchObject({ kind: "all", attempts: 1 });
    expect(row.nextAt).toBe(Date.now() + MINUTE);

    // Not due yet: nothing is sent.
    await drainTodoist(user.id);
    expect(syncRequests().length).toBe(before + 1);
    later(MINUTE);
    await drainTodoist(user.id);
    const [failed, retried] = syncRequests().slice(before);
    expect(retried).toEqual(failed);
    expect(fake.tasks().filter((t) => !t.is_deleted)).toHaveLength(4);
    expect(await nextTodoistOutbox(user.id)).toBeNull();
  });

  it("finds the tasks of a create whose answer was lost, instead of making them twice", async () => {
    const user = await newAccount();
    const squares = await chart(user.id);
    await connect(user.id);
    let dropped = false;
    setTodoistFetch(async (input, init) => {
      const response = await fake.fetch(input, init);
      if (!dropped && String(init?.body ?? "").includes("item_add")) {
        dropped = true;
        throw new TypeError("fetch failed");
      }
      return response;
    });
    await drainTodoist(user.id);
    expect(dropped).toBe(true);
    expect(fake.tasks()).toHaveLength(4);
    expect(await listTodoistLinks(user.id)).toEqual([]);

    later(MINUTE);
    const mark = fake.commands().length;
    await drainTodoist(user.id);
    expect(commandsSince(mark)).toEqual([]);
    expect(fake.tasks()).toHaveLength(4);
    const links = await listTodoistLinks(user.id);
    expect(links.map((l) => l.cellId).sort()).toEqual([squares.daily, squares.sunday, squares.monthly, squares.task].sort());
    for (const link of links) expect(fake.task(link.taskId!)!.description).toContain(`c=${link.cellId}`);
  });

  it("after a crash before Todoist's answer, links what Todoist made instead of making it again", async () => {
    const user = await newAccount();
    await connect(user.id);
    await drainTodoist(user.id);
    // Picked one by one after connecting: changes to single squares.
    const squares = await chart(user.id);
    // Todoist makes the tasks, then the worker stops before it hears back (a crash, a timeout).
    let crashed = false;
    setTodoistFetch(async (input, init) => {
      const response = await fake.fetch(input, init);
      if (!crashed && String(init?.body ?? "").includes("item_add")) {
        crashed = true;
        throw new Error("The function ran out of time");
      }
      return response;
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await drainTodoist(user.id);
    quiet.mockRestore();
    expect(fake.tasks()).toHaveLength(4);
    // Nothing was marked: the same changes go again at once, and find the tasks by their footer.
    await drainTodoist(user.id);
    expect(fake.commands().filter((c) => c.type === "item_add")).toHaveLength(4);
    expect(fake.tasks()).toHaveLength(4);
    const links = await listTodoistLinks(user.id);
    expect(links.map((l) => l.cellId).sort()).toEqual([squares.daily, squares.sunday, squares.monthly, squares.task].sort());
    for (const link of links) expect(fake.task(link.taskId!)!.description).toContain(`c=${link.cellId}`);
    expect(await nextTodoistOutbox(user.id)).toBeNull();
  });

  it("completes a task once when the answer was lost", async () => {
    const s = await synced();
    const id = await taskIdOf(s.userId, s.task);
    await updateCell(s.userId, s.task, { status: "done" });
    let dropped = false;
    setTodoistFetch(async (input, init) => {
      const response = await fake.fetch(input, init);
      if (!dropped && String(init?.body ?? "").includes("item_complete")) {
        dropped = true;
        throw new TypeError("fetch failed");
      }
      return response;
    });
    await drainTodoist(s.userId);
    later(MINUTE);
    await drainTodoist(s.userId);
    const completes = fake.commands().filter((c) => c.type === "item_complete");
    expect(completes.map((c) => c.repeated)).toEqual([false, true]);
    expect(new Set(completes.map((c) => c.uuid)).size).toBe(1);
    expect(fake.activities().filter((a) => a.object_id === id && a.event_type === "completed")).toHaveLength(1);
    expect((await listTodoistLinks(s.userId)).find((l) => l.cellId === s.task)!.sent!.completed).toBe(true);
  });

  it("waits as long as Todoist asks after too many requests", async () => {
    const user = await newAccount();
    await chart(user.id);
    await connect(user.id);
    fake.failNext(1, 429, { retryAfter: 30, path: "/api/v1/sync" });
    await drainTodoist(user.id);
    const [row] = await dueTodoistOutbox(user.id, Number.MAX_SAFE_INTEGER, 10);
    expect(row.nextAt).toBe(Date.now() + 30_000);
    expect((await getTodoistAccount(user.id))!.lastError).toMatch(/not answering/);
    later(30_000);
    await drainTodoist(user.id);
    expect(fake.tasks()).toHaveLength(4);
    expect((await getTodoistAccount(user.id))!.lastError).toBe("");
  });

  it("stops when another worker took the lease over, keeping what is left for it", async () => {
    const user = await newAccount();
    await chart(user.id);
    await connect(user.id);
    // The first request takes so long that the lease runs out and another worker takes it.
    let slow = true;
    setTodoistFetch(async (input, init) => {
      const response = await fake.fetch(input, init);
      if (slow && String(input).endsWith("/api/v1/sync")) {
        slow = false;
        later(61_000);
        await claimTodoistLease(user.id, "another-worker", Date.now() + MINUTE, Date.now());
      }
      return response;
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await drainTodoist(user.id);
    expect(quiet).toHaveBeenCalledWith(expect.objectContaining({ message: "Another Todoist worker took over this account." }));
    quiet.mockRestore();
    expect(fake.commands().filter((c) => c.type === "item_add")).toEqual([]);
    const [row] = await dueTodoistOutbox(user.id, Date.now(), 10);
    expect(row).toMatchObject({ kind: "all", attempts: 0 });
    await releaseTodoistLease(user.id, "another-worker");
    await drainTodoist(user.id);
    expect(fake.tasks().filter((t) => !t.is_deleted)).toHaveLength(4);
  });

  it("drops one command Todoist refuses for good, says why, and keeps the others", async () => {
    const s = await synced();
    const lamp = await taskIdOf(s.userId, s.task);
    later();
    await updateCell(s.userId, s.task, { text: "Buy two lamps" });
    await updateCell(s.userId, s.daily, { text: "Read 20 pages" });
    // Todoist answers the lamp's update with an error of its own, and takes the other one.
    setTodoistFetch(async (input, init) => {
      const response = await fake.fetch(input, init);
      const commands = new URLSearchParams(String(init?.body ?? "")).get("commands");
      const list = commands ? (JSON.parse(commands) as { uuid: string; args: { id?: string } }[]) : [];
      const refused = list.find((c) => c.args.id === lamp);
      if (!refused) return response;
      const body = await response.json();
      const error = { error_tag: "INVALID_ARGUMENT_VALUE", error: "Invalid argument value", http_code: 400 };
      body.sync_status[refused.uuid] = error;
      return Response.json(body);
    });
    await drainTodoist(s.userId);
    expect(await getTodoistAccount(s.userId)).toMatchObject({
      status: "ok",
      lastError: "Todoist did not take a change (Invalid argument value).",
    });
    expect(await nextTodoistOutbox(s.userId)).toBeNull();
    const links = await listTodoistLinks(s.userId);
    expect(links.find((l) => l.cellId === s.daily)!.sent!.content).toBe("Read 20 pages");
    expect(links.find((l) => l.cellId === s.task)!.sent!.content).toBe("Buy a reading lamp");
  });

  it("drops a change Todoist refuses for good, and says why", async () => {
    const s = await synced();
    // A task id Todoist never had: an argument it cannot take, not a missing task.
    await updateCell(s.userId, s.task, { text: "x".repeat(200) });
    fake.failNext(1, 400, { path: "/api/v1/sync" });
    await drainTodoist(s.userId);
    expect((await getTodoistAccount(s.userId))!.lastError).toMatch(/^Todoist did not take a change \(.+\)\.$/);
    expect(await nextTodoistOutbox(s.userId)).toBeNull();
  });
});

describe("goals", () => {
  it("leave Todoist when achieved and come back when restored, in the same section", async () => {
    const s = await synced();
    await updateCell(s.userId, s.task, { status: "done" });
    await drainTodoist(s.userId);
    const done = await taskIdOf(s.userId, s.task);
    const routine = await taskIdOf(s.userId, s.daily);

    await updateGoal(s.userId, s.goalId, { status: "achieved" });
    await drainTodoist(s.userId);
    expect(fake.task(routine)!.is_deleted).toBe(true);
    expect(fake.task(done)).toMatchObject({ checked: true, is_deleted: false });
    expect(await listTodoistLinks(s.userId)).toEqual([]);
    const [section] = fake.sections();
    expect(section).toMatchObject({ name: "Read 20 books", is_archived: true, is_deleted: false });

    await updateGoal(s.userId, s.goalId, { status: "active", title: "Read 30 books" });
    await drainTodoist(s.userId);
    expect(fake.sections()).toHaveLength(1);
    expect(fake.sections()[0]).toMatchObject({ id: section.id, name: "Read 30 books", is_archived: false });
    // The done task stays done: three routines come back.
    const back = fake.tasks().filter((t) => !t.is_deleted && !t.checked);
    expect(back).toHaveLength(3);
    expect(back.every((t) => t.section_id === section.id && t.description.includes("Read 30 books"))).toBe(true);
  });

  it("keep their section when the person has own tasks in it, and forget it when deleted", async () => {
    const s = await synced();
    const [section] = fake.sections();
    const project = fake.projects().find((p) => p.name === "Mandaala")!;
    const own = fake.add({ content: "My own task", projectId: project.id, sectionId: section.id, userId: s.todoistUserId });
    await updateGoal(s.userId, s.goalId, { status: "archived" });
    await drainTodoist(s.userId);
    expect(fake.sections()[0].is_archived).toBe(false);
    expect(fake.task(own.id)!.checked).toBe(false);
    expect(fake.tasks().filter((t) => !t.is_deleted).map((t) => t.id)).toEqual([own.id]);

    fake.remove(own.id);
    await deleteGoal(s.userId, s.goalId);
    await drainTodoist(s.userId);
    expect(fake.sections()[0]).toMatchObject({ is_archived: true, is_deleted: false });
    expect(await listTodoistSections(s.userId)).toEqual([]);
  });

  it("take their tasks along when deleted", async () => {
    const s = await synced();
    await deleteGoal(s.userId, s.goalId);
    await drainTodoist(s.userId);
    expect(fake.tasks().filter((t) => !t.is_deleted)).toEqual([]);
    expect(fake.sections()[0]).toMatchObject({ is_archived: true, is_deleted: false });
    expect(await listTodoistLinks(s.userId)).toEqual([]);
    expect(await listTodoistSections(s.userId)).toEqual([]);
  });

  it("are renamed with their section", async () => {
    const s = await synced();
    const [section] = fake.sections();
    const mark = fake.commands().length;
    await updateGoal(s.userId, s.goalId, { title: "Read 25 books" });
    await drainTodoist(s.userId);
    const sent = commandsSince(mark);
    expect(sent[0]).toEqual({ type: "section_update", args: { id: section.id, name: "Read 25 books" } });
    // The footer names the goal: each task's description follows.
    expect(sent.slice(1).map((c) => c.type)).toEqual(["item_update", "item_update", "item_update", "item_update"]);
    expect((await taskOf(s.userId, s.daily)).description).toContain("Habit · Read 25 books · ");
  });

  it("make the section again when the person deleted it", async () => {
    const s = await synced();
    const project = fake.projects().find((p) => p.name === "Mandaala")!;
    // Deleting a section in Todoist deletes its tasks; the notices are lost here.
    const [section] = fake.sections();
    const grant = fake.grant(s.todoistUserId);
    const client = todoistApi({ token: async () => grant.accessToken, refresh: async () => grant.accessToken });
    await client.sync({ commands: [{ type: "section_delete", uuid: crypto.randomUUID(), args: { id: section.id } }] });
    lose();
    const other = (await getCell(s.userId, s.idle)).id;
    await updateCell(s.userId, other, { active: true });
    await drainTodoist(s.userId);
    await drainTodoist(s.userId);
    const sections = fake.sections().filter((x) => !x.is_deleted);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ name: "Read 20 books", project_id: project.id });
    expect((await taskOf(s.userId, other)).section_id).toBe(sections[0].id);
  });
});

describe("a big chart", () => {
  it("goes in requests Todoist takes: at most 100 commands, well under 1 MiB", async () => {
    const user = await newAccount();
    for (const title of ["First goal", "Second goal"]) {
      const goal = await createGoal(user.id, { title, pillars: Array.from({ length: 8 }, (_, i) => `Pillar ${i + 1}`) });
      const actions = goal.cells.filter((c) => c.slot >= 0);
      const notes = "Long notes. ".repeat(1000);
      await updateCells(user.id, actions.map((c) => ({ id: c.id, patch: { text: `Action ${c.pillar}.${c.slot}`, notes, active: true } })));
    }
    await connect(user.id);
    await drainTodoist(user.id);
    expect(fake.tasks().filter((t) => !t.is_deleted)).toHaveLength(128);
    const sends = fake
      .requests()
      .filter((r) => r.url.pathname === "/api/v1/sync" && new URLSearchParams(r.body).has("commands"));
    for (const request of sends) {
      expect(JSON.parse(new URLSearchParams(request.body).get("commands")!).length).toBeLessThanOrEqual(100);
      expect(request.body.length).toBeLessThan(1024 * 1024);
    }
    expect(await nextTodoistOutbox(user.id)).toBeNull();
  });

  it("goes in requests under 1 MiB as sent, even with long notes in Chinese", async () => {
    const user = await newAccount();
    const goal = await createGoal(user.id, { title: "学中文", pillars: ["汉字"] });
    const actions = goal.cells.filter((c) => c.pillar === 0 && c.slot >= 0);
    // Short as JSON, but nine bytes a character once form-encoded.
    const notes = "汉".repeat(15_500);
    await updateCells(user.id, actions.map((c) => ({ id: c.id, patch: { text: `第${c.slot + 1}课`, notes, active: true } })));
    await connect(user.id);
    // Todoist refuses a body over 1 MiB.
    setTodoistFetch(async (input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (Buffer.byteLength(body) > 1024 * 1024) return new Response("Request Entity Too Large", { status: 413 });
      return fake.fetch(input, init);
    });
    await drainTodoist(user.id);
    expect(fake.tasks().filter((t) => !t.is_deleted)).toHaveLength(actions.length);
    expect((await getTodoistAccount(user.id))!.lastError).toBe("");
    expect(await nextTodoistOutbox(user.id)).toBeNull();
  });
});

describe("Todoist's notices", () => {
  it("of our own changes change nothing in Mandaala", async () => {
    const s = await synced();
    await updateCell(s.userId, s.daily, { text: "Read 20 pages", notes: "Anywhere" });
    await setCheckin(s.userId, s.daily, "2026-10-28", true);
    await updateCell(s.userId, s.task, { status: "done" });
    await updateCell(s.userId, s.monthly, { repeat: "month", repeatOn: 5 });
    await drainTodoist(s.userId);
    const before = await loadState(s.userId, "2026-01-01");
    const answers = await deliver();
    expect(answers.length).toBeGreaterThanOrEqual(4);
    expect(answers.every((answer) => answer === 200)).toBe(true);
    expect(await loadState(s.userId, "2026-01-01")).toEqual(before);
    expect(await nextTodoistOutbox(s.userId)).toBeNull();
  });

  it("of edits in Todoist change the square, and nothing goes back", async () => {
    const s = await synced();
    const id = await taskIdOf(s.userId, s.daily);
    const footer = { pillar: "Habit", goal: "Read 20 books", link: squareLink(ORIGIN, s.goalId, 0, s.daily) };
    later();
    fake.edit(id, { content: "Read 30 pages\nevery night", description: withFooter("On the sofa", footer) });
    fake.edit(id, { due: { string: "every monday", date: "2026-11-02" } });
    await deliver();
    expect(await getCell(s.userId, s.daily)).toMatchObject({
      text: "Read 30 pages every night",
      notes: "On the sofa",
      kind: "habit",
      repeat: "week",
      repeatOn: 1,
    });
    expect(await nextTodoistOutbox(s.userId)).toBeNull();
    const mark = fake.commands().length;
    await queueTodoist(s.userId, "all");
    await drainTodoist(s.userId);
    expect(commandsSince(mark)).toEqual([]);
    expect(fake.task(id)!.content).toBe("Read 30 pages\nevery night");
  });

  it("of a repeat Mandaala cannot show keep it in Todoist only", async () => {
    const s = await synced();
    const id = await taskIdOf(s.userId, s.daily);
    later();
    fake.edit(id, { due: { string: "every 2 weeks", date: "2026-11-02" } });
    await deliver();
    expect(await getCell(s.userId, s.daily)).toMatchObject({ kind: "habit", repeat: "day" });
    later();
    const mark = fake.commands().length;
    await updateCell(s.userId, s.daily, { text: "Read 15 pages" });
    await drainTodoist(s.userId);
    expect(commandsSince(mark)).toEqual([{ type: "item_update", args: { id, content: "Read 15 pages" } }]);
    expect(fake.task(id)!.due!.string).toBe("every 2 weeks");
  });

  it("keep the newer text when both sides changed it", async () => {
    const s = await synced();
    const id = await taskIdOf(s.userId, s.daily);
    // Todoist first, then Mandaala, then Todoist's notice: Mandaala's newer text wins on both sides.
    later();
    fake.edit(id, { content: "From Todoist" });
    later();
    await updateCell(s.userId, s.daily, { text: "From Mandaala" });
    await deliver();
    expect((await getCell(s.userId, s.daily)).text).toBe("From Mandaala");
    await drainTodoist(s.userId);
    expect(fake.task(id)!.content).toBe("From Mandaala");
    await deliver();

    // Mandaala first, then Todoist: Todoist's newer text wins, and nothing is sent back.
    later();
    await updateCell(s.userId, s.daily, { text: "Mandaala again" });
    later();
    fake.edit(id, { content: "Todoist again" });
    await deliver();
    expect((await getCell(s.userId, s.daily)).text).toBe("Todoist again");
    const mark = fake.commands().length;
    await drainTodoist(s.userId);
    expect(commandsSince(mark)).toEqual([]);
  });

  it("older than a change we sent since still let the newer edit win, on both sides", async () => {
    const s = await synced();
    const id = await taskIdOf(s.userId, s.daily);
    // Mandaala, then the person in Todoist; our change lands over theirs before their notice is read.
    later();
    await updateCell(s.userId, s.daily, { text: "From Mandaala" });
    later();
    fake.edit(id, { content: "From Todoist" });
    later();
    await drainTodoist(s.userId);
    expect(fake.task(id)!.content).toBe("From Mandaala");
    await deliver();
    expect((await getCell(s.userId, s.daily)).text).toBe("From Todoist");
    await drainTodoist(s.userId);
    expect(fake.task(id)!.content).toBe("From Todoist");
    await deliver();
    expect((await getCell(s.userId, s.daily)).text).toBe("From Todoist");

    // The other way round: the person's edit was the older one, so Mandaala's stays everywhere.
    later();
    fake.edit(id, { content: "Old in Todoist" });
    later();
    await updateCell(s.userId, s.daily, { text: "New in Mandaala" });
    later();
    await drainTodoist(s.userId);
    await deliver();
    await drainTodoist(s.userId);
    expect((await getCell(s.userId, s.daily)).text).toBe("New in Mandaala");
    expect(fake.task(id)!.content).toBe("New in Mandaala");
  });

  it("of the person setting back a value we sent minutes ago are not taken for ours", async () => {
    const s = await synced();
    const id = await taskIdOf(s.userId, s.task);
    later();
    await updateCell(s.userId, s.task, { text: "Buy two lamps" });
    await drainTodoist(s.userId);
    await deliver();
    later(MINUTE);
    fake.edit(id, { content: "Buy a desk lamp" });
    await deliver();
    expect((await getCell(s.userId, s.task)).text).toBe("Buy a desk lamp");
    later(MINUTE);
    fake.edit(id, { content: "Buy two lamps" });
    await deliver();
    expect((await getCell(s.userId, s.task)).text).toBe("Buy two lamps");

    // The same with ticks, within the two minutes a tick of ours is recognised by.
    await updateCell(s.userId, s.task, { status: "done" });
    await drainTodoist(s.userId);
    await deliver();
    later(30_000);
    fake.uncomplete(id);
    await deliver();
    expect((await getCell(s.userId, s.task)).status).toBe("todo");
    later(30_000);
    fake.complete(id);
    await deliver();
    expect((await getCell(s.userId, s.task)).status).toBe("done");
  });

  it("of an older edit arriving after a newer one are ignored", async () => {
    const s = await synced();
    const id = await taskIdOf(s.userId, s.daily);
    later();
    const first = fake.edit(id, { content: "First" });
    later();
    const second = fake.edit(id, { content: "Second" });
    expect(await handleTodoistWebhook(second.raw, second.headers)).toBe(200);
    expect(await handleTodoistWebhook(first.raw, first.headers)).toBe(200);
    expect((await getCell(s.userId, s.daily)).text).toBe("Second");
  });

  it("of a task completed or reopened in Todoist mark the square once, newest last", async () => {
    const s = await synced();
    const id = await taskIdOf(s.userId, s.task);
    later();
    const completed = fake.complete(id);
    later();
    const reopened = fake.uncomplete(id);
    expect(await handleTodoistWebhook(completed.raw, completed.headers)).toBe(200);
    const doneAt = new Date(JSON.parse(completed.raw).triggered_at).toISOString();
    expect(await getCell(s.userId, s.task)).toMatchObject({ status: "done", doneAt });
    expect(await handleTodoistWebhook(reopened.raw, reopened.headers)).toBe(200);
    expect((await getCell(s.userId, s.task)).status).toBe("todo");
    // The completion again by another way (the activity log): older than what was applied.
    const again = new Headers(completed.headers);
    again.set("X-Todoist-Delivery-ID", crypto.randomUUID());
    expect(await handleTodoistWebhook(completed.raw, again)).toBe(200);
    expect((await getCell(s.userId, s.task)).status).toBe("todo");
    expect(await nextTodoistOutbox(s.userId)).toBeNull();
  });

  it("of a routine ticked in Todoist check it in on its day, and an undo removes just that check-in", async () => {
    const s = await synced();
    const id = await taskIdOf(s.userId, s.daily);
    later();
    fake.complete(id);
    await deliver();
    expect(await checkinDays(s.userId, s.daily)).toEqual(["2026-10-28"]);
    // Ticked again: tomorrow's occurrence, done early, counts for tomorrow.
    later();
    fake.complete(id);
    await deliver();
    expect(await checkinDays(s.userId, s.daily)).toEqual(["2026-10-28", "2026-10-29"]);
    later();
    fake.uncomplete(id);
    await deliver();
    expect(await checkinDays(s.userId, s.daily)).toEqual(["2026-10-28"]);
    expect(await nextTodoistOutbox(s.userId)).toBeNull();
  });

  it("of a routine ticked in both apps make one check-in, and an undo in Todoist keeps Mandaala's", async () => {
    const s = await synced();
    const id = await taskIdOf(s.userId, s.daily);
    await setCheckin(s.userId, s.daily, "2026-10-28", true);
    later();
    fake.complete(id);
    await deliver();
    expect(await checkinDays(s.userId, s.daily)).toEqual(["2026-10-28"]);
    // Todoist moved on already: nothing to send for Mandaala's tick.
    const mark = fake.commands().length;
    await drainTodoist(s.userId);
    expect(commandsSince(mark)).toEqual([]);
    later();
    fake.uncomplete(id);
    await deliver();
    expect(await checkinDays(s.userId, s.daily)).toEqual(["2026-10-28"]);
  });

  it("of one tick told twice make one check-in", async () => {
    const s = await synced();
    const id = await taskIdOf(s.userId, s.daily);
    await setCheckin(s.userId, s.daily, "2026-10-28", true);
    later();
    const tick = fake.complete(id);
    await deliver();
    // The same tick as item:completed too, carrying the task as it is after it (due tomorrow).
    const payload = JSON.parse(tick.raw);
    delete payload.event_data_extra;
    const raw = JSON.stringify({ ...payload, event_name: "item:completed" });
    const headers = new Headers({
      "X-Todoist-Hmac-SHA256": createHmac("sha256", "engine-client-secret").update(raw).digest("base64"),
      "X-Todoist-Delivery-ID": crypto.randomUUID(),
    });
    expect(await handleTodoistWebhook(raw, headers)).toBe(200);
    expect(await checkinDays(s.userId, s.daily)).toEqual(["2026-10-28"]);
  });

  it("of one tick told again by item:completed a moment later add no check-in on the next day", async () => {
    const s = await synced();
    const id = await taskIdOf(s.userId, s.daily);
    // To verify on a real account: whether item:completed also fires for a tick. It would carry the
    // task as it is after the tick (due on the next day), stamped a moment after the first notice.
    const twin = (tick: { raw: string }) => {
      const payload = JSON.parse(tick.raw);
      delete payload.event_data_extra;
      payload.triggered_at = new Date(Date.parse(payload.triggered_at) + 1000).toISOString();
      const raw = JSON.stringify({ ...payload, event_name: "item:completed" });
      const headers = new Headers({
        "X-Todoist-Hmac-SHA256": createHmac("sha256", "engine-client-secret").update(raw).digest("base64"),
        "X-Todoist-Delivery-ID": crypto.randomUUID(),
      });
      return { raw, headers };
    };
    later();
    const today = fake.complete(id);
    for (const notice of [today, twin(today)]) expect(await handleTodoistWebhook(notice.raw, notice.headers)).toBe(200);
    expect(await checkinDays(s.userId, s.daily)).toEqual(["2026-10-28"]);
    // Tomorrow's, done early, with the twin coming first.
    later();
    const tomorrow = fake.complete(id);
    for (const notice of [twin(tomorrow), tomorrow]) {
      expect(await handleTodoistWebhook(notice.raw, notice.headers)).toBe(200);
    }
    expect(await checkinDays(s.userId, s.daily)).toEqual(["2026-10-28", "2026-10-29"]);
  });

  it("of a task the person gave a repeat in Todoist mark it done when ticked", async () => {
    const s = await synced();
    const id = await taskIdOf(s.userId, s.task);
    later();
    fake.edit(id, { due: { string: "every other week", date: "2026-11-01" } });
    later();
    fake.complete(id);
    await deliver();
    expect(await getCell(s.userId, s.task)).toMatchObject({ kind: "task", status: "done" });
    expect(fake.task(id)).toMatchObject({ checked: false, due: { string: "every other week" } });
    const mark = fake.commands().length;
    await drainTodoist(s.userId);
    expect(commandsSince(mark)).toEqual([]);
  });

  it("of a routine done for good in Todoist mark it done, and back", async () => {
    const s = await synced();
    const id = await taskIdOf(s.userId, s.daily);
    later();
    fake.completeForever(id);
    await deliver();
    expect((await getCell(s.userId, s.daily)).status).toBe("done");
    expect(await checkinDays(s.userId, s.daily)).toEqual([]);
    later();
    fake.uncomplete(id);
    await deliver();
    expect((await getCell(s.userId, s.daily)).status).toBe("todo");
    expect(await nextTodoistOutbox(s.userId)).toBeNull();
  });

  it("of a task deleted in Todoist take the square out of this week", async () => {
    const s = await synced();
    const id = await taskIdOf(s.userId, s.task);
    later();
    fake.remove(id);
    await deliver();
    expect((await getCell(s.userId, s.task)).active).toBe(false);
    expect((await listTodoistLinks(s.userId)).map((l) => l.cellId)).not.toContain(s.task);
    expect(await nextTodoistOutbox(s.userId)).toBeNull();
  });

  it("of the project deleted leave the chart as it is until it is set up again", async () => {
    const s = await synced();
    const project = fake.projects().find((p) => p.name === "Mandaala")!;
    later();
    fake.removeProject(project.id);
    expect((await deliver()).every((answer) => answer === 200)).toBe(true);
    expect(await getTodoistAccount(s.userId)).toMatchObject({
      status: "project_gone",
      lastError: "The Mandaala project is gone from Todoist.",
    });
    expect((await getCell(s.userId, s.task)).active).toBe(true);
    expect(await listTodoistLinks(s.userId)).toHaveLength(4);

    // Changes wait meanwhile.
    await updateCell(s.userId, s.task, { text: "Buy two lamps" });
    const mark = fake.commands().length;
    await drainTodoist(s.userId);
    expect(commandsSince(mark)).toEqual([]);

    await rebuildTodoist(s.userId);
    await drainTodoist(s.userId);
    expect(await getTodoistAccount(s.userId)).toMatchObject({ status: "ok", lastError: "" });
    const projects = fake.projects().filter((p) => p.name === "Mandaala" && !p.is_deleted);
    expect(projects).toHaveLength(1);
    const open = fake.tasks().filter((t) => !t.is_deleted && t.project_id === projects[0].id);
    expect(open.map((t) => t.content).sort()).toEqual(["Buy two lamps", "Plan the reading", "Read 10 pages", "Visit the library"]);
    // Pressed again: no second project.
    await rebuildTodoist(s.userId);
    expect(fake.projects().filter((p) => p.name === "Mandaala" && !p.is_deleted)).toHaveLength(1);
  });
});

describe("a task Todoist no longer has", () => {
  it("was deleted there: the square leaves this week, as if the lost notice had come", async () => {
    const s = await synced();
    const id = await taskIdOf(s.userId, s.task);
    later();
    fake.remove(id);
    lose();
    await updateCell(s.userId, s.task, { text: "Buy two lamps" });
    await drainTodoist(s.userId);
    expect((await getCell(s.userId, s.task)).active).toBe(false);
    expect((await listTodoistLinks(s.userId)).map((l) => l.cellId)).not.toContain(s.task);
    expect(fake.tasks().filter((t) => !t.is_deleted)).toHaveLength(3);
  });

  it("went with its project: nothing changes in Mandaala", async () => {
    const s = await synced();
    const project = fake.projects().find((p) => p.name === "Mandaala")!;
    later();
    fake.removeProject(project.id);
    lose();
    await updateCell(s.userId, s.task, { text: "Buy two lamps" });
    await drainTodoist(s.userId);
    expect(await getTodoistAccount(s.userId)).toMatchObject({ status: "project_gone" });
    expect((await getCell(s.userId, s.task)).active).toBe(true);
    expect(await nextTodoistOutbox(s.userId)).not.toBeNull();
  });
});

describe("reading a notice", () => {
  it("tells an occurrence done or undone from a task completed, reopened, edited or deleted", () => {
    const routine = fake.add({ content: "Stretch", due: { string: "every day", date: "2026-10-28" } });
    const task = fake.add({ content: "Call mom", due: { date: "2026-10-30" } });
    const read = (webhook: { raw: string }) => eventsFromWebhook(JSON.parse(webhook.raw));
    const at = "2026-10-28T12:00:00.000000Z";
    expect(read(fake.complete(routine.id))).toEqual([
      {
        type: "completed",
        taskId: routine.id,
        at,
        recurring: true,
        forever: false,
        occurrence: "2026-10-28",
        task: expect.objectContaining({ id: routine.id, due: expect.objectContaining({ date: "2026-10-29" }) }),
      },
    ]);
    expect(read(fake.uncomplete(routine.id))).toEqual([
      { type: "uncompleted", taskId: routine.id, at, recurring: true, task: expect.objectContaining({ id: routine.id }) },
    ]);
    expect(read(fake.completeForever(routine.id))).toMatchObject([
      { type: "completed", recurring: true, forever: true, occurrence: null },
    ]);
    expect(read(fake.complete(task.id))).toMatchObject([
      { type: "completed", recurring: false, forever: false, occurrence: "2026-10-30" },
    ]);
    expect(read(fake.uncomplete(task.id))).toMatchObject([{ type: "uncompleted", recurring: false }]);
    expect(read(fake.edit(task.id, { content: "Call dad" }))).toMatchObject([
      { type: "changed", taskId: task.id, task: { content: "Call dad", checked: false } },
    ]);
    expect(read(fake.remove(task.id))).toEqual([{ type: "deleted", taskId: task.id, at }]);
    const inbox = fake.user().inbox_project_id!;
    expect(read(fake.archiveProject(inbox))).toEqual([{ type: "project_gone", projectId: inbox, at }]);
    expect(eventsFromWebhook({ event_name: "note:added", event_data: { id: "1" } })).toEqual([]);
    expect(eventsFromWebhook("nonsense")).toEqual([]);
    // Without triggered_at, the task's own time.
    const late = { event_name: "item:deleted", event_data: { id: 7, updated_at: "2026-10-27T08:00:00Z" } };
    expect(eventsFromWebhook(late)).toEqual([{ type: "deleted", taskId: "7", at: "2026-10-27T08:00:00Z" }]);
  });
});

describe("the catch-up", () => {
  it("reads what lost notices said from the activity log and the incremental sync, once", async () => {
    const s = await synced();
    later();
    fake.complete(await taskIdOf(s.userId, s.daily));
    fake.complete(await taskIdOf(s.userId, s.task));
    fake.edit(await taskIdOf(s.userId, s.sunday), { content: "Plan next week's reading" });
    lose();
    expect(await catchUpTodoist(s.userId, { force: true })).toEqual({ changed: true, synced: true });
    expect((await getTodoistAccount(s.userId))!.lastSyncAt).toBe(new Date().toISOString());
    expect(await checkinDays(s.userId, s.daily)).toEqual(["2026-10-28"]);
    expect((await getCell(s.userId, s.task)).status).toBe("done");
    expect((await getCell(s.userId, s.sunday)).text).toBe("Plan next week's reading");
    expect(await nextTodoistOutbox(s.userId)).toBeNull();

    // Again, and then the lost notices arriving after all: nothing more.
    const state = await loadState(s.userId, "2026-01-01");
    expect(await catchUpTodoist(s.userId, { force: true })).toEqual({ changed: false, synced: true });
    delivered = 0;
    await deliver();
    expect(await loadState(s.userId, "2026-01-01")).toEqual(state);
  });

  it("does not take our own ticks in the activity log for the person's", async () => {
    const s = await synced();
    later();
    await setCheckin(s.userId, s.daily, "2026-10-28", true);
    await updateCell(s.userId, s.task, { status: "done" });
    await updateCell(s.userId, s.sunday, { status: "done" });
    await drainTodoist(s.userId);
    await updateCell(s.userId, s.sunday, { status: "todo" });
    await drainTodoist(s.userId);
    lose();
    const state = await loadState(s.userId, "2026-01-01");
    // Hours later, as the daily job reads it.
    later(6 * 60 * MINUTE);
    expect(await catchUpTodoist(s.userId, { force: true })).toEqual({ changed: false, synced: true });
    expect(await loadState(s.userId, "2026-01-01")).toEqual(state);
    expect(fake.activities().filter((a) => a.event_type === "completed" || a.event_type === "uncompleted")).toHaveLength(4);
  });

  it("does not take a routine done for good, logged at its time in Mandaala, for a tick", async () => {
    const s = await synced();
    const id = await taskIdOf(s.userId, s.daily);
    later(3 * 60 * MINUTE);
    await updateCell(s.userId, s.daily, { status: "done" });
    await drainTodoist(s.userId);
    // As the activity log may tell it: dated when it was done, not when it reached Todoist.
    const at = new Date(Date.now() - 2 * 60 * MINUTE).toISOString();
    const changed = await withTodoist(s.userId, (worker) =>
      applyInbound(worker, [{ type: "completed", taskId: id, at, recurring: true, forever: false, occurrence: null, task: null }]),
    );
    expect(changed).toBe(false);
    expect(await checkinDays(s.userId, s.daily)).toEqual([]);
    expect((await getCell(s.userId, s.daily)).status).toBe("done");
  });

  it("moves a missed daily routine to today once a day, keeping its time", async () => {
    const s = await synced();
    const id = await taskIdOf(s.userId, s.daily);
    later();
    fake.edit(id, { due: { string: "every day at 7am", date: "2026-10-28T07:00:00" } });
    await deliver();
    expect((await getCell(s.userId, s.daily)).repeat).toBe("day");
    vi.setSystemTime(new Date("2026-10-30T09:00:00Z"));
    const mark = fake.commands().length;
    await catchUpTodoist(s.userId, { force: true });
    expect(commandsSince(mark)).toEqual([
      { type: "item_update", args: { id, due: { string: "every day at 7am", date: "2026-10-30T07:00:00", lang: "en" } } },
    ]);
    later();
    await catchUpTodoist(s.userId, { force: true });
    expect(fake.commands()).toHaveLength(mark + 1);
    expect(await deliver()).toEqual([200]);
    expect((await getCell(s.userId, s.daily)).repeat).toBe("day");
  });

  it("runs at most once a minute unless forced, and always sends what waits", async () => {
    const s = await synced();
    const reads = () => fake.requests().filter((r) => r.url.pathname === "/api/v1/activities").length;
    await catchUpTodoist(s.userId);
    const before = reads();
    await updateCell(s.userId, s.task, { text: "Buy two lamps" });
    expect(await catchUpTodoist(s.userId, { timeZone: "America/Sao_Paulo" })).toEqual({ changed: false, synced: true });
    expect(reads()).toBe(before);
    expect((await taskOf(s.userId, s.task)).content).toBe("Buy two lamps");
    expect((await getTodoistAccount(s.userId))!.timeZone).toBe("America/Sao_Paulo");
    await catchUpTodoist(s.userId, { timeZone: "Not/A_Zone" });
    expect((await getTodoistAccount(s.userId))!.timeZone).toBe("America/Sao_Paulo");
    later(MINUTE);
    await catchUpTodoist(s.userId);
    expect(reads()).toBe(before + 1);
  });

  it("sends a tick that waited overnight before it moves missed routines to today", async () => {
    const s = await synced();
    const id = await taskIdOf(s.userId, s.daily);
    // Ticked in the evening, while Todoist does not answer.
    vi.setSystemTime(new Date("2026-10-28T18:00:00Z"));
    fake.failNext(1, 503, { path: "/api/v1/sync" });
    await setCheckin(s.userId, s.daily, "2026-10-28", true);
    await drainTodoist(s.userId);
    expect(fake.task(id)!.due!.date).toBe("2026-10-28");

    // The daily job the next morning: Todoist records the tick, and nothing is left to roll over.
    vi.setSystemTime(new Date("2026-10-29T06:17:00Z"));
    const mark = fake.commands().length;
    expect(await catchUpTodoist(s.userId, { force: true })).toEqual({ changed: false, synced: true });
    expect(commandsSince(mark)).toEqual([
      {
        type: "item_update_date_complete",
        args: { id, due: { date: "2026-10-29", string: "every day", lang: "en" }, is_forward: 1 },
      },
    ]);
    expect(fake.activities().filter((a) => a.object_id === id && a.event_type === "completed")).toHaveLength(1);
    expect(await nextTodoistOutbox(s.userId)).toBeNull();
  });

  it("says it could not sync while Todoist does not answer, and why, until it answers again", async () => {
    const s = await synced();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const status of [503, 429, 0]) {
      fake.failNext(1, status, { path: "/api/v1/activities" });
      expect(await catchUpTodoist(s.userId, { force: true })).toEqual({ changed: false, synced: false });
      expect((await getTodoistAccount(s.userId))!.lastError).toMatch(/^Todoist is not answering right now/);
      expect(await catchUpTodoist(s.userId, { force: true })).toEqual({ changed: false, synced: true });
      expect((await getTodoistAccount(s.userId))!.lastError).toBe("");
    }
    quiet.mockRestore();
    // Another worker busy all along: no answer at all.
    await claimTodoistLease(s.userId, "another-worker", Date.now() + MINUTE, Date.now());
    const busy = catchUpTodoist(s.userId, { force: true });
    setTimeout(() => later(6000), 300);
    expect(await busy).toBeNull();
    await releaseTodoistLease(s.userId, "another-worker");
  });

  it("says it could not sync when Todoist reads fine but does not take the changes", async () => {
    const s = await synced();
    expect(await catchUpTodoist(s.userId, { force: true })).toEqual({ changed: false, synced: true });
    await updateCell(s.userId, s.task, { text: "Renamed while Todoist is down" });
    // Within the minute the catch-up reads nothing and only sends, and the send fails.
    fake.failNext(1, 503, { path: "/api/v1/sync" });
    const result = await catchUpTodoist(s.userId);
    expect(result).toEqual({ changed: false, synced: false });
    expect((await getTodoistAccount(s.userId))!.lastError).toMatch(/^Todoist is not answering right now/);
    expect(await nextTodoistOutbox(s.userId)).not.toBeNull();
  });

  it("runs for every connected account in the daily job", async () => {
    const a = await synced();
    const b = await synced();
    later();
    fake.complete(await taskIdOf(a.userId, a.task));
    fake.complete(await taskIdOf(b.userId, b.task));
    lose();
    // Accounts of earlier tests are connected to Todoists that are gone: they ask for a new sign-in.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const { accounts } = await runTodoistDaily();
    quiet.mockRestore();
    expect(accounts).toBeGreaterThanOrEqual(2);
    expect((await getCell(a.userId, a.task)).status).toBe("done");
    expect((await getCell(b.userId, b.task)).status).toBe("done");
  });
});

describe("the webhook", () => {
  const sign = (raw: string) => createHmac("sha256", "engine-client-secret").update(raw).digest("base64");

  it("checks Todoist's signature in constant time", () => {
    expect(verifyTodoistSignature("{}", sign("{}"), "engine-client-secret")).toBe(true);
    expect(verifyTodoistSignature("{} ", sign("{}"), "engine-client-secret")).toBe(false);
    expect(verifyTodoistSignature("{}", sign("{}"), "another-secret")).toBe(false);
    expect(verifyTodoistSignature("{}", null, "engine-client-secret")).toBe(false);
    expect(verifyTodoistSignature("{}", "short", "engine-client-secret")).toBe(false);
  });

  it("refuses what Todoist did not sign or cannot be read, and is off without an app", async () => {
    const s = await synced();
    later();
    const { raw, headers } = fake.complete(await taskIdOf(s.userId, s.task));
    const forged = new Headers(headers);
    forged.set("X-Todoist-Hmac-SHA256", sign("something else"));
    expect(await handleTodoistWebhook(raw, forged)).toBe(401);
    expect(await handleTodoistWebhook(raw.replace("Buy", "Sell"), headers)).toBe(401);
    expect(await handleTodoistWebhook("not json", new Headers({ "X-Todoist-Hmac-SHA256": sign("not json") }))).toBe(400);
    vi.stubEnv("TODOIST_CLIENT_SECRET", "");
    expect(await handleTodoistWebhook(raw, headers)).toBe(404);
    vi.unstubAllEnvs();
    expect((await getCell(s.userId, s.task)).status).toBe("todo");
    expect(await handleTodoistWebhook(raw, headers)).toBe(200);
    expect((await getCell(s.userId, s.task)).status).toBe("done");
  });

  it("applies a delivery once, ignores Todoist users not connected, and asks again while the account is busy", async () => {
    const s = await synced();
    later();
    const notice = fake.complete(await taskIdOf(s.userId, s.task));
    await claimTodoistLease(s.userId, "another-worker", Date.now() + MINUTE, Date.now());
    const busy = handleTodoistWebhook(notice.raw, notice.headers);
    // Time passes while it waits for the lease.
    setTimeout(() => later(9000), 300);
    expect(await busy).toBe(503);
    expect((await getCell(s.userId, s.task)).status).toBe("todo");
    await releaseTodoistLease(s.userId, "another-worker");
    expect(await handleTodoistWebhook(notice.raw, notice.headers)).toBe(200);
    expect((await getCell(s.userId, s.task)).status).toBe("done");

    // The same delivery again: answered, not applied again.
    later();
    await updateCell(s.userId, s.task, { status: "todo" });
    expect(await handleTodoistWebhook(notice.raw, notice.headers)).toBe(200);
    expect((await getCell(s.userId, s.task)).status).toBe("todo");

    const stranger = fake.add({ content: "Not ours", userId: "stranger" });
    const theirs = fake.complete(stranger.id);
    expect(await handleTodoistWebhook(theirs.raw, theirs.headers)).toBe(200);
  });
});

describe("connecting", () => {
  it("takes only an answer meant for this account, and tells a no apart", async () => {
    const user = await newAccount();
    const other = await newAccount();
    fake.addUser({ id: "t-1", email: "me@todoist.test", timeZone: "Europe/Lisbon", startDay: 7 });
    const { url, cookie } = startTodoistConnect(user.id, ORIGIN);
    expect(new URL(url).searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/todoist/callback`);
    const { code, state } = fake.approve(url, "t-1");
    const finish = (userId: string, changes: { cookie?: string; state?: string; error?: string } = {}) =>
      finishTodoistConnect(userId, { code, state, error: null, cookie, origin: ORIGIN, ...changes });
    expect(await finish(user.id, { error: "access_denied" })).toBe("denied");
    expect(await finish(user.id, { cookie: "" })).toBe("error");
    expect(await finish(user.id, { state: "another-state" })).toBe("error");
    expect(await finish(other.id)).toBe("error");
    const tampered = cookie.slice(0, -1) + (cookie.endsWith("A") ? "B" : "A");
    expect(await finish(user.id, { cookie: tampered })).toBe("error");
    expect(await getTodoistAccount(user.id)).toBeNull();

    expect(await finish(user.id)).toBe("connected");
    const account = (await getTodoistAccount(user.id))!;
    expect(account).toMatchObject({
      todoistUserId: "t-1",
      email: "me@todoist.test",
      timeZone: "Europe/Lisbon",
      weekStart: 7,
      status: "ok",
      appUrl: ORIGIN,
      projectId: fake.projects().find((p) => p.name === "Mandaala")!.id,
      syncToken: expect.any(String),
    });
    expect(account.accessToken).not.toContain(".access");
    expect((await dueTodoistOutbox(user.id, Date.now(), 10)).map((row) => row.kind)).toEqual(["all"]);
  });

  it("takes an answer only within 10 minutes of asking", async () => {
    const user = await newAccount();
    fake.addUser({ id: "slow" });
    const late = startTodoistConnect(user.id, ORIGIN);
    const { code, state } = fake.approve(late.url, "slow");
    later(10 * MINUTE + 1000);
    expect(await finishTodoistConnect(user.id, { code, state, error: null, cookie: late.cookie, origin: ORIGIN })).toBe("error");
    expect(await getTodoistAccount(user.id)).toBeNull();
    // Refused before anything was asked of Todoist with the app's secret.
    expect(fake.requests().filter((r) => r.url.pathname === "/oauth/access_token")).toEqual([]);

    const timely = startTodoistConnect(user.id, ORIGIN);
    const approved = fake.approve(timely.url, "slow");
    later(9 * MINUTE);
    const answer = { code: approved.code, state: approved.state, error: null, cookie: timely.cookie, origin: ORIGIN };
    expect(await finishTodoistConnect(user.id, answer)).toBe("connected");
  });

  it("does not take a Todoist account linked to another account, nor cut that one off", async () => {
    const alex = await newAccount();
    const bea = await newAccount();
    await connect(alex.id, "shared");
    const { url, cookie } = startTodoistConnect(bea.id, ORIGIN);
    const { code, state } = fake.approve(url, "shared");
    expect(await finishTodoistConnect(bea.id, { code, state, error: null, cookie, origin: ORIGIN })).toBe("taken");
    expect(await getTodoistAccount(bea.id)).toBeNull();
    expect(fake.requests().filter((r) => r.url.pathname === "/api/v1/revoke")).toEqual([]);
    await chart(alex.id);
    await drainTodoist(alex.id);
    expect(fake.tasks().filter((t) => !t.is_deleted)).toHaveLength(4);
  });

  it("keeps the project, the tasks and the catch-up point when the same Todoist user connects again", async () => {
    const s = await synced();
    fake.revokeApp(s.todoistUserId);
    await updateCell(s.userId, s.task, { text: "Buy two lamps" });
    later(2 * 60 * MINUTE);
    await drainTodoist(s.userId);
    const asked = (await getTodoistAccount(s.userId))!;
    expect(asked).toMatchObject({ status: "reauth", lastError: "Todoist asked you to connect again." });
    expect(await nextTodoistOutbox(s.userId)).not.toBeNull();
    const links = await listTodoistLinks(s.userId);

    await connect(s.userId, s.todoistUserId);
    expect(await getTodoistAccount(s.userId)).toMatchObject({
      status: "ok",
      lastError: "",
      projectId: asked.projectId,
      syncToken: asked.syncToken,
      activitySince: asked.activitySince,
    });
    expect(await listTodoistLinks(s.userId)).toEqual(links);
    const mark = fake.commands().length;
    await drainTodoist(s.userId);
    expect(commandsSince(mark)).toEqual([
      { type: "item_update", args: { id: await taskIdOf(s.userId, s.task), content: "Buy two lamps" } },
    ]);
  });

  it("finds the tasks it made before a disconnect instead of making them again", async () => {
    const s = await synced();
    await disconnectTodoist(s.userId);
    await updateCell(s.userId, s.task, { text: "Buy two lamps" });
    await connect(s.userId, s.todoistUserId);
    const mark = fake.commands().length;
    await drainTodoist(s.userId);
    expect(fake.tasks().filter((t) => !t.is_deleted)).toHaveLength(4);
    expect(fake.projects().filter((p) => p.name === "Mandaala")).toHaveLength(1);
    expect(fake.sections()).toHaveLength(1);
    expect(commandsSince(mark)).toEqual([
      { type: "item_update", args: { id: await taskIdOf(s.userId, s.task), content: "Buy two lamps" } },
    ]);
  });

  it("after a disconnect, brings Todoist up to date: a routine ticked meanwhile moves on, a task done is completed", async () => {
    const s = await synced();
    const routine = await taskIdOf(s.userId, s.daily);
    const task = await taskIdOf(s.userId, s.task);
    await disconnectTodoist(s.userId);
    later();
    await setCheckin(s.userId, s.daily, "2026-10-28", true);
    await updateCell(s.userId, s.task, { status: "done" });
    const { doneAt } = await getCell(s.userId, s.task);
    await connect(s.userId, s.todoistUserId);
    const mark = fake.commands().length;
    await drainTodoist(s.userId);
    expect(commandsSince(mark)).toEqual([
      {
        type: "item_update_date_complete",
        args: { id: routine, due: { date: "2026-10-29", string: "every day", lang: "en" }, is_forward: 1 },
      },
      { type: "item_complete", args: { id: task, date_completed: doneAt } },
    ]);
    expect(fake.task(task)!.checked).toBe(true);
    // Todoist's notices of that are known for ours: still the one check-in.
    expect((await deliver()).every((answer) => answer === 200)).toBe(true);
    expect(await checkinDays(s.userId, s.daily)).toEqual(["2026-10-28"]);
    expect(await nextTodoistOutbox(s.userId)).toBeNull();
  });

  it("gives a link made again its own command ids, so Todoist runs an update it ran once before", async () => {
    const s = await synced();
    const id = await taskIdOf(s.userId, s.task);
    later();
    await updateCell(s.userId, s.task, { text: "Buy two lamps" });
    await drainTodoist(s.userId);
    later();
    fake.edit(id, { content: "Buy a desk lamp" });
    lose();
    await disconnectTodoist(s.userId);
    later();
    await connect(s.userId, s.todoistUserId);
    // Linked again from scratch: the same update as before, which Todoist must not skip.
    await drainTodoist(s.userId);
    expect(fake.task(id)!.content).toBe("Buy two lamps");
    expect(fake.commands().filter((c) => c.type === "item_update").map((c) => c.repeated)).toEqual([false, false]);
  });

  it("puts everything in the Inbox when the plan allows no more projects", async () => {
    const user = await newAccount();
    await chart(user.id);
    fake.addUser({ id: "full", maxProjects: 0 });
    await connect(user.id, "full");
    await drainTodoist(user.id);
    const inbox = fake.user("full").inbox_project_id;
    expect((await getTodoistAccount(user.id))!.projectId).toBe(inbox);
    expect(fake.sections().map((section) => [section.name, section.project_id])).toEqual([["Read 20 books", inbox]]);
    expect(fake.tasks().filter((t) => t.project_id === inbox)).toHaveLength(4);
  });

  it("makes a project of the person's own rather than use a shared or team project named Mandaala", async () => {
    const user = await newAccount();
    await chart(user.id);
    const todoistUserId = crypto.randomUUID();
    fake.addUser({ id: todoistUserId });
    const grant = fake.grant(todoistUserId);
    const client = todoistApi({ token: async () => grant.accessToken, refresh: async () => grant.accessToken });
    const addProject = async () => {
      const command = { type: "project_add", uuid: crypto.randomUUID(), temp_id: crypto.randomUUID(), args: { name: "Mandaala" } };
      return (await client.sync({ commands: [command] })).temp_id_mapping![command.temp_id];
    };
    const shared = await addProject();
    const team = await addProject();
    // As Todoist lists a project shared with someone else, and one in a team workspace.
    const others: Record<string, object> = { [shared]: { shared: true }, [team]: { shared: false, workspace_id: "123" } };
    setTodoistFetch(async (input, init) => {
      const response = await fake.fetch(input, init);
      if (!String(input).endsWith("/api/v1/sync")) return response;
      const body = await response.json();
      for (const project of body.projects ?? []) Object.assign(project, others[project.id]);
      return Response.json(body, { status: response.status });
    });
    await connect(user.id, todoistUserId);
    await drainTodoist(user.id);
    const { projectId } = (await getTodoistAccount(user.id))!;
    expect([shared, team]).not.toContain(projectId);
    expect(fake.projects().find((p) => p.id === projectId)).toMatchObject({ name: "Mandaala" });
    const open = fake.tasks().filter((t) => !t.is_deleted);
    expect(open).toHaveLength(4);
    expect(open.every((t) => t.project_id === projectId)).toBe(true);
    expect(fake.sections().every((section) => section.project_id === projectId)).toBe(true);
  });

  it("starts over with another Todoist user, revoking the old one's token", async () => {
    const s = await synced();
    const old = openToken((await getTodoistAccount(s.userId))!.accessToken);
    await connect(s.userId, "someone-else");
    expect(await listTodoistLinks(s.userId)).toEqual([]);
    const api = todoistApi({ token: async () => old, refresh: async () => old });
    await expect(api.user()).rejects.toMatchObject({ status: 401 });
    await drainTodoist(s.userId);
    const theirs = fake.tasks().filter((t) => t.user_id === "someone-else" && !t.is_deleted);
    expect(theirs).toHaveLength(4);
  });

  it("disconnecting revokes the token and forgets the connection, leaving the tasks in Todoist", async () => {
    const s = await synced();
    const token = openToken((await getTodoistAccount(s.userId))!.accessToken);
    await disconnectTodoist(s.userId);
    expect(await getTodoistAccount(s.userId)).toBeNull();
    expect(await listTodoistLinks(s.userId)).toEqual([]);
    expect(fake.tasks().filter((t) => !t.is_deleted)).toHaveLength(4);
    const api = todoistApi({ token: async () => token, refresh: async () => token });
    await expect(api.user()).rejects.toMatchObject({ status: 401 });
    await expect(disconnectTodoist(s.userId)).resolves.toBeUndefined();
  });

  it("revoking never throws, even with a token that cannot be opened", async () => {
    const s = await synced();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await updateTodoistAccount(s.userId, { accessToken: "v1.broken.token" });
    await expect(revokeTodoist(s.userId)).resolves.toBeUndefined();
    fake.failNext(1, 0);
    await expect(revokeTodoist(s.userId)).resolves.toBeUndefined();
    quiet.mockRestore();
  });

  it("shows the connection on the account page, without reading anything for an account never connected", async () => {
    const s = await synced();
    expect(await todoistInfo({ id: s.userId, todoist: true })).toEqual({
      available: true,
      connected: true,
      status: "ok",
      email: `todoist-${s.todoistUserId}@example.com`,
      lastSyncAt: expect.any(String),
      error: "",
    });
    expect(await todoistInfo({ id: s.userId, todoist: false })).toEqual({
      available: true,
      connected: false,
      status: null,
      email: "",
      lastSyncAt: null,
      error: "",
    });
    vi.stubEnv("TODOIST_CLIENT_ID", "");
    expect((await todoistInfo({ id: s.userId, todoist: true })).available).toBe(false);
  });
});

describe("the token key", () => {
  it("that cannot be built stops the work, without asking the person to connect again", async () => {
    const s = await synced();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    // A TODOIST_TOKEN_KEY of the wrong length, then production without any secret.
    vi.stubEnv("TODOIST_TOKEN_KEY", randomBytes(9).toString("base64"));
    expect(await catchUpTodoist(s.userId, { force: true })).toEqual({ changed: false, synced: false });
    vi.unstubAllEnvs();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "");
    expect(await catchUpTodoist(s.userId, { force: true })).toEqual({ changed: false, synced: false });
    vi.unstubAllEnvs();
    quiet.mockRestore();
    expect(await getTodoistAccount(s.userId)).toMatchObject({ status: "ok", lastError: "" });
    // Set up right again, the same tokens work.
    await updateCell(s.userId, s.task, { text: "Buy two lamps" });
    await drainTodoist(s.userId);
    expect((await taskOf(s.userId, s.task)).content).toBe("Buy two lamps");
  });

  it("that does not open the stored token asks the person to connect again", async () => {
    const s = await synced();
    vi.stubEnv("TODOIST_TOKEN_KEY", randomBytes(32).toString("base64"));
    const foreign = sealToken("sealed-with-another-key");
    vi.unstubAllEnvs();
    await updateTodoistAccount(s.userId, { accessToken: foreign });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await catchUpTodoist(s.userId, { force: true })).toEqual({ changed: false, synced: false });
    quiet.mockRestore();
    expect(await getTodoistAccount(s.userId)).toMatchObject({
      status: "reauth",
      lastError: "Todoist asked you to connect again.",
    });
  });
});

describe("one worker per account", () => {
  it("lets two drains at once send each command once", async () => {
    const user = await newAccount();
    await chart(user.id);
    await connect(user.id);
    await Promise.all([drainTodoist(user.id), drainTodoist(user.id), drainTodoist(user.id)]);
    expect(fake.commands().filter((c) => c.type === "item_add")).toHaveLength(4);
    expect(fake.commands().filter((c) => c.repeated)).toEqual([]);
    expect(fake.tasks().filter((t) => !t.is_deleted)).toHaveLength(4);
  });

  it("takes no lease when nothing is due, and sends nothing while another worker holds it", async () => {
    const s = await synced();
    await claimTodoistLease(s.userId, "another-worker", Date.now() + MINUTE, Date.now());
    const requests = fake.requests().length;
    // Nothing due: back at once, without waiting for the lease.
    await drainTodoist(s.userId);
    await updateCell(s.userId, s.task, { text: "Buy two lamps" });
    const busy = drainTodoist(s.userId);
    setTimeout(() => later(4000), 300);
    await busy;
    expect(fake.requests()).toHaveLength(requests);
    expect(await nextTodoistOutbox(s.userId)).not.toBeNull();
    await releaseTodoistLease(s.userId, "another-worker");
    await drainTodoist(s.userId);
    expect((await taskOf(s.userId, s.task)).content).toBe("Buy two lamps");
  });
});
