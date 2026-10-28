import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cellIdFrom, describe as withFooter, notesFrom, squareLink } from "@/domain/todoist";
import type { CellPatch, Repeat } from "@/domain/types";
import { getDb } from "@/server/db";
import {
  claimTodoistLease,
  createGoal,
  deleteGoal,
  deleteTodoistData,
  dueTodoistOutbox,
  getCell,
  listTodoistLinks,
  listTodoistSections,
  loadState,
  nextTodoistOutbox,
  queueTodoist,
  recordTodoistDelivery,
  releaseTodoistLease,
  setCheckin,
  todoistDeliverySeen,
  updateCell,
  updateCells,
  updateGoal,
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
import { commandId, setTodoistFetch, todoistApi, type SyncCommand } from "@/server/todoist/api";
import { deleteUser } from "@/server/users";
import { newAccount } from "../support/accounts";
import {
  FakeTodoist,
  type DueInput,
  type FakeTask,
  type FakeUserOptions,
  type FakeWebhook,
} from "../support/fake-todoist";

process.env.TODOIST_CLIENT_ID = "test-client-id";
process.env.TODOIST_CLIENT_SECRET = "test-client-secret";

// The whole Todoist sync, end to end: the app's repo functions on one side, the fake Todoist on the
// other, and the engine in between, driven the way the app drives it. 2026-10-25 is a Sunday, so
// TODAY is a Wednesday. The clock sits at noon UTC: the same day in UTC and wherever the tests run.

const APP = "https://mandaala.test";
const TODAY = "2026-10-28";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let fake: FakeTodoist;
/** Mandaala accounts the running test made. */
let accounts: string[] = [];

beforeEach(() => {
  // Only Date: the lease waits with real timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  at(TODAY);
  fake = new FakeTodoist();
  setTodoistFetch(fake.fetch);
});

afterEach(async () => {
  // Each test forgets its connections, so the daily job in a later test meets only its own accounts.
  for (const userId of accounts) await deleteTodoistData(userId);
  accounts = [];
  setTodoistFetch(null);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ---------- time ----------

/** Sets the clock to a day, at noon UTC unless a time is given. */
function at(day: string, time = "12:00"): void {
  vi.setSystemTime(new Date(`${day}T${time}:00Z`));
}

function later(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

/** Moves the clock on while `work` waits for a lease: only Date is fake, so it would wait forever. */
async function whileTimePasses<T>(work: Promise<T>): Promise<T> {
  let settled = false;
  const settle = () => {
    settled = true;
  };
  work.then(settle, settle);
  while (!settled) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    later(1000);
  }
  return work;
}

// ---------- people, goals and connections ----------

interface Person {
  userId: string;
  todoistUserId: string;
}

/** A new Mandaala account with a Todoist user of its own: a Todoist user connects to one account only. */
async function person(options: Omit<FakeUserOptions, "id"> = {}): Promise<Person> {
  const user = await newAccount();
  accounts.push(user.id);
  const todoistUserId = crypto.randomUUID();
  fake.addUser({ ...options, id: todoistUserId });
  return { userId: user.id, todoistUserId };
}

/** Connects the way the app does: Todoist's approval page, then the callback. */
async function connect({ userId, todoistUserId }: Person) {
  const { url, cookie } = startTodoistConnect(userId, APP);
  const { code, state } = fake.approve(url, todoistUserId);
  return finishTodoistConnect(userId, { code, state, error: null, cookie, origin: APP });
}

/** Connects, then sends everything, as the callback's after() does. */
async function connectAndSend(someone: Person): Promise<void> {
  expect(await connect(someone)).toBe("connected");
  await drainTodoist(someone.userId);
}

interface Square {
  text: string;
  /** A task (the default), or how often a routine repeats. */
  how?: "task" | Repeat;
  /** The weekday (0 = Sunday) or the day of the month of a weekly or monthly routine. */
  on?: number;
  notes?: string;
  impact?: number;
  effort?: number;
  helps?: number[];
  /** Picked for this week (the default). */
  picked?: boolean;
  /** Pillar 0, "Skin" (the default), or 1, "Fitness". */
  pillar?: number;
}

/** A goal holding these squares, in slot order within their pillar. `ids` maps each square's text to its id. */
async function makeGoal(userId: string, title: string, squares: Square[]) {
  const goal = await createGoal(userId, { title, pillars: ["Skin", "Fitness"] });
  const ids: Record<string, string> = {};
  const updates = squares.map((square) => {
    const pillar = square.pillar ?? 0;
    const slot = squares.filter((other) => (other.pillar ?? 0) === pillar).indexOf(square);
    const cell = goal.cells.find((c) => c.pillar === pillar && c.slot === slot)!;
    ids[square.text] = cell.id;
    const patch: CellPatch = {
      text: square.text,
      notes: square.notes ?? "",
      kind: "task",
      active: square.picked ?? true,
      impact: square.impact ?? null,
      effort: square.effort ?? null,
      helps: square.helps ?? [],
    };
    if (square.how && square.how !== "task") {
      Object.assign(patch, { kind: "habit", repeat: square.how, repeatOn: square.on ?? null });
    }
    return { id: cell.id, patch };
  });
  await updateCells(userId, updates);
  const pillarIds = [0, 1].map((p) => goal.cells.find((c) => c.pillar === p && c.slot === -1)!.id);
  return { goalId: goal.id, ids, pillarIds };
}

/** A connected account whose goal "LOOKSMAXXING" holds these squares, all already sent to Todoist. */
async function setup(squares: Square[], options: Omit<FakeUserOptions, "id"> = {}) {
  const someone = await person(options);
  const goal = await makeGoal(someone.userId, "LOOKSMAXXING", squares);
  await connectAndSend(someone);
  return { ...someone, ...goal };
}

const info = (userId: string) => todoistInfo({ id: userId, todoist: true });

// ---------- what Todoist holds ----------

/** The square's one Todoist task that is not deleted, found by the square's link in its description. */
function taskOf(cellId: string): FakeTask {
  const found = tasksOf(cellId).filter((task) => !task.is_deleted);
  expect(found, `Todoist tasks of square ${cellId}`).toHaveLength(1);
  return found[0];
}

/** Every Todoist task of a square, deleted ones too. */
function tasksOf(cellId: string): FakeTask[] {
  return fake.tasks().filter((task) => cellIdFrom(task.description, APP) === cellId);
}

/** Projects named Mandaala that are not deleted (each test has a Todoist of its own). */
function mandaalaProjects() {
  return fake.projects().filter((project) => project.name === "Mandaala" && !project.is_deleted);
}

function openSections() {
  return fake.sections().filter((section) => !section.is_deleted && !section.is_archived);
}

function sectionById(id: string) {
  return fake.sections().find((section) => section.id === id);
}

/** Commands of one type that Todoist ran (a repeated uuid is answered but not run again). */
function ran(type: string) {
  return fake.commands().filter((command) => command.type === type && !command.repeated && command.status === "ok");
}

/** The commands of each /sync request that reached Todoist's address, failed ones too. */
function syncRequests(): SyncCommand[][] {
  return fake
    .requests()
    .filter((request) => request.url.pathname === "/api/v1/sync")
    .map((request) => new URLSearchParams(request.body).get("commands"))
    .filter((commands): commands is string => commands !== null)
    .map((commands) => JSON.parse(commands) as SyncCommand[]);
}

function revokes(): number {
  return fake.requests().filter((request) => request.url.pathname === "/api/v1/revoke").length;
}

function refreshes(): number {
  return fake
    .requests()
    .filter((request) => request.url.pathname === "/oauth/access_token")
    .filter((request) => new URLSearchParams(request.body).get("grant_type") === "refresh_token").length;
}

/** Runs a command in Todoist as the person, for what the fake has no helper for. */
async function asPerson(todoistUserId: string, command: Omit<SyncCommand, "uuid">): Promise<void> {
  const token = fake.grant(todoistUserId).accessToken;
  const api = todoistApi({ token: async () => token, refresh: async () => token });
  await api.sync({ commands: [{ ...command, uuid: crypto.randomUUID() }] });
}

/** Holds Todoist's answers to requests on this path until `go()`. `reached` settles when the first one comes. */
function holdAnswers(path: string): { reached: Promise<void>; go: () => void } {
  let go!: () => void;
  let reach!: () => void;
  const held = new Promise<void>((resolve) => (go = resolve));
  const reached = new Promise<void>((resolve) => (reach = resolve));
  setTodoistFetch(async (input, init) => {
    if (new URL(input instanceof Request ? input.url : String(input)).pathname === path) {
      reach();
      await held;
    }
    return fake.fetch(input, init);
  });
  return { reached, go };
}

/** The next /sync request carrying a command of this type runs in Todoist, but its answer is lost. */
function loseAnswerTo(type: string): void {
  setTodoistFetch(async (input, init) => {
    const response = await fake.fetch(input, init);
    const commands = new URLSearchParams(String(init?.body ?? "")).get("commands");
    if (commands && (JSON.parse(commands) as SyncCommand[]).some((command) => command.type === type)) {
      setTodoistFetch(fake.fetch);
      throw new TypeError("fetch failed");
    }
    return response;
  });
}

// ---------- Todoist's notices ----------

/** Delivers notices one by one, as Todoist POSTs them, and returns the app's answers. */
async function deliver(...notices: FakeWebhook[]): Promise<number[]> {
  const answers: number[] = [];
  for (const notice of notices) answers.push(await handleTodoistWebhook(notice.raw, notice.headers));
  return answers;
}

/** The answers when every notice is taken. */
const allOk = (notices: unknown[]) => notices.map(() => 200);

/**
 * Delivers Todoist's notices of our own changes one at a time and runs `unchanged` after each, so a
 * late "done" cannot hide behind the "undone" that follows it. Todoist stamps a notice by its own
 * clock, a moment after our command reached it, so each one carries a time a few seconds later.
 */
async function deliverEach(notices: FakeWebhook[], unchanged: () => Promise<void>): Promise<void> {
  expect(notices.length).toBeGreaterThan(0);
  for (const notice of notices) {
    expect(await deliver(stampedLater(notice, 5_000))).toEqual([200]);
    await unchanged();
  }
}

/** The notice as Todoist would send it `ms` later by its clock (Todoist's format: six fraction digits). */
function stampedLater(notice: FakeWebhook, ms: number): FakeWebhook {
  const payload = JSON.parse(notice.raw);
  payload.triggered_at = new Date(Date.parse(payload.triggered_at) + ms).toISOString().replace("Z", "000Z");
  return signed(JSON.stringify(payload));
}

/** Notices Todoist sent after the first `count`: the person's changes and its notices of ours alike. */
function noticesSince(count: number): FakeWebhook[] {
  return fake.webhooks().slice(count);
}

/** The same notice once more under a new delivery id, as when Todoist sends one twice. */
function again(notice: FakeWebhook): FakeWebhook {
  const headers = new Headers(notice.headers);
  headers.set("X-Todoist-Delivery-ID", crypto.randomUUID());
  return { raw: notice.raw, headers };
}

/** A notice with this body, signed the way Todoist signs one. */
function signed(raw: string): FakeWebhook {
  const headers = new Headers({
    "X-Todoist-Hmac-SHA256": createHmac("sha256", "test-client-secret").update(raw).digest("base64"),
    "X-Todoist-Delivery-ID": crypto.randomUUID(),
  });
  return { raw, headers };
}

const eventName = (notice: FakeWebhook) => JSON.parse(notice.raw).event_name as string;

// ---------- what Mandaala holds ----------

async function checkins(userId: string, cellId: string): Promise<string[]> {
  const { checkins } = await loadState(userId, "2000-01-01");
  return checkins.filter((checkin) => checkin.cellId === cellId).map((checkin) => checkin.day).sort();
}

/** Runs `work` while another worker holds the account's lease. */
async function whileBusy(userId: string, work: () => Promise<void>): Promise<void> {
  const now = Date.now();
  expect(await claimTodoistLease(userId, "another-worker", now + MINUTE, now)).toBe(true);
  try {
    await work();
  } finally {
    await releaseTodoistLease(userId, "another-worker");
  }
}

/**
 * Runs `work` while the database refuses one kind of write, as when it fails for a moment: a trigger
 * on `when` ("BEFORE UPDATE ON cells", say) aborts it.
 */
async function whileFailing(when: string, work: () => Promise<void>): Promise<void> {
  const db = await getDb();
  await db.execute(`CREATE TRIGGER failing ${when} BEGIN SELECT RAISE(ABORT, 'The database failed.'); END`);
  // The webhook logs what failed.
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await work();
  } finally {
    quiet.mockRestore();
    await db.execute("DROP TRIGGER failing");
  }
}

/** The account's rows in the Todoist tables: connection, links, sections and queued changes. */
async function todoistRows(userId: string): Promise<number> {
  const db = await getDb();
  let rows = 0;
  for (const table of ["todoist_accounts", "todoist_links", "todoist_sections", "todoist_outbox"]) {
    const result = await db.execute({ sql: `SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, args: [userId] });
    rows += Number(result.rows[0].n);
  }
  return rows;
}

// ---------- tests ----------

describe("connecting", () => {
  it("makes one Mandaala project and sends what Today shows, nothing else", async () => {
    const someone = await person();
    const { userId } = someone;
    at("2026-10-20"); // a Tuesday: the first picks
    const looks = await makeGoal(userId, "LOOKSMAXXING", [
      { text: "Wash face", how: "day", notes: "Gentle cleanser, cold water", impact: 3, effort: 1 },
      { text: "Drink water", how: "day" },
      { text: "Cut nails", how: "week", on: 0 },
      { text: "Trim beard", how: "week", on: 1, picked: false },
      { text: "Try retinol", picked: false },
      { text: "Pay the gym", how: "month", on: 31, pillar: 1, picked: false },
      { text: "Buy running shoes", pillar: 1, impact: 3, effort: 1, helps: [0], picked: false },
      { text: "Book a haircut", pillar: 1, picked: false },
    ]);
    const run = await makeGoal(userId, "Run a marathon", [{ text: "Run 5 km", how: "day" }]);
    const old = await makeGoal(userId, "Old goal", [{ text: "Old routine", how: "day" }]);
    at(TODAY);
    const picks = ["Trim beard", "Pay the gym", "Buy running shoes", "Book a haircut"];
    await updateCells(userId, picks.map((text) => ({ id: looks.ids[text], patch: { active: true } })));
    await updateCell(userId, looks.ids["Book a haircut"], { status: "done" }); // done already: not on Today
    await setCheckin(userId, looks.ids["Wash face"], TODAY, true); // already ticked today
    await updateCell(userId, looks.pillarIds[0], { active: true }); // a pillar never goes, even picked
    await updateGoal(userId, old.goalId, { status: "archived" });

    expect(await connect(someone)).toBe("connected");
    expect(mandaalaProjects()).toHaveLength(1);
    await drainTodoist(userId);

    const [project] = mandaalaProjects();
    const sections = Object.fromEntries(openSections().map((section) => [section.name, section]));
    expect(Object.keys(sections).sort()).toEqual(["LOOKSMAXXING", "Run a marathon"]);
    const sent = fake.tasks().filter((task) => !task.is_deleted);
    expect(sent.map((task) => task.content).sort()).toEqual([
      "Buy running shoes",
      "Cut nails",
      "Drink water",
      "Pay the gym",
      "Run 5 km",
      "Trim beard",
      "Wash face",
    ]);
    const task = (text: string) => taskOf(looks.ids[text]);
    const where = (section: string) => ({ project_id: project.id, section_id: sections[section].id, checked: false });
    for (const text of ["Wash face", "Drink water", "Cut nails", "Trim beard", "Pay the gym", "Buy running shoes"]) {
      expect(task(text)).toMatchObject(where("LOOKSMAXXING"));
    }
    expect(taskOf(run.ids["Run 5 km"])).toMatchObject(where("Run a marathon"));

    // Ticked today already: due tomorrow.
    expect(task("Wash face").due).toMatchObject({ date: "2026-10-29", string: "every day", is_recurring: true });
    expect(task("Drink water").due).toMatchObject({ date: TODAY, string: "every day", is_recurring: true, lang: "en" });
    // Picked before Sunday the 25th and not done since: late, so it stays on that Sunday.
    expect(task("Cut nails").due).toMatchObject({ date: "2026-10-25", string: "every sunday", is_recurring: true });
    // Picked after this week's Monday: the first one is next Monday.
    expect(task("Trim beard").due).toMatchObject({ date: "2026-11-02", string: "every monday", is_recurring: true });
    expect(task("Pay the gym").due).toMatchObject({ date: "2026-10-31", string: "every last day", is_recurring: true });
    // A task is due on the last day of the week (Todoist's week starts on Monday here).
    expect(task("Buy running shoes").due).toMatchObject({ date: "2026-11-01", is_recurring: false });

    const link = squareLink(APP, looks.goalId, 0, looks.ids["Wash face"]);
    const context = { pillar: "Skin", goal: "LOOKSMAXXING", link };
    expect(task("Wash face").description).toBe(withFooter("Gentle cleanser, cold water", context));
    const priorities = ["Wash face", "Buy running shoes", "Drink water"].map((text) => task(text).priority);
    expect(priorities).toEqual([2, 3, 1]);
    // Dates always in English, whatever language the person's Todoist speaks; never p1, which is the person's.
    for (const command of fake.commands()) {
      if (command.type === "item_add") expect(command.args.due).toMatchObject({ lang: "en" });
      expect(command.args.priority).not.toBe(4);
    }

    expect(await checkins(userId, looks.ids["Wash face"])).toEqual([TODAY]);
    const connected = await info(userId);
    expect(connected).toMatchObject({
      available: true,
      connected: true,
      status: "ok",
      email: `todoist-${someone.todoistUserId}@example.com`,
      error: "",
    });
    expect(connected.lastSyncAt).not.toBeNull();
  });

  it("says why it did not connect: refused, an answer meant for someone else, or a Todoist account taken", async () => {
    const alex = await person();
    const bea = await person();
    const { url, cookie } = startTodoistConnect(alex.userId, APP);
    const { code, state } = fake.approve(url, alex.todoistUserId);
    const answer = { code, state, error: null, cookie, origin: APP };
    expect(await finishTodoistConnect(alex.userId, { ...answer, code: null, error: "access_denied" })).toBe("denied");
    expect(await finishTodoistConnect(alex.userId, { ...answer, cookie: undefined })).toBe("error");
    expect(await finishTodoistConnect(alex.userId, { ...answer, cookie: `${cookie}x` })).toBe("error");
    expect(await finishTodoistConnect(alex.userId, { ...answer, state: "another-state" })).toBe("error");
    expect(await finishTodoistConnect(bea.userId, answer)).toBe("error"); // the cookie is Alex's
    expect(await info(alex.userId)).toMatchObject({ connected: false });
    expect(await info(bea.userId)).toMatchObject({ connected: false });
    expect(await finishTodoistConnect(alex.userId, answer)).toBe("connected");

    // Bea approves the app as Alex's Todoist user.
    const second = startTodoistConnect(bea.userId, APP);
    const taken = fake.approve(second.url, alex.todoistUserId);
    const input = { code: taken.code, state: taken.state, error: null, cookie: second.cookie, origin: APP };
    expect(await finishTodoistConnect(bea.userId, input)).toBe("taken");
    expect(await info(bea.userId)).toMatchObject({ connected: false });
    // Nothing is revoked: Todoist may have handed back the grant Alex's connection uses.
    expect(revokes()).toBe(0);
    expect(await info(alex.userId)).toMatchObject({ connected: true, status: "ok" });
  });

  it("uses the Inbox when the free plan has no room for another project", async () => {
    const { todoistUserId, ids } = await setup([{ text: "Run 5 km", how: "day" }], { maxProjects: 0 });
    expect(mandaalaProjects()).toEqual([]);
    expect(taskOf(ids["Run 5 km"]).project_id).toBe(fake.user(todoistUserId).inbox_project_id);
  });

  it("after a disconnect, connecting again reuses the Mandaala project and the goal's section", async () => {
    const someone = await setup([{ text: "Buy sunscreen" }]);
    await disconnectTodoist(someone.userId);
    later(5 * MINUTE);
    await connectAndSend(someone);
    expect(mandaalaProjects()).toHaveLength(1);
    expect(openSections().map((section) => section.name)).toEqual(["LOOKSMAXXING"]);
  });

  it("after a disconnect, connecting again keeps the times, repeats and p1 the person set in Todoist", async () => {
    const someone = await setup([{ text: "Drink water", how: "day" }, { text: "Floss", how: "day" }]);
    const { userId, ids } = someone;
    await disconnectTodoist(userId);
    later(5 * MINUTE);
    const water = taskOf(ids["Drink water"]).id;
    fake.edit(water, { due: { string: "every day at 7am", date: "2026-10-28T07:00:00" }, priority: 4 });
    fake.edit(taskOf(ids["Floss"]).id, { due: { string: "every 2 days", date: TODAY } });
    later(MINUTE);
    await connectAndSend(someone);
    // The same tasks, linked again by their footer, and left as the person set them.
    const atSeven = { string: "every day at 7am", date: "2026-10-28T07:00:00" };
    expect(fake.task(water)).toMatchObject({ priority: 4, due: atSeven });
    expect(taskOf(ids["Floss"]).due).toMatchObject({ string: "every 2 days", date: TODAY });
    expect(ran("item_update")).toEqual([]);
    expect(await getCell(userId, ids["Floss"])).toMatchObject({ kind: "habit", repeat: "day" });
  });
});

describe("a task", () => {
  it("done and undone in Mandaala is completed and opened again in Todoist", async () => {
    const { userId, ids } = await setup([{ text: "Buy sunscreen" }]);
    const sunscreen = ids["Buy sunscreen"];
    const id = taskOf(sunscreen).id;
    const count = fake.webhooks().length;
    later(5 * MINUTE);
    await updateCell(userId, sunscreen, { status: "done", doneAt: "2026-10-28T09:30:00.000Z" });
    await drainTodoist(userId);
    // Completed when Mandaala says it was done, not when the change arrived.
    expect(fake.task(id)).toMatchObject({ checked: true, completed_at: "2026-10-28T09:30:00.000000Z" });

    at("2026-11-03"); // Tuesday of the next week
    await updateCell(userId, sunscreen, { status: "todo" });
    await drainTodoist(userId);
    // Open again, and due at the end of this week, not last week's.
    expect(fake.task(id)).toMatchObject({ checked: false, due: { date: "2026-11-08" } });

    // Todoist's notices of all that, the first one days late, change nothing.
    await deliverEach(noticesSince(count), async () => {
      expect(await getCell(userId, sunscreen)).toMatchObject({ status: "todo", doneAt: null });
    });
  });

  it("completed and opened again in Todoist is done and to do in Mandaala, and nothing goes back", async () => {
    const { userId, ids } = await setup([{ text: "Buy sunscreen" }]);
    const sunscreen = ids["Buy sunscreen"];
    const id = taskOf(sunscreen).id;
    later(5 * MINUTE);
    expect(await deliver(fake.complete(id))).toEqual([200]);
    const done = await getCell(userId, sunscreen);
    expect(done.status).toBe("done");
    expect(Date.parse(done.doneAt!)).toBe(Date.parse(fake.task(id)!.completed_at!));
    later(MINUTE);
    expect(await deliver(fake.uncomplete(id))).toEqual([200]);
    expect(await getCell(userId, sunscreen)).toMatchObject({ status: "todo", doneAt: null });
    const commands = fake.commands().length;
    await drainTodoist(userId);
    expect(fake.commands()).toHaveLength(commands);
  });

  it("done and undone in Todoist count in the order they happened, whatever order the notices come in", async () => {
    const { userId, ids } = await setup([{ text: "Buy sunscreen" }, { text: "Book a haircut" }]);
    const sunscreen = taskOf(ids["Buy sunscreen"]).id;
    const haircut = taskOf(ids["Book a haircut"]).id;
    later(5 * MINUTE);
    const sunscreenDone = fake.complete(sunscreen);
    const haircutDone = fake.complete(haircut);
    later(MINUTE);
    const sunscreenUndone = fake.uncomplete(sunscreen);
    const haircutUndone = fake.uncomplete(haircut);
    later(MINUTE);
    const haircutDoneAgain = fake.complete(haircut);

    // Ticked, then unticked; the untick arrives first.
    expect(await deliver(sunscreenUndone, sunscreenDone)).toEqual([200, 200]);
    expect((await getCell(userId, ids["Buy sunscreen"])).status).toBe("todo");
    // Ticked, unticked and ticked again; the untick arrives last.
    expect(await deliver(haircutDone, haircutDoneAgain, haircutUndone)).toEqual([200, 200, 200]);
    expect((await getCell(userId, ids["Book a haircut"])).status).toBe("done");
  });
});

describe("a routine ticked in Mandaala", () => {
  it("moves Todoist on to the next due day, and back when the tick is taken off", async () => {
    at("2026-10-20");
    const someone = await person();
    const { ids } = await makeGoal(someone.userId, "LOOKSMAXXING", [
      { text: "Drink water", how: "day" },
      { text: "Cut nails", how: "week", on: 0 },
    ]);
    at(TODAY);
    await connectAndSend(someone);
    expect(taskOf(ids["Cut nails"]).due!.date).toBe("2026-10-25"); // late since Sunday
    later(5 * MINUTE);
    const count = fake.webhooks().length;
    await setCheckin(someone.userId, ids["Drink water"], TODAY, true);
    await setCheckin(someone.userId, ids["Cut nails"], TODAY, true);
    await drainTodoist(someone.userId);
    expect(taskOf(ids["Drink water"]).due).toMatchObject({ date: "2026-10-29", string: "every day" });
    expect(taskOf(ids["Cut nails"]).due).toMatchObject({ date: "2026-11-01", string: "every sunday" });

    later(MINUTE);
    await setCheckin(someone.userId, ids["Drink water"], TODAY, false);
    await setCheckin(someone.userId, ids["Cut nails"], TODAY, false);
    await drainTodoist(someone.userId);
    expect(taskOf(ids["Drink water"]).due!.date).toBe(TODAY);
    expect(taskOf(ids["Cut nails"]).due!.date).toBe("2026-10-25");
    const moves = ran("item_update_date_complete").map((command) => command.args.is_forward);
    expect(moves).toEqual([1, 1, 0, 0]);

    // Todoist's notices of those moves leave Mandaala with no tick.
    await deliverEach(noticesSince(count), async () => {
      expect(await checkins(someone.userId, ids["Drink water"])).toEqual([]);
      expect(await checkins(someone.userId, ids["Cut nails"])).toEqual([]);
    });
  });

  it("moves nothing for a tick on an earlier day, or for one Todoist already counts", async () => {
    const { userId, ids } = await setup([
      { text: "Drink water", how: "day" },
      { text: "Trim beard", how: "week", on: 1 }, // picked after Monday: waits for next Monday
      { text: "Pay the gym", how: "month", on: 31 }, // picked after September 30th: waits for the 31st
    ]);
    later(5 * MINUTE);
    await setCheckin(userId, ids["Drink water"], "2026-10-26", true); // fixing history
    await setCheckin(userId, ids["Trim beard"], TODAY, true);
    await setCheckin(userId, ids["Pay the gym"], TODAY, true);
    await drainTodoist(userId);
    later(MINUTE);
    await setCheckin(userId, ids["Drink water"], "2026-10-26", false);
    await setCheckin(userId, ids["Trim beard"], TODAY, false);
    await drainTodoist(userId);
    expect(ran("item_update_date_complete")).toEqual([]);
    expect(taskOf(ids["Drink water"]).due!.date).toBe(TODAY);
    expect(taskOf(ids["Trim beard"]).due!.date).toBe("2026-11-02");
    expect(taskOf(ids["Pay the gym"]).due!.date).toBe("2026-10-31");
  });

  it("on the 31st moves a monthly routine to the last day of a short month", async () => {
    const { userId, ids } = await setup([{ text: "Pay the gym", how: "month", on: 31 }]);
    expect(taskOf(ids["Pay the gym"]).due!.date).toBe("2026-10-31");
    at("2026-10-31");
    await setCheckin(userId, ids["Pay the gym"], "2026-10-31", true);
    await drainTodoist(userId);
    expect(taskOf(ids["Pay the gym"]).due).toMatchObject({ date: "2026-11-30", string: "every last day" });
  });
});

describe("a routine ticked in Todoist", () => {
  it("is checked on the day it was done, or on its own day when done early", async () => {
    at("2026-10-20");
    const someone = await person();
    const { userId } = someone;
    const { ids } = await makeGoal(userId, "LOOKSMAXXING", [
      { text: "Drink water", how: "day" },
      { text: "Cut nails", how: "week", on: 0 },
      { text: "Trim beard", how: "week", on: 1, picked: false },
    ]);
    at(TODAY);
    await updateCell(userId, ids["Trim beard"], { active: true }); // after Monday: due next Monday
    await connectAndSend(someone);
    later(5 * MINUTE);
    const tick = (text: string) => fake.complete(taskOf(ids[text]).id);
    expect(await deliver(tick("Drink water"), tick("Cut nails"), tick("Trim beard"))).toEqual([200, 200, 200]);
    // On time: today.
    expect(await checkins(userId, ids["Drink water"])).toEqual([TODAY]);
    // Late (due Sunday the 25th): the day it was done.
    expect(await checkins(userId, ids["Cut nails"])).toEqual([TODAY]);
    // Early (due Monday, November 2nd): its own day.
    expect(await checkins(userId, ids["Trim beard"])).toEqual(["2026-11-02"]);
    // Todoist moved each one on by itself; nothing goes back.
    expect(taskOf(ids["Drink water"]).due!.date).toBe("2026-10-29");
    expect(taskOf(ids["Cut nails"]).due!.date).toBe("2026-11-01");
    expect(taskOf(ids["Trim beard"]).due!.date).toBe("2026-11-09");
    const commands = fake.commands().length;
    await drainTodoist(userId);
    expect(fake.commands()).toHaveLength(commands);
  });

  it("adds no second check-in to a period that already has one, and Todoist is not moved twice", async () => {
    at("2026-10-20");
    const someone = await person();
    const { userId } = someone;
    const { ids } = await makeGoal(userId, "LOOKSMAXXING", [
      { text: "Drink water", how: "day" },
      { text: "Cut nails", how: "week", on: 0 },
    ]);
    at(TODAY);
    await connectAndSend(someone);
    later(5 * MINUTE);
    // Ticked in Mandaala (not sent yet) and in Todoist at about the same time.
    await setCheckin(userId, ids["Drink water"], TODAY, true);
    await setCheckin(userId, ids["Cut nails"], "2026-10-26", true);
    const water = fake.complete(taskOf(ids["Drink water"]).id);
    const nails = fake.complete(taskOf(ids["Cut nails"]).id);
    expect(await deliver(water, nails, again(water), again(nails))).toEqual([200, 200, 200, 200]);
    expect(await checkins(userId, ids["Drink water"])).toEqual([TODAY]);
    expect(await checkins(userId, ids["Cut nails"])).toEqual(["2026-10-26"]);
    await drainTodoist(userId);
    expect(taskOf(ids["Drink water"]).due!.date).toBe("2026-10-29");
    expect(taskOf(ids["Cut nails"]).due!.date).toBe("2026-11-01");
    expect(ran("item_update_date_complete")).toEqual([]);
    expect(ran("item_close")).toEqual([]);
  });

  it("counts a late-night tick for the person's own day", async () => {
    const { userId, ids } = await setup([{ text: "Drink water", how: "day" }], { timeZone: "America/Sao_Paulo" });
    at("2026-10-29", "01:30"); // still 22:30 on the 28th in São Paulo
    expect(await deliver(fake.complete(taskOf(ids["Drink water"]).id))).toEqual([200]);
    expect(await checkins(userId, ids["Drink water"])).toEqual([TODAY]);
    expect(taskOf(ids["Drink water"]).due!.date).toBe("2026-10-29");
  });

  it("undone in Todoist removes the check-in Todoist made, and only that one", async () => {
    const { userId, ids } = await setup([{ text: "Drink water", how: "day" }]);
    const water = ids["Drink water"];
    await setCheckin(userId, water, "2026-10-27", true); // yesterday, ticked in Mandaala
    await drainTodoist(userId);
    later(5 * MINUTE);
    const id = taskOf(water).id;
    expect(await deliver(fake.complete(id))).toEqual([200]);
    expect(await checkins(userId, water)).toEqual(["2026-10-27", TODAY]);
    later(MINUTE);
    expect(await deliver(fake.uncomplete(id))).toEqual([200]);
    expect(await checkins(userId, water)).toEqual(["2026-10-27"]);
    expect(taskOf(water).due!.date).toBe(TODAY);
  });

  it("undone in Todoist keeps a tick that was made in Mandaala", async () => {
    const { userId, ids } = await setup([{ text: "Drink water", how: "day" }]);
    const water = ids["Drink water"];
    later(5 * MINUTE);
    await setCheckin(userId, water, TODAY, true);
    await drainTodoist(userId);
    expect(taskOf(water).due!.date).toBe("2026-10-29");
    later(5 * MINUTE);
    expect(await deliver(fake.uncomplete(taskOf(water).id))).toEqual([200]);
    expect(await checkins(userId, water)).toEqual([TODAY]);
  });

  it("ignores an undo older than the tick that made the check-in", async () => {
    const { userId, ids } = await setup([{ text: "Drink water", how: "day" }]);
    const id = taskOf(ids["Drink water"]).id;
    later(5 * MINUTE);
    const first = fake.complete(id);
    later(MINUTE);
    const undo = fake.uncomplete(id);
    later(MINUTE);
    const second = fake.complete(id);
    expect(await deliver(second, undo, first)).toEqual([200, 200, 200]);
    expect(await checkins(userId, ids["Drink water"])).toEqual([TODAY]);
  });

  it("keeps the check-in when a tick, its undo and a second tick come with the undo last", async () => {
    const { userId, ids } = await setup([{ text: "Drink water", how: "day" }]);
    const id = taskOf(ids["Drink water"]).id;
    later(5 * MINUTE);
    const first = fake.complete(id);
    later(MINUTE);
    const undo = fake.uncomplete(id);
    later(MINUTE);
    const second = fake.complete(id);
    expect(await deliver(first, second, undo)).toEqual([200, 200, 200]);
    // Todoist holds it done: so does Mandaala.
    expect(taskOf(ids["Drink water"]).due!.date).toBe("2026-10-29");
    expect(await checkins(userId, ids["Drink water"])).toEqual([TODAY]);
  });

  it("keeps yesterday's check-in when the undo of today's tick comes before that tick", async () => {
    const { userId, ids } = await setup([{ text: "Drink water", how: "day" }]);
    const id = taskOf(ids["Drink water"]).id;
    later(5 * MINUTE);
    expect(await deliver(fake.complete(id))).toEqual([200]);
    at("2026-10-29");
    const tick = fake.complete(id);
    later(MINUTE);
    const undo = fake.uncomplete(id); // a slip, taken back at once
    expect(await deliver(undo, tick)).toEqual([200, 200]);
    expect(await checkins(userId, ids["Drink water"])).toEqual([TODAY]);
    expect(taskOf(ids["Drink water"]).due!.date).toBe("2026-10-29");
  });

  it("adds no check-in for a tick whose undo was taken first", async () => {
    const { userId, ids } = await setup([{ text: "Drink water", how: "day" }, { text: "Stretch", how: "day" }]);
    const water = taskOf(ids["Drink water"]).id;
    const stretch = taskOf(ids["Stretch"]).id;
    later(5 * MINUTE);
    const waterTick = fake.complete(water);
    const stretchTick = fake.complete(stretch);
    later(MINUTE);
    const waterUndo = fake.uncomplete(water);
    const stretchUndo = fake.uncomplete(stretch);
    // Out of order.
    expect(await deliver(waterUndo, waterTick)).toEqual([200, 200]);
    expect(await checkins(userId, ids["Drink water"])).toEqual([]);
    // The undo arrives, the tick's notice fails and the catch-up reads both; then Todoist sends the
    // tick's notice again, 15 minutes later.
    expect(await deliver(stretchUndo)).toEqual([200]);
    later(MINUTE);
    await catchUpTodoist(userId);
    expect(await checkins(userId, ids["Stretch"])).toEqual([]);
    later(15 * MINUTE);
    expect(await deliver(stretchTick)).toEqual([200]);
    expect(await checkins(userId, ids["Stretch"])).toEqual([]);
    expect(taskOf(ids["Stretch"]).due!.date).toBe(TODAY);
  });

  it("stays unticked once the person takes the tick back in Mandaala, when the catch-up reads it again", async () => {
    const { userId, ids } = await setup([{ text: "Drink water", how: "day" }]);
    const water = ids["Drink water"];
    later(5 * MINUTE);
    expect(await deliver(fake.complete(taskOf(water).id))).toEqual([200]);
    expect(await checkins(userId, water)).toEqual([TODAY]);
    later(MINUTE);
    await setCheckin(userId, water, TODAY, false);
    await drainTodoist(userId);
    expect(taskOf(water).due!.date).toBe(TODAY);
    // The app opens again a while later, and the catch-up finds the tick in the activity log.
    later(5 * MINUTE);
    await catchUpTodoist(userId);
    expect(await checkins(userId, water)).toEqual([]);
    expect(taskOf(water).due!.date).toBe(TODAY);
    expect(await nextTodoistOutbox(userId)).toBeNull();
  });

  it("stays unticked on an earlier day the person fixed in Mandaala, when the daily job reads the tick again", async () => {
    const { userId, ids } = await setup([{ text: "Drink water", how: "day" }]);
    const water = ids["Drink water"];
    at(TODAY, "22:00");
    expect(await deliver(fake.complete(taskOf(water).id))).toEqual([200]);
    expect(await checkins(userId, water)).toEqual([TODAY]);
    // Early next morning the person takes last night's tick off in Mandaala: fixing history.
    at("2026-10-29", "05:00");
    await setCheckin(userId, water, TODAY, false);
    await drainTodoist(userId);
    at("2026-10-29", "06:17");
    await runTodoistDaily();
    expect(await checkins(userId, water)).toEqual([]);
  });

  it("stays unticked when the catch-up reads the tick again before the untick made in Mandaala went out", async () => {
    const { userId, ids } = await setup([{ text: "Drink water", how: "day" }]);
    const water = ids["Drink water"];
    later(5 * MINUTE);
    expect(await deliver(fake.complete(taskOf(water).id))).toEqual([200]);
    later(MINUTE);
    // Taken back while another worker holds the account: the untick waits.
    await whileBusy(userId, async () => {
      await setCheckin(userId, water, TODAY, false);
      await whileTimePasses(drainTodoist(userId));
    });
    expect(taskOf(water).due!.date).toBe("2026-10-29");
    later(MINUTE);
    await catchUpTodoist(userId, { force: true });
    expect(await checkins(userId, water)).toEqual([]);
    expect(taskOf(water).due!.date).toBe(TODAY);
  });

  it("undone in Todoist removes a check-in whose notice failed after the check-in was written", async () => {
    const { userId, ids } = await setup([{ text: "Drink water", how: "day" }]);
    const water = ids["Drink water"];
    const id = taskOf(water).id;
    later(5 * MINUTE);
    const tick = fake.complete(id);
    // The link cannot be saved once the check-in is in: Todoist gets a 500 and sends the notice again.
    const afterTheCheckin = "WHEN EXISTS (SELECT 1 FROM checkins WHERE cell_id = NEW.cell_id)";
    await whileFailing(`BEFORE UPDATE ON todoist_links ${afterTheCheckin}`, async () => {
      expect(await deliver(tick)).toEqual([500]);
    });
    expect(await deliver(tick)).toEqual([200]);
    expect(await checkins(userId, water)).toEqual([TODAY]);
    later(MINUTE);
    expect(await deliver(fake.uncomplete(id))).toEqual([200]);
    expect(await checkins(userId, water)).toEqual([]);
    expect(taskOf(water).due!.date).toBe(TODAY);
  });

  it("gets its check-in when Todoist sends again a notice that failed before the check-in was written", async () => {
    const { userId, ids } = await setup([{ text: "Drink water", how: "day" }]);
    const water = ids["Drink water"];
    const id = taskOf(water).id;
    later(5 * MINUTE);
    const tick = fake.complete(id);
    await whileFailing("BEFORE INSERT ON checkins", async () => {
      expect(await deliver(tick)).toEqual([500]);
    });
    expect(await checkins(userId, water)).toEqual([]);
    expect(await deliver(tick)).toEqual([200]);
    expect(await checkins(userId, water)).toEqual([TODAY]);
    later(MINUTE);
    expect(await deliver(fake.uncomplete(id))).toEqual([200]);
    expect(await checkins(userId, water)).toEqual([]);
  });
});

describe("a routine done for good", () => {
  it("in Mandaala completes the Todoist task, and back to do opens it on its due day", async () => {
    const { userId, ids } = await setup([{ text: "Drink water", how: "day" }]);
    const water = ids["Drink water"];
    const id = taskOf(water).id;
    later(5 * MINUTE);
    await updateCell(userId, water, { status: "done" });
    await drainTodoist(userId);
    expect(fake.task(id)).toMatchObject({ checked: true });
    at("2026-10-30");
    await updateCell(userId, water, { status: "todo" });
    await drainTodoist(userId);
    expect(fake.task(id)).toMatchObject({
      checked: false,
      due: { date: "2026-10-30", string: "every day", is_recurring: true },
    });
  });

  it("in Todoist is done in Mandaala, and opened again is back to do", async () => {
    const { userId, ids } = await setup([{ text: "Drink water", how: "day" }]);
    const water = ids["Drink water"];
    const id = taskOf(water).id;
    later(5 * MINUTE);
    expect(await deliver(fake.completeForever(id))).toEqual([200]);
    expect((await getCell(userId, water)).status).toBe("done");
    expect(await checkins(userId, water)).toEqual([]);
    later(MINUTE);
    expect(await deliver(fake.uncomplete(id))).toEqual([200]);
    expect((await getCell(userId, water)).status).toBe("todo");
  });
});

describe("names and notes", () => {
  it("edited in Mandaala change the Todoist task", async () => {
    const { userId, goalId, ids } = await setup([{ text: "Drink water", how: "day" }]);
    const water = ids["Drink water"];
    const context = { pillar: "Skin", goal: "LOOKSMAXXING", link: squareLink(APP, goalId, 0, water) };
    later(5 * MINUTE);
    const count = fake.webhooks().length;
    await updateCell(userId, water, { text: "Drink 2 L of water", notes: "Keep a bottle on the desk" });
    await drainTodoist(userId);
    expect(taskOf(water)).toMatchObject({
      content: "Drink 2 L of water",
      description: withFooter("Keep a bottle on the desk", context),
    });
    later(MINUTE);
    await updateCell(userId, water, { notes: "" });
    await drainTodoist(userId);
    expect(taskOf(water).description).toBe(withFooter("", context));
    // Todoist's notices of those edits come after both and change nothing.
    await deliverEach(noticesSince(count), async () => {
      expect(await getCell(userId, water)).toMatchObject({ text: "Drink 2 L of water", notes: "" });
    });
  });

  it("edited in Todoist change the square", async () => {
    const { userId, ids } = await setup([{ text: "Drink water", how: "day" }]);
    const water = ids["Drink water"];
    const id = taskOf(water).id;
    const footer = taskOf(water).description; // no notes yet: the footer alone
    later(5 * MINUTE);
    const description = `Bottle on the desk\n\n---\n${footer}`;
    expect(await deliver(fake.edit(id, { content: "Drink 3 L of water", description }))).toEqual([200]);
    expect(await getCell(userId, water)).toMatchObject({ text: "Drink 3 L of water", notes: "Bottle on the desk" });
    later(MINUTE);
    // Written straight above the footer, without the line between.
    expect(await deliver(fake.edit(id, { description: `Bottle by the bed\n${footer}` }))).toEqual([200]);
    expect((await getCell(userId, water)).notes).toBe("Bottle by the bed");
    later(MINUTE);
    expect(await deliver(fake.edit(id, { description: footer }))).toEqual([200]);
    expect((await getCell(userId, water)).notes).toBe("");
    const commands = fake.commands().length;
    await drainTodoist(userId);
    expect(fake.commands()).toHaveLength(commands);
  });

  it("edited on both sides keep both edits, and the newer one wins on the same field", async () => {
    const { userId, ids } = await setup([
      { text: "Drink water", how: "day" },
      { text: "Buy sunscreen" },
      { text: "Book a haircut" },
    ]);
    const task = (text: string) => taskOf(ids[text]).id;
    const footer = taskOf(ids["Drink water"]).description;
    later(5 * MINUTE);
    await updateCell(userId, ids["Drink water"], { text: "Drink 2 L of water" });
    await updateCell(userId, ids["Buy sunscreen"], { text: "Buy SPF 50" });
    // Its notice is slow to come.
    const haircutInTodoist = fake.edit(task("Book a haircut"), { content: "Book a haircut on Friday" });
    later(MINUTE);
    const notesInTodoist = fake.edit(task("Drink water"), { description: `Bottle on the desk\n\n---\n${footer}` });
    const sunscreenInTodoist = fake.edit(task("Buy sunscreen"), { content: "Buy SPF 30" });
    await updateCell(userId, ids["Book a haircut"], { text: "Book a haircut on Monday" });
    // The notices reach the app a moment later. The first one also sends what waits here.
    later(5_000);
    expect(await deliver(notesInTodoist, sunscreenInTodoist, haircutInTodoist)).toEqual([200, 200, 200]);
    await drainTodoist(userId);

    // Different fields: each side keeps the other's edit.
    const water = await getCell(userId, ids["Drink water"]);
    expect(water).toMatchObject({ text: "Drink 2 L of water", notes: "Bottle on the desk" });
    expect(taskOf(ids["Drink water"]).content).toBe("Drink 2 L of water");
    expect(notesFrom(taskOf(ids["Drink water"]).description, APP)).toBe("Bottle on the desk");
    // The same field: the newer edit wins, on both sides.
    expect((await getCell(userId, ids["Buy sunscreen"])).text).toBe("Buy SPF 30");
    expect(taskOf(ids["Buy sunscreen"]).content).toBe("Buy SPF 30");
    expect((await getCell(userId, ids["Book a haircut"])).text).toBe("Book a haircut on Monday");
    expect(taskOf(ids["Book a haircut"]).content).toBe("Book a haircut on Monday");
  });

  it("too long for Todoist stay whole when edited there, and Todoist gets back the part it holds", async () => {
    const notes = `${"Fill the bottle at every meal. ".repeat(600)}THE END`;
    const { userId, ids } = await setup([{ text: "Drink water", how: "day", notes }]);
    const water = ids["Drink water"];
    const id = taskOf(water).id;
    // Todoist holds only their start.
    const sent = taskOf(water).description;
    expect(sent.length).toBeLessThanOrEqual(16_000);
    expect(sent).not.toContain("THE END");
    later(5 * MINUTE);
    expect(await deliver(fake.edit(id, { description: `Added in Todoist\n${sent}` }))).toEqual([200]);
    expect((await getCell(userId, water)).notes).toBe(notes);
    await drainTodoist(userId);
    expect(taskOf(water).description).toBe(sent);
  });
});

describe("repeats", () => {
  it("changed in Mandaala change Todoist's due date and words", async () => {
    const { userId, ids } = await setup([{ text: "Trim beard", how: "week", on: 1 }]);
    const beard = ids["Trim beard"];
    expect(taskOf(beard).due).toMatchObject({ date: "2026-11-02", string: "every monday" });
    later(5 * MINUTE);
    const count = fake.webhooks().length;
    await updateCell(userId, beard, { repeatOn: 3 }); // Wednesdays, so today
    await drainTodoist(userId);
    expect(taskOf(beard).due).toMatchObject({ date: TODAY, string: "every wednesday", is_recurring: true });
    later(MINUTE);
    await updateCell(userId, beard, { kind: "task" });
    await drainTodoist(userId);
    expect(taskOf(beard).due).toMatchObject({ date: "2026-11-01", is_recurring: false });
    later(MINUTE);
    await updateCell(userId, beard, { kind: "habit", repeat: "month", repeatOn: 5 });
    await drainTodoist(userId);
    // Picked after this month's 5th: the first one is next month's.
    expect(taskOf(beard).due).toMatchObject({ date: "2026-11-05", string: "every 5th", is_recurring: true });
    // Todoist's notices of those changes, all late, change nothing.
    await deliverEach(noticesSince(count), async () => {
      expect(await getCell(userId, beard)).toMatchObject({ kind: "habit", repeat: "month", repeatOn: 5 });
    });
  });

  it("changed in Todoist change the square when Mandaala can show them", async () => {
    const { userId, ids } = await setup([{ text: "Drink water", how: "day" }]);
    const water = ids["Drink water"];
    const id = taskOf(water).id;
    later(5 * MINUTE);
    const edit = async (due: DueInput) => {
      later(MINUTE);
      expect(await deliver(fake.edit(id, { due }))).toEqual([200]);
      return getCell(userId, water);
    };
    const monthly = (day: number) => ({ kind: "habit", repeat: "month", repeatOn: day });
    expect(await edit({ string: "every monday" })).toMatchObject({ kind: "habit", repeat: "week", repeatOn: 1 });
    expect(await edit({ string: "todo dia 5", lang: "pt" })).toMatchObject(monthly(5));
    expect(await edit({ string: "every last day" })).toMatchObject(monthly(31));
    expect(await edit({ date: "2026-10-30" })).toMatchObject({ kind: "task" });
    expect(await edit({ string: "every day" })).toMatchObject({ kind: "habit", repeat: "day" });
    const commands = fake.commands().length;
    await drainTodoist(userId);
    expect(fake.commands()).toHaveLength(commands);
  });

  it("that Mandaala cannot show stay in Todoist and are never overwritten", async () => {
    const { userId, ids } = await setup([{ text: "Drink water", how: "day" }]);
    const water = ids["Drink water"];
    const id = taskOf(water).id;
    later(5 * MINUTE);
    expect(await deliver(fake.edit(id, { due: { string: "every other week" } }))).toEqual([200]);
    expect(await getCell(userId, water)).toMatchObject({ kind: "habit", repeat: "day" });

    later(MINUTE);
    await updateCell(userId, water, { text: "Drink 2 L of water" });
    await drainTodoist(userId);
    expect(fake.task(id)).toMatchObject({ content: "Drink 2 L of water", due: { string: "every other week" } });
    expect(fake.task(id)!.due!.date).toBe(TODAY);

    // Late now, but not moved to today: it is not a daily repeat any more.
    at("2026-10-30");
    await catchUpTodoist(userId);
    expect(fake.task(id)!.due).toMatchObject({ string: "every other week", date: TODAY });

    // A tick in Mandaala closes the occurrence the way Todoist's own apps do, keeping their repeat.
    await setCheckin(userId, water, "2026-10-30", true);
    await drainTodoist(userId);
    expect(ran("item_close")).toHaveLength(1);
    expect(fake.task(id)!.due).toMatchObject({ string: "every other week", date: "2026-11-11" });
    // Taking the tick off moves nothing back.
    later(MINUTE);
    await setCheckin(userId, water, "2026-10-30", false);
    await drainTodoist(userId);
    expect(ran("item_close")).toHaveLength(1);
    expect(ran("item_update_date_complete")).toEqual([]);
    expect(fake.task(id)!.due).toMatchObject({ string: "every other week", date: "2026-11-11" });
    expect(await getCell(userId, water)).toMatchObject({ kind: "habit", repeat: "day", text: "Drink 2 L of water" });
  });
});

describe("this week's picks", () => {
  it("get a task in Todoist, and taking one out deletes its task", async () => {
    const { userId, ids } = await setup([{ text: "Buy sunscreen" }, { text: "Try retinol", picked: false }]);
    const retinol = ids["Try retinol"];
    expect(tasksOf(retinol)).toEqual([]);
    later(5 * MINUTE);
    await updateCell(userId, retinol, { active: true });
    await drainTodoist(userId);
    const id = taskOf(retinol).id;
    expect(fake.task(id)).toMatchObject({ content: "Try retinol", due: { date: "2026-11-01" } });

    later(MINUTE);
    const count = fake.webhooks().length;
    await updateCell(userId, retinol, { active: false });
    await drainTodoist(userId);
    expect(fake.task(id)!.is_deleted).toBe(true);
    // Todoist's notice of that delete changes nothing.
    const notices = noticesSince(count);
    expect(notices.map(eventName)).toEqual(["item:deleted"]);
    expect(await deliver(...notices)).toEqual([200]);
    expect((await getCell(userId, retinol)).active).toBe(false);
    expect(taskOf(ids["Buy sunscreen"]).checked).toBe(false);
  });

  it("taken out once done only let go of their task: it stays completed in Todoist", async () => {
    const { userId, ids } = await setup([{ text: "Buy sunscreen" }]);
    const sunscreen = ids["Buy sunscreen"];
    const id = taskOf(sunscreen).id;
    later(5 * MINUTE);
    await updateCell(userId, sunscreen, { status: "done" });
    await drainTodoist(userId);
    later(MINUTE);
    await updateCell(userId, sunscreen, { active: false });
    await drainTodoist(userId);
    expect(fake.task(id)).toMatchObject({ checked: true, is_deleted: false });
    expect(ran("item_delete")).toEqual([]);
    // Let go: what Todoist does with it no longer reaches the square.
    later(5 * MINUTE);
    expect(await deliver(fake.uncomplete(id))).toEqual([200]);
    expect(await getCell(userId, sunscreen)).toMatchObject({ status: "done", active: false });
  });

  it("done and taken out before anything was sent are completed in Todoist, not deleted", async () => {
    const { userId, ids } = await setup([{ text: "Buy sunscreen" }]);
    const sunscreen = ids["Buy sunscreen"];
    const id = taskOf(sunscreen).id;
    later(5 * MINUTE);
    const count = fake.webhooks().length;
    // Offline, say: both changes reach the server before anything goes to Todoist.
    await updateCell(userId, sunscreen, { status: "done", doneAt: "2026-10-28T12:03:00.000Z" });
    await updateCell(userId, sunscreen, { active: false });
    await drainTodoist(userId);
    // Completed when Mandaala says it was done.
    const completed = { checked: true, is_deleted: false, completed_at: "2026-10-28T12:03:00.000000Z" };
    expect(fake.task(id)).toMatchObject(completed);
    expect(ran("item_delete")).toEqual([]);
    expect(await listTodoistLinks(userId)).toEqual([]);
    expect(await deliver(...noticesSince(count))).toEqual([200]);
    expect(await getCell(userId, sunscreen)).toMatchObject({ status: "done", active: false });
  });

  it("picked again in a later week move their open task to that week", async () => {
    const { userId, ids } = await setup([{ text: "Buy sunscreen" }]);
    const sunscreen = ids["Buy sunscreen"];
    const id = taskOf(sunscreen).id;
    at("2026-11-03");
    // Taken out and put back before the app sent anything (offline, say).
    await updateCell(userId, sunscreen, { active: false });
    await updateCell(userId, sunscreen, { active: true });
    await drainTodoist(userId);
    expect(taskOf(sunscreen)).toMatchObject({ id, due: { date: "2026-11-08" } });
  });
});

describe("deleting in Todoist", () => {
  it("one task takes its square out of this week, and nothing is made again", async () => {
    const { userId, ids } = await setup([{ text: "Buy sunscreen" }, { text: "Drink water", how: "day" }]);
    later(5 * MINUTE);
    const removed = [fake.remove(taskOf(ids["Buy sunscreen"]).id), fake.remove(taskOf(ids["Drink water"]).id)];
    expect(await deliver(...removed)).toEqual([200, 200]);
    expect(await getCell(userId, ids["Buy sunscreen"])).toMatchObject({ active: false, text: "Buy sunscreen" });
    expect((await getCell(userId, ids["Drink water"])).active).toBe(false);
    await drainTodoist(userId);
    await catchUpTodoist(userId, { force: true });
    expect(fake.tasks().filter((task) => !task.is_deleted)).toEqual([]);
    expect(await info(userId)).toMatchObject({ status: "ok" });
    // Picked again, it gets a new task.
    later(MINUTE);
    await updateCell(userId, ids["Buy sunscreen"], { active: true });
    await drainTodoist(userId);
    expect(taskOf(ids["Buy sunscreen"]).checked).toBe(false);
  });

  it("the whole project changes nothing in Mandaala, and waits to be set up again", async () => {
    const { userId, ids } = await setup([{ text: "Drink water", how: "day" }, { text: "Buy sunscreen" }]);
    const [project] = mandaalaProjects();
    later(5 * MINUTE);
    const count = fake.webhooks().length;
    fake.removeProject(project.id);
    const notices = noticesSince(count);
    expect(notices.map(eventName)).toEqual(["item:deleted", "item:deleted", "project:deleted"]);
    expect(await deliver(...notices)).toEqual([200, 200, 200]);
    for (const id of Object.values(ids)) expect((await getCell(userId, id)).active).toBe(true);
    const gone = { status: "project_gone", error: "The Mandaala project is gone from Todoist." };
    expect(await info(userId)).toMatchObject(gone);

    // A change made meanwhile waits.
    await updateCell(userId, ids["Buy sunscreen"], { text: "Buy SPF 50" });
    const tries = syncRequests().length;
    await drainTodoist(userId);
    expect(syncRequests()).toHaveLength(tries);

    later(MINUTE);
    await rebuildTodoist(userId);
    await drainTodoist(userId);
    const [rebuilt, ...more] = mandaalaProjects();
    expect(more).toEqual([]);
    expect(rebuilt.id).not.toBe(project.id);
    expect(openSections().map((section) => [section.name, section.project_id])).toEqual([["LOOKSMAXXING", rebuilt.id]]);
    expect(taskOf(ids["Drink water"])).toMatchObject({ project_id: rebuilt.id, due: { date: TODAY } });
    expect(taskOf(ids["Buy sunscreen"])).toMatchObject({ project_id: rebuilt.id, content: "Buy SPF 50" });
    expect(await info(userId)).toMatchObject({ status: "ok", error: "" });
  });

  it("archiving the project counts as the project gone", async () => {
    const { userId, ids } = await setup([{ text: "Buy sunscreen" }]);
    later(5 * MINUTE);
    expect(await deliver(fake.archiveProject(mandaalaProjects()[0].id))).toEqual([200]);
    expect(await info(userId)).toMatchObject({ status: "project_gone" });
    expect((await getCell(userId, ids["Buy sunscreen"])).active).toBe(true);
  });

  it("archiving the project is found out by the first change Todoist refuses, which then waits", async () => {
    const { userId, ids } = await setup([{ text: "Buy sunscreen" }, { text: "Try retinol", picked: false }]);
    const [project] = mandaalaProjects();
    later(5 * MINUTE);
    fake.archiveProject(project.id); // its notice is lost
    await updateCell(userId, ids["Try retinol"], { active: true });
    await drainTodoist(userId);
    const gone = { status: "project_gone", error: "The Mandaala project is gone from Todoist." };
    expect(await info(userId)).toMatchObject(gone);
    expect(await nextTodoistOutbox(userId)).not.toBeNull();
    later(MINUTE);
    await rebuildTodoist(userId);
    await drainTodoist(userId);
    const [rebuilt] = mandaalaProjects().filter((open) => !open.is_archived);
    expect(taskOf(ids["Try retinol"]).project_id).toBe(rebuilt.id);
    expect(await info(userId)).toMatchObject({ status: "ok", error: "" });
  });

  it("one task takes its square out of this week even when the first try failed, and nothing is made again", async () => {
    const { userId, ids } = await setup([{ text: "Buy sunscreen" }]);
    const sunscreen = ids["Buy sunscreen"];
    later(5 * MINUTE);
    const removed = fake.remove(taskOf(sunscreen).id);
    // The square cannot be written: Todoist gets a 500 and sends the notice again.
    await whileFailing("BEFORE UPDATE ON cells", async () => {
      expect(await deliver(removed)).toEqual([500]);
    });
    expect(await deliver(removed)).toEqual([200]);
    expect((await getCell(userId, sunscreen)).active).toBe(false);
    expect(await listTodoistLinks(userId)).toEqual([]);
    // "Sync now" goes over everything: the task stays deleted.
    await queueTodoist(userId, "all");
    await catchUpTodoist(userId, { force: true });
    expect(fake.tasks().filter((task) => !task.is_deleted)).toEqual([]);
  });

  it("the project is found gone by the catch-up when no notice came", async () => {
    const { userId, ids } = await setup([{ text: "Buy sunscreen" }, { text: "Drink water", how: "day" }]);
    later(5 * MINUTE);
    fake.removeProject(mandaalaProjects()[0].id);
    later(MINUTE);
    await catchUpTodoist(userId);
    expect(await info(userId)).toMatchObject({ status: "project_gone" });
    for (const id of Object.values(ids)) expect((await getCell(userId, id)).active).toBe(true);
  });
});

describe("goals", () => {
  it("renamed rename their section and the goal named in each task", async () => {
    const { userId, goalId, ids } = await setup([{ text: "Drink water", how: "day" }, { text: "Buy sunscreen" }]);
    later(5 * MINUTE);
    await updateGoal(userId, goalId, { title: "LOOKSMAXXING 2027" });
    await drainTodoist(userId);
    expect(openSections().map((section) => section.name)).toEqual(["LOOKSMAXXING 2027"]);
    const link = squareLink(APP, goalId, 0, ids["Buy sunscreen"]);
    const footer = withFooter("", { pillar: "Skin", goal: "LOOKSMAXXING 2027", link });
    expect(taskOf(ids["Buy sunscreen"]).description).toBe(footer);
  });

  it("archived lose their open tasks and their section, and restored get them back", async () => {
    const { userId, goalId, ids } = await setup([
      { text: "Drink water", how: "day" },
      { text: "Buy sunscreen" },
      { text: "Book a haircut" },
    ]);
    later(5 * MINUTE);
    await updateCell(userId, ids["Book a haircut"], { status: "done" });
    await drainTodoist(userId);
    const [section] = openSections();
    const water = taskOf(ids["Drink water"]).id;
    const sunscreen = taskOf(ids["Buy sunscreen"]).id;
    const haircut = taskOf(ids["Book a haircut"]).id;

    later(MINUTE);
    const count = fake.webhooks().length;
    await updateGoal(userId, goalId, { status: "archived" });
    await drainTodoist(userId);
    expect(fake.task(water)!.is_deleted).toBe(true);
    expect(fake.task(sunscreen)!.is_deleted).toBe(true);
    // A finished task stays, completed.
    expect(fake.task(haircut)).toMatchObject({ checked: true, is_deleted: false });
    expect(sectionById(section.id)).toMatchObject({ is_archived: true, is_deleted: false });
    // Todoist's notices of those deletes leave the picks alone.
    await deliverEach(noticesSince(count), async () => {
      for (const id of Object.values(ids)) expect((await getCell(userId, id)).active).toBe(true);
    });

    later(MINUTE);
    await updateGoal(userId, goalId, { status: "active" });
    await drainTodoist(userId);
    expect(openSections().map((open) => open.id)).toEqual([section.id]);
    expect(taskOf(ids["Drink water"])).toMatchObject({ section_id: section.id, checked: false });
    expect(taskOf(ids["Buy sunscreen"])).toMatchObject({ section_id: section.id, checked: false });
    // The finished task is not made again.
    expect(tasksOf(ids["Book a haircut"])).toHaveLength(1);
  });

  it("archived keep their picks when the notices of the deletes come before Todoist's answer", async () => {
    const { userId, goalId, ids } = await setup([{ text: "Drink water", how: "day" }, { text: "Buy sunscreen" }]);
    later(5 * MINUTE);
    const count = fake.webhooks().length;
    await updateGoal(userId, goalId, { status: "archived" });
    loseAnswerTo("item_delete");
    await drainTodoist(userId);
    // Todoist deleted the tasks, but the app never heard back; the notices of the deletes come first.
    const notices = noticesSince(count);
    expect(notices.map(eventName)).toEqual(["item:deleted", "item:deleted"]);
    expect(await deliver(...notices)).toEqual(allOk(notices));
    for (const id of Object.values(ids)) expect((await getCell(userId, id)).active).toBe(true);

    later(5 * MINUTE);
    await updateGoal(userId, goalId, { status: "active" });
    await drainTodoist(userId);
    expect(taskOf(ids["Drink water"]).checked).toBe(false);
    expect(taskOf(ids["Buy sunscreen"]).checked).toBe(false);
    expect(await nextTodoistOutbox(userId)).toBeNull();
  });

  it("archived keep a done pick whose task was deleted in Todoist meanwhile", async () => {
    const { userId, goalId, ids } = await setup([{ text: "Buy sunscreen" }]);
    const sunscreen = ids["Buy sunscreen"];
    later(5 * MINUTE);
    fake.remove(taskOf(sunscreen).id); // its notice is lost
    await updateCell(userId, sunscreen, { status: "done" });
    await updateGoal(userId, goalId, { status: "archived" });
    await drainTodoist(userId);
    expect(await getCell(userId, sunscreen)).toMatchObject({ status: "done", active: true });
    expect(await listTodoistLinks(userId)).toEqual([]);
    expect(await info(userId)).toMatchObject({ status: "ok", error: "" });
  });

  it("achieved keep their section while the person has tasks of their own in it", async () => {
    const { userId, todoistUserId, goalId, ids } = await setup([{ text: "Buy sunscreen" }]);
    const [section] = openSections();
    const where = { projectId: section.project_id, sectionId: section.id, userId: todoistUserId };
    const own = fake.add({ content: "Buy a mirror", ...where });
    const sunscreen = taskOf(ids["Buy sunscreen"]).id;
    later(5 * MINUTE);
    await updateGoal(userId, goalId, { status: "achieved" });
    await drainTodoist(userId);
    expect(fake.task(sunscreen)!.is_deleted).toBe(true);
    // Archiving the section would complete the person's own task, so it stays open.
    expect(fake.task(own.id)).toMatchObject({ checked: false, is_deleted: false });
    expect(sectionById(section.id)).toMatchObject({ is_archived: false, is_deleted: false });
  });

  it("deleted lose their open tasks, and their section is archived, never deleted", async () => {
    const { userId, goalId, ids } = await setup([{ text: "Buy sunscreen" }, { text: "Drink water", how: "day" }]);
    const run = await makeGoal(userId, "Run a marathon", [{ text: "Run 5 km", how: "day" }]);
    await drainTodoist(userId);
    const section = openSections().find((open) => open.name === "LOOKSMAXXING")!;
    const tasks = [taskOf(ids["Buy sunscreen"]).id, taskOf(ids["Drink water"]).id];
    later(5 * MINUTE);
    await deleteGoal(userId, goalId);
    await drainTodoist(userId);
    for (const id of tasks) expect(fake.task(id)!.is_deleted).toBe(true);
    expect(sectionById(section.id)).toMatchObject({ is_archived: true, is_deleted: false });
    expect(fake.commands().map((command) => command.type)).not.toContain("section_delete");
    expect((await listTodoistSections(userId)).map((row) => row.goalId)).toEqual([run.goalId]);
    expect((await listTodoistLinks(userId)).map((link) => link.cellId)).toEqual([run.ids["Run 5 km"]]);
    expect(taskOf(run.ids["Run 5 km"]).checked).toBe(false);
  });

  it("get a new section when the person deleted theirs in Todoist", async () => {
    const squares = [{ text: "Buy sunscreen" }, { text: "Try retinol", picked: false }];
    const { userId, todoistUserId, ids } = await setup(squares);
    const [section] = openSections();
    later(5 * MINUTE);
    const count = fake.webhooks().length;
    await asPerson(todoistUserId, { type: "section_delete", args: { id: section.id } });
    // Its task went with it.
    expect(await deliver(...noticesSince(count))).toEqual([200]);
    expect((await getCell(userId, ids["Buy sunscreen"])).active).toBe(false);
    later(MINUTE);
    await updateCell(userId, ids["Try retinol"], { active: true });
    await drainTodoist(userId);
    const [remade] = openSections();
    expect(remade).toMatchObject({ name: "LOOKSMAXXING", project_id: section.project_id });
    expect(remade.id).not.toBe(section.id);
    expect(taskOf(ids["Try retinol"]).section_id).toBe(remade.id);
  });
});

describe("ratings", () => {
  it("set the priority one way, and a priority set by hand stays until they change", async () => {
    const { userId, ids } = await setup([{ text: "Wash face", how: "day", impact: 3, effort: 1 }]);
    const face = ids["Wash face"];
    const id = taskOf(face).id;
    expect(fake.task(id)!.priority).toBe(2);
    later(5 * MINUTE);
    await updateCell(userId, face, { helps: [1] });
    await drainTodoist(userId);
    expect(fake.task(id)!.priority).toBe(3);

    later(MINUTE);
    expect(await deliver(fake.edit(id, { priority: 4 }))).toEqual([200]); // p1, by hand
    expect(await getCell(userId, face)).toMatchObject({ impact: 3, effort: 1, helps: [1] });
    later(MINUTE);
    await updateCell(userId, face, { text: "Wash face twice" });
    await drainTodoist(userId);
    expect(fake.task(id)).toMatchObject({ content: "Wash face twice", priority: 4 });

    later(MINUTE);
    await updateCell(userId, face, { impact: 1 });
    await drainTodoist(userId);
    expect(fake.task(id)!.priority).toBe(1);
  });
});

describe("what stays on one side", () => {
  it("Todoist keeps its own tasks, moves and times to itself", async () => {
    const squares: Square[] = [{ text: "Drink water", how: "day" }, { text: "Buy sunscreen" }];
    const { userId, todoistUserId, ids } = await setup(squares);
    const [section] = openSections();
    later(5 * MINUTE);
    const own = fake.add({ content: "Call mom", projectId: section.project_id, userId: todoistUserId });
    const ownNotices = [fake.edit(own.id, { content: "Call mom tonight" }), fake.complete(own.id)];
    const moved = fake.move(taskOf(ids["Buy sunscreen"]).id, { projectId: section.project_id });
    const timed = fake.edit(taskOf(ids["Drink water"]).id, {
      due: { string: "every day at 7am", date: "2026-10-28T07:00:00" },
    });
    expect(await deliver(...ownNotices, moved, timed)).toEqual([200, 200, 200, 200]);
    expect(await catchUpTodoist(userId, { force: true })).toMatchObject({ changed: false });
    const { goals } = await loadState(userId, "2000-01-01");
    expect(goals.flatMap((goal) => goal.cells.map((cell) => cell.text))).not.toContain("Call mom tonight");
    expect(await getCell(userId, ids["Drink water"])).toMatchObject({ kind: "habit", repeat: "day" });

    later(MINUTE);
    await updateCell(userId, ids["Buy sunscreen"], { text: "Buy SPF 50" });
    await setCheckin(userId, ids["Drink water"], TODAY, true);
    await drainTodoist(userId);
    // Still where the person moved it, and still at 7am.
    expect(taskOf(ids["Buy sunscreen"])).toMatchObject({ content: "Buy SPF 50", section_id: null });
    expect(taskOf(ids["Drink water"]).due).toMatchObject({ date: "2026-10-29T07:00:00", string: "every day at 7am" });
    expect(fake.task(own.id)).toMatchObject({ content: "Call mom tonight", checked: true, is_deleted: false });
  });

  it("Mandaala keeps 'doing', progress and ticks on earlier days to itself", async () => {
    const { userId, ids } = await setup([{ text: "Drink water", how: "day" }, { text: "Buy sunscreen" }]);
    later(5 * MINUTE);
    const commands = fake.commands().length;
    await updateCell(userId, ids["Buy sunscreen"], { status: "doing" });
    await updateCell(userId, ids["Buy sunscreen"], { progress: 60 });
    await setCheckin(userId, ids["Drink water"], "2026-10-26", true);
    await setCheckin(userId, ids["Drink water"], "2026-10-27", true);
    await setCheckin(userId, ids["Drink water"], "2026-10-26", false);
    await drainTodoist(userId);
    expect(fake.commands()).toHaveLength(commands);
    expect(taskOf(ids["Buy sunscreen"]).checked).toBe(false);
    expect(taskOf(ids["Drink water"]).due!.date).toBe(TODAY);
  });
});

describe("Todoist's notices of our own changes", () => {
  it("change nothing, even late, twice, or read again from the activity log", async () => {
    const { userId, ids } = await setup([{ text: "Drink water", how: "day" }, { text: "Buy sunscreen" }]);
    const water = ids["Drink water"];
    const sunscreen = ids["Buy sunscreen"];
    later(5 * MINUTE);
    let count = fake.webhooks().length;
    await setCheckin(userId, water, TODAY, true);
    await updateCell(userId, sunscreen, { text: "Buy SPF 50", status: "done" });
    await drainTodoist(userId);
    const first = noticesSince(count);
    later(MINUTE);
    count = fake.webhooks().length;
    await setCheckin(userId, water, TODAY, false);
    await updateCell(userId, sunscreen, { text: "Buy SPF 30", status: "todo" });
    await drainTodoist(userId);
    const second = noticesSince(count);
    // Todoist went forward and back, and completed the task and opened it again.
    expect(taskOf(water).due!.date).toBe(TODAY);
    expect(taskOf(sunscreen)).toMatchObject({ content: "Buy SPF 30", checked: false });

    later(MINUTE);
    const commands = fake.commands().length;
    const unchanged = async () => {
      expect(await checkins(userId, water)).toEqual([]);
      expect(await getCell(userId, sunscreen)).toMatchObject({ text: "Buy SPF 30", status: "todo" });
    };
    // The first notices come late, after the second change; then the second ones; then all once more.
    await deliverEach(first, unchanged);
    await deliverEach(second, unchanged);
    await deliverEach([...first, ...second].map(again), unchanged);
    expect(await catchUpTodoist(userId, { force: true })).toMatchObject({ changed: false });
    await unchanged();
    expect(fake.commands()).toHaveLength(commands);
    expect(taskOf(water).due!.date).toBe(TODAY);
  });

  it("do not hide a tick the person makes in Todoist soon after Mandaala ticked and unticked it", async () => {
    const { userId, ids } = await setup([{ text: "Drink water", how: "day" }, { text: "Buy sunscreen" }]);
    const water = ids["Drink water"];
    const sunscreen = ids["Buy sunscreen"];
    later(5 * MINUTE);
    const count = fake.webhooks().length;
    await setCheckin(userId, water, TODAY, true);
    await updateCell(userId, sunscreen, { status: "done" });
    await drainTodoist(userId);
    later(20_000);
    await setCheckin(userId, water, TODAY, false);
    await updateCell(userId, sunscreen, { status: "todo" });
    await drainTodoist(userId);
    // A minute later the person ticks both in Todoist: less than two minutes after Mandaala's ticks.
    later(MINUTE);
    fake.complete(taskOf(water).id);
    fake.complete(taskOf(sunscreen).id);
    const notices = noticesSince(count);
    expect(await deliver(...notices)).toEqual(allOk(notices));
    expect(await checkins(userId, water)).toEqual([TODAY]);
    expect((await getCell(userId, sunscreen)).status).toBe("done");
    // Read again from the activity log: nothing more, and nothing to send.
    expect(await catchUpTodoist(userId, { force: true })).toMatchObject({ changed: false });
    expect(await checkins(userId, water)).toEqual([TODAY]);
    expect(await nextTodoistOutbox(userId)).toBeNull();
  });
});

describe("Todoist's notices", () => {
  it("are refused without the right signature", async () => {
    const { userId, ids } = await setup([{ text: "Buy sunscreen" }]);
    later(5 * MINUTE);
    const notice = fake.complete(taskOf(ids["Buy sunscreen"]).id);
    const wrong = new Headers(notice.headers);
    wrong.set("X-Todoist-Hmac-SHA256", createHmac("sha256", "another-secret").update(notice.raw).digest("base64"));
    const unsigned = new Headers(notice.headers);
    unsigned.delete("X-Todoist-Hmac-SHA256");
    const answers = await deliver({ raw: notice.raw, headers: wrong }, { raw: notice.raw, headers: unsigned });
    expect(answers).toEqual([401, 401]);
    expect((await getCell(userId, ids["Buy sunscreen"])).status).toBe("todo");
    expect(await deliver(notice)).toEqual([200]);
    expect((await getCell(userId, ids["Buy sunscreen"])).status).toBe("done");
  });

  it("are applied once when Todoist delivers one twice", async () => {
    const { userId, ids } = await setup([{ text: "Drink water", how: "day" }]);
    const water = ids["Drink water"];
    later(5 * MINUTE);
    const notice = fake.complete(taskOf(water).id);
    expect(await deliver(notice)).toEqual([200]);
    expect(await checkins(userId, water)).toEqual([TODAY]);
    later(5 * MINUTE);
    // The person changes their mind in Mandaala: Todoist goes back to today.
    await setCheckin(userId, water, TODAY, false);
    await drainTodoist(userId);
    expect(taskOf(water).due!.date).toBe(TODAY);
    expect(await deliver(notice)).toEqual([200]);
    expect(await checkins(userId, water)).toEqual([]);
  });

  it("about a Todoist user nobody connected, or not JSON, change nothing", async () => {
    const stranger = fake.add({ content: "Call mom", userId: crypto.randomUUID() });
    expect(await deliver(fake.complete(stranger.id))).toEqual([200]);
    expect(await deliver(signed("{not json"))).toEqual([400]);
  });

  it("get 503 while another worker holds the account, so Todoist sends them again", async () => {
    const { userId, ids } = await setup([{ text: "Buy sunscreen" }]);
    later(5 * MINUTE);
    const notice = fake.complete(taskOf(ids["Buy sunscreen"]).id);
    const now = Date.now();
    expect(await claimTodoistLease(userId, "another-worker", now + MINUTE, now)).toBe(true);
    try {
      expect(await whileTimePasses(deliver(notice))).toEqual([503]);
      expect((await getCell(userId, ids["Buy sunscreen"])).status).toBe("todo");
    } finally {
      await releaseTodoistLease(userId, "another-worker");
    }
    expect(await deliver(notice)).toEqual([200]);
    expect((await getCell(userId, ids["Buy sunscreen"])).status).toBe("done");
  });

  it("about tasks and projects Mandaala did not make are answered at once, even while the account is busy", async () => {
    const { userId, todoistUserId } = await setup([{ text: "Buy sunscreen" }]);
    const [project] = mandaalaProjects();
    later(5 * MINUTE);
    const own = fake.add({ content: "Call mom", projectId: project.id, userId: todoistUserId });
    await asPerson(todoistUserId, { type: "project_add", args: { name: "Home" } });
    const home = fake.projects().find((other) => other.name === "Home")!;
    await whileBusy(userId, async () => {
      const notices = [fake.complete(own.id), fake.archiveProject(home.id)];
      expect(await whileTimePasses(deliver(...notices))).toEqual([200, 200]);
    });
    expect(await info(userId)).toMatchObject({ status: "ok" });
  });

  it("send at once a change made in Mandaala meanwhile, whose own send found the account busy", async () => {
    const { userId, ids } = await setup([{ text: "Drink water", how: "day" }, { text: "Buy sunscreen" }]);
    later(5 * MINUTE);
    // The person ticks the routine in Todoist, and the notice's read of the task is slow.
    const held = holdAnswers("/api/v1/tasks");
    const notice = deliver(fake.complete(taskOf(ids["Drink water"]).id));
    await held.reached;
    // Meanwhile a change in Mandaala gives up waiting for the account.
    await updateCell(userId, ids["Buy sunscreen"], { text: "Buy SPF 50" });
    await whileTimePasses(drainTodoist(userId));
    expect(taskOf(ids["Buy sunscreen"]).content).toBe("Buy sunscreen");
    held.go();
    expect(await notice).toEqual([200]);
    expect(await checkins(userId, ids["Drink water"])).toEqual([TODAY]);
    expect(taskOf(ids["Buy sunscreen"]).content).toBe("Buy SPF 50");
    expect(await nextTodoistOutbox(userId)).toBeNull();
  });

  it("send at once what they leave apart between the two apps", async () => {
    const { userId, ids } = await setup([{ text: "Buy sunscreen" }]);
    const sunscreen = ids["Buy sunscreen"];
    const id = taskOf(sunscreen).id;
    later(5 * MINUTE);
    await updateCell(userId, sunscreen, { text: "Buy SPF 50" });
    later(MINUTE);
    // The person's edit comes after Mandaala's, but its notice after Mandaala's change went out.
    const edit = fake.edit(id, { content: "Buy SPF 30" });
    later(MINUTE);
    await drainTodoist(userId);
    expect(fake.task(id)!.content).toBe("Buy SPF 50");
    expect(await deliver(edit)).toEqual([200]);
    // Their edit is the newer one: Mandaala takes it, and Todoist has it back at once.
    expect((await getCell(userId, sunscreen)).text).toBe("Buy SPF 30");
    expect(fake.task(id)!.content).toBe("Buy SPF 30");
    expect(await nextTodoistOutbox(userId)).toBeNull();
  });

  it("are turned away while the Todoist app is not set up", async () => {
    vi.stubEnv("TODOIST_CLIENT_SECRET", "");
    expect(await deliver(signed("{}"))).toEqual([404]);
    expect((await todoistInfo({ id: crypto.randomUUID(), todoist: false })).available).toBe(false);
  });
});

describe("sending again", () => {
  it("after a network failure uses the same command ids", async () => {
    const { userId, ids } = await setup([{ text: "Buy sunscreen" }]);
    later(5 * MINUTE);
    await updateCell(userId, ids["Buy sunscreen"], { text: "Buy SPF 50" });
    const before = syncRequests().length;
    fake.failNext(1, 0, { path: "/api/v1/sync" });
    await expect(drainTodoist(userId)).resolves.toBeUndefined();
    expect(taskOf(ids["Buy sunscreen"]).content).toBe("Buy sunscreen");
    later(3 * MINUTE);
    await drainTodoist(userId);
    const tries = syncRequests().slice(before);
    expect(tries).toHaveLength(2);
    expect(tries[1].map((command) => command.uuid)).toEqual(tries[0].map((command) => command.uuid));
    expect(taskOf(ids["Buy sunscreen"]).content).toBe("Buy SPF 50");
  });

  it("ticks a routine once when the answer to the tick was lost", async () => {
    const { userId, ids } = await setup([{ text: "Drink water", how: "day" }]);
    later(5 * MINUTE);
    await setCheckin(userId, ids["Drink water"], TODAY, true);
    const [row] = await dueTodoistOutbox(userId, Date.now(), 10);
    fake.dropResponseOf(commandId(`checkin:${row.id}`));
    await drainTodoist(userId);
    // Todoist ran it, but the app never heard: the tick waits to be sent again.
    expect(await nextTodoistOutbox(userId)).not.toBeNull();
    later(10 * MINUTE);
    await drainTodoist(userId);
    expect(await nextTodoistOutbox(userId)).toBeNull();
    expect(taskOf(ids["Drink water"]).due!.date).toBe("2026-10-29");
    expect(ran("item_update_date_complete")).toHaveLength(1);
  });

  it("finds a task by its link when the answer to its creation was lost", async () => {
    const { userId, ids } = await setup([{ text: "Buy sunscreen" }, { text: "Try retinol", picked: false }]);
    const retinol = ids["Try retinol"];
    later(5 * MINUTE);
    await updateCell(userId, retinol, { active: true });
    fake.failNext(1, 0, { path: "/api/v1/sync" });
    await drainTodoist(userId); // Todoist cannot be reached
    const create = syncRequests().at(-1)!.find((command) => command.type === "item_add")!;
    fake.dropResponseOf(create.uuid);
    later(3 * MINUTE);
    await drainTodoist(userId); // Todoist makes the task, but its answer is lost
    expect(tasksOf(retinol)).toHaveLength(1);
    expect(await nextTodoistOutbox(userId)).not.toBeNull();
    later(10 * MINUTE);
    await drainTodoist(userId);

    const creates = syncRequests()
      .flat()
      .filter((command) => command.type === "item_add" && command.args.content === "Try retinol");
    expect(new Set(creates.map((command) => command.uuid)).size).toBe(1);
    const task = taskOf(retinol); // one task, not two
    expect(await nextTodoistOutbox(userId)).toBeNull();
    later(5 * MINUTE);
    expect(await deliver(fake.complete(task.id))).toEqual([200]);
    expect((await getCell(userId, retinol)).status).toBe("done");
  });

  it("makes no second task when the square changes again before a lost creation is sent again", async () => {
    const { userId, ids } = await setup([{ text: "Buy sunscreen" }, { text: "Try retinol", picked: false }]);
    const retinol = ids["Try retinol"];
    later(5 * MINUTE);
    await updateCell(userId, retinol, { active: true });
    loseAnswerTo("item_add");
    await drainTodoist(userId); // Todoist makes the task, but its answer is lost: the change waits a minute
    expect(tasksOf(retinol)).toHaveLength(1);
    // The person goes on editing the square, and that change is due at once.
    await updateCell(userId, retinol, { notes: "Every other night" });
    await drainTodoist(userId);
    later(10 * MINUTE);
    await drainTodoist(userId);
    expect(taskOf(retinol).content).toBe("Try retinol"); // one task, not two
    expect(notesFrom(taskOf(retinol).description, APP)).toBe("Every other night");
    expect(await nextTodoistOutbox(userId)).toBeNull();
  });

  it("waits as long as Todoist asks after a 429", async () => {
    const { userId, ids } = await setup([{ text: "Buy sunscreen" }]);
    later(5 * MINUTE);
    await updateCell(userId, ids["Buy sunscreen"], { text: "Buy SPF 50" });
    fake.failNext(1, 429, { retryAfter: 30, path: "/api/v1/sync" });
    await drainTodoist(userId);
    expect(taskOf(ids["Buy sunscreen"]).content).toBe("Buy sunscreen");
    later(10_000);
    const tries = syncRequests().length;
    await drainTodoist(userId);
    expect(syncRequests()).toHaveLength(tries);
    later(MINUTE);
    await drainTodoist(userId);
    expect(taskOf(ids["Buy sunscreen"]).content).toBe("Buy SPF 50");
    expect(await info(userId)).toMatchObject({ status: "ok" });
  });
});

describe("the connection", () => {
  it("refreshes the token once it is an hour old, and keeps syncing", async () => {
    const { userId, ids } = await setup([{ text: "Buy sunscreen" }]);
    at(TODAY, "15:00"); // the token from connecting stopped working at 13:00
    await updateCell(userId, ids["Buy sunscreen"], { text: "Buy SPF 50" });
    await drainTodoist(userId);
    expect(taskOf(ids["Buy sunscreen"]).content).toBe("Buy SPF 50");
    expect(refreshes()).toBe(1);
    expect(await info(userId)).toMatchObject({ status: "ok", error: "" });
  });

  it("asks to connect again when Todoist refuses, keeps the changes, and sends them after", async () => {
    const someone = await setup([{ text: "Buy sunscreen" }]);
    const { userId, ids } = someone;
    fake.revokeApp(someone.todoistUserId); // the person removed the app in Todoist's settings
    later(2 * HOUR);
    await updateCell(userId, ids["Buy sunscreen"], { text: "Buy SPF 50" });
    await expect(drainTodoist(userId)).resolves.toBeUndefined();
    expect(await info(userId)).toMatchObject({
      connected: true,
      status: "reauth",
      error: "Todoist asked you to connect again.",
    });
    // No more tries until the person connects again.
    const requests = fake.requests().length;
    await drainTodoist(userId);
    expect(await catchUpTodoist(userId, { force: true })).toMatchObject({ changed: false });
    expect(fake.requests()).toHaveLength(requests);

    later(MINUTE);
    await connectAndSend(someone);
    expect(taskOf(ids["Buy sunscreen"]).content).toBe("Buy SPF 50"); // the same task: links were kept
    expect(mandaalaProjects()).toHaveLength(1);
    expect(await info(userId)).toMatchObject({ status: "ok", error: "" });
  });
});

describe("the catch-up", () => {
  it("finds what Todoist's notices missed: ticks, undos, edits and deletes", async () => {
    const { userId, ids } = await setup([
      { text: "Drink water", how: "day" },
      { text: "Stretch", how: "day" },
      { text: "Buy sunscreen" },
      { text: "Book a haircut" },
      { text: "Try retinol" },
    ]);
    const task = (text: string) => taskOf(ids[text]).id;
    later(5 * MINUTE);
    const count = fake.webhooks().length;
    // The person works in Todoist, and none of the notices arrive.
    fake.complete(task("Drink water"));
    fake.complete(task("Stretch"));
    fake.complete(task("Buy sunscreen"));
    fake.edit(task("Book a haircut"), { content: "Book a haircut on Friday" });
    fake.remove(task("Try retinol"));
    later(MINUTE);
    fake.uncomplete(task("Stretch"));
    later(MINUTE);

    expect(await catchUpTodoist(userId)).toMatchObject({ changed: true });
    expect(await checkins(userId, ids["Drink water"])).toEqual([TODAY]);
    expect(await checkins(userId, ids["Stretch"])).toEqual([]);
    expect((await getCell(userId, ids["Buy sunscreen"])).status).toBe("done");
    expect((await getCell(userId, ids["Book a haircut"])).text).toBe("Book a haircut on Friday");
    expect((await getCell(userId, ids["Try retinol"])).active).toBe(false);

    // The notices that turn up in the end change nothing more.
    const notices = noticesSince(count);
    expect(await deliver(...notices)).toEqual(allOk(notices));
    expect(await checkins(userId, ids["Drink water"])).toEqual([TODAY]);
    expect(await checkins(userId, ids["Stretch"])).toEqual([]);
    expect(await catchUpTodoist(userId, { force: true })).toMatchObject({ changed: false });
  });

  it("reads Todoist at most once a minute unless forced, and always sends what waits", async () => {
    const { userId, ids } = await setup([
      { text: "Buy sunscreen" },
      { text: "Book a haircut" },
      { text: "Try retinol" },
    ]);
    expect(await catchUpTodoist(userId)).toMatchObject({ changed: false });
    later(10_000);
    fake.complete(taskOf(ids["Buy sunscreen"]).id); // its notice is lost
    await updateCell(userId, ids["Book a haircut"], { text: "Book a haircut on Friday" });
    expect(await catchUpTodoist(userId)).toMatchObject({ changed: false });
    expect((await getCell(userId, ids["Buy sunscreen"])).status).toBe("todo");
    expect(taskOf(ids["Book a haircut"]).content).toBe("Book a haircut on Friday");
    expect(await catchUpTodoist(userId, { force: true })).toMatchObject({ changed: true });
    expect((await getCell(userId, ids["Buy sunscreen"])).status).toBe("done");

    later(10_000);
    fake.complete(taskOf(ids["Try retinol"]).id);
    expect(await catchUpTodoist(userId)).toMatchObject({ changed: false });
    later(2 * MINUTE);
    expect(await catchUpTodoist(userId)).toMatchObject({ changed: true });
    expect((await getCell(userId, ids["Try retinol"])).status).toBe("done");
  });

  it("counts the minute from the last real read, not from a call the limit skipped", async () => {
    const { userId, ids } = await setup([{ text: "Buy sunscreen" }]);
    const reads = () => fake.requests().filter((request) => request.url.pathname === "/api/v1/activities").length;
    expect(await catchUpTodoist(userId)).toMatchObject({ changed: false });
    const first = reads();
    later(40_000);
    fake.complete(taskOf(ids["Buy sunscreen"]).id); // its notice is lost
    expect(await catchUpTodoist(userId)).toMatchObject({ changed: false });
    expect(reads()).toBe(first);
    later(30_000); // a minute after the first read, 30 s after the skipped call
    expect(await catchUpTodoist(userId)).toMatchObject({ changed: true });
    expect(reads()).toBe(first + 1);
  });

  it("moves a missed daily routine to today once a day, keeping its time, and leaves other repeats", async () => {
    const { userId, ids } = await setup([
      { text: "Drink water", how: "day" },
      { text: "Stretch", how: "day" },
      { text: "Floss", how: "day" },
      { text: "Cut nails", how: "week", on: 0 },
    ]);
    const task = (text: string) => taskOf(ids[text]);
    later(5 * MINUTE);
    const timed = fake.edit(task("Stretch").id, { due: { string: "every day at 7am", date: "2026-10-28T07:00:00" } });
    const custom = fake.edit(task("Floss").id, { due: { string: "every 2 days", date: TODAY } });
    expect(await deliver(timed, custom)).toEqual([200, 200]);

    at("2026-10-30");
    await catchUpTodoist(userId);
    expect(task("Drink water").due).toMatchObject({ date: "2026-10-30", string: "every day" });
    expect(task("Stretch").due).toMatchObject({ date: "2026-10-30T07:00:00", string: "every day at 7am" });
    expect(task("Floss").due).toMatchObject({ date: TODAY, string: "every 2 days" });
    expect(await checkins(userId, ids["Drink water"])).toEqual([]);

    // Once a day: put back on yesterday, it stays there until tomorrow.
    later(HOUR);
    const yesterday = fake.edit(task("Drink water").id, { due: { string: "every day", date: "2026-10-29" } });
    expect(await deliver(yesterday)).toEqual([200]);
    await catchUpTodoist(userId, { force: true });
    expect(task("Drink water").due!.date).toBe("2026-10-29");

    at("2026-11-03");
    await catchUpTodoist(userId);
    expect(task("Drink water").due!.date).toBe("2026-11-03");
    expect(task("Stretch").due!.date).toBe("2026-11-03T07:00:00");
    expect(task("Floss").due!.date).toBe(TODAY);
    // A weekly routine stays on its late Sunday.
    expect(task("Cut nails").due!.date).toBe("2026-11-01");
  });
});

describe("leaving Todoist", () => {
  it("by disconnecting revokes the token and forgets everything, but the tasks stay in Todoist", async () => {
    const { userId, ids } = await setup([{ text: "Buy sunscreen" }, { text: "Drink water", how: "day" }]);
    const id = taskOf(ids["Buy sunscreen"]).id;
    later(5 * MINUTE);
    await disconnectTodoist(userId);
    expect(await todoistRows(userId)).toBe(0);
    expect(revokes()).toBe(1);
    expect(await todoistInfo({ id: userId, todoist: false })).toEqual({
      available: true,
      connected: false,
      status: null,
      email: "",
      lastSyncAt: null,
      error: "",
    });
    expect(fake.tasks().filter((task) => !task.is_deleted)).toHaveLength(2);

    // Nothing goes to Todoist any more, and its notices change nothing.
    const requests = fake.requests().length;
    await updateCell(userId, ids["Buy sunscreen"], { text: "Buy SPF 50" });
    await drainTodoist(userId);
    await catchUpTodoist(userId, { force: true });
    expect(fake.requests()).toHaveLength(requests);
    expect(await deliver(fake.complete(id))).toEqual([200]);
    expect(await getCell(userId, ids["Buy sunscreen"])).toMatchObject({ text: "Buy SPF 50", status: "todo" });
    expect(await todoistRows(userId)).toBe(0);
  });

  it("by deleting the account leaves no Todoist rows, even when Todoist is down", async () => {
    const first = await setup([{ text: "Buy sunscreen" }]);
    await revokeTodoist(first.userId);
    await deleteUser(first.userId);
    expect(await todoistRows(first.userId)).toBe(0);
    expect(revokes()).toBe(1);

    const second = await setup([{ text: "Buy sunscreen" }]);
    fake.failNext(5, 0);
    await expect(revokeTodoist(second.userId)).resolves.toBeUndefined();
    await deleteUser(second.userId);
    expect(await todoistRows(second.userId)).toBe(0);
    later(5 * MINUTE);
    expect(await deliver(fake.complete(taskOf(second.ids["Buy sunscreen"]).id))).toEqual([200]);
  });

  it("by disconnecting works even when Todoist is down", async () => {
    const { userId } = await setup([{ text: "Buy sunscreen" }]);
    fake.failNext(5, 0);
    await expect(disconnectTodoist(userId)).resolves.toBeUndefined();
    expect(await todoistRows(userId)).toBe(0);
  });
});

describe("two accounts", () => {
  it("never see or change each other's Todoist data", async () => {
    const alex = await setup([{ text: "Read 10 pages", how: "day" }]);
    const bea = await setup([{ text: "Read 10 pages", how: "day" }]);
    const alexTask = taskOf(alex.ids["Read 10 pages"]);
    const beaTask = taskOf(bea.ids["Read 10 pages"]);
    expect(alexTask.user_id).toBe(alex.todoistUserId);
    expect(beaTask.user_id).toBe(bea.todoistUserId);
    expect(alexTask.project_id).not.toBe(beaTask.project_id);

    later(5 * MINUTE);
    const beaTick = fake.complete(beaTask.id);
    expect(await deliver(beaTick)).toEqual([200]);
    expect(await checkins(bea.userId, bea.ids["Read 10 pages"])).toEqual([TODAY]);
    expect(await checkins(alex.userId, alex.ids["Read 10 pages"])).toEqual([]);
    // A notice from Bea's Todoist that names Alex's task changes nothing.
    const payload = JSON.parse(beaTick.raw);
    payload.event_data.id = alexTask.id;
    expect(await deliver(signed(JSON.stringify(payload)))).toEqual([200]);
    expect(await checkins(alex.userId, alex.ids["Read 10 pages"])).toEqual([]);

    // Each account sends only its own changes.
    await updateCell(bea.userId, bea.ids["Read 10 pages"], { text: "Read 15 pages" });
    await drainTodoist(alex.userId);
    expect(fake.task(beaTask.id)!.content).toBe("Read 10 pages");
    await drainTodoist(bea.userId);
    expect(fake.task(beaTask.id)!.content).toBe("Read 15 pages");

    // Bea cannot take Alex's Todoist account, and her disconnect leaves Alex connected.
    const { url, cookie } = startTodoistConnect(bea.userId, APP);
    const { code, state } = fake.approve(url, alex.todoistUserId);
    expect(await finishTodoistConnect(bea.userId, { code, state, error: null, cookie, origin: APP })).toBe("taken");
    expect(revokes()).toBe(0);
    await disconnectTodoist(bea.userId);
    later(MINUTE);
    await updateCell(alex.userId, alex.ids["Read 10 pages"], { text: "Read 20 pages" });
    await drainTodoist(alex.userId);
    expect(fake.task(alexTask.id)!.content).toBe("Read 20 pages");
    expect(await info(alex.userId)).toMatchObject({ connected: true, status: "ok" });
  });
});

describe("the daily job", () => {
  it("catches up every connected account and sweeps old deliveries", async () => {
    const alex = await setup([{ text: "Buy sunscreen" }]);
    const bea = await setup([{ text: "Drink water", how: "day" }]);
    const old = crypto.randomUUID();
    await recordTodoistDelivery(old, 0);
    later(5 * MINUTE);
    // Done in Todoist; the notices are lost.
    fake.complete(taskOf(alex.ids["Buy sunscreen"]).id);
    fake.complete(taskOf(bea.ids["Drink water"]).id);
    expect(await runTodoistDaily()).toEqual({ accounts: 2 });
    expect((await getCell(alex.userId, alex.ids["Buy sunscreen"])).status).toBe("done");
    expect(await checkins(bea.userId, bea.ids["Drink water"])).toEqual([TODAY]);
    expect(await todoistDeliverySeen(old)).toBe(false);
  });
});

describe("while paused", () => {
  it("is not offered, and nothing goes between the two apps", async () => {
    const { userId, ids } = await setup([{ text: "Buy sunscreen" }, { text: "Drink water", how: "day" }]);
    later(5 * MINUTE);
    vi.stubEnv("TODOIST_SYNC", "");
    const requests = fake.requests().length;
    // The account page shows no Todoist, so the app asks for no syncs.
    expect(await info(userId)).toMatchObject({ available: false, connected: false });

    // Deleted, finished and ticked in Todoist: the notices are taken, and Mandaala stays as it is,
    // through the catch-up and the daily job too.
    const notices = [
      fake.remove(taskOf(ids["Buy sunscreen"]).id),
      fake.completeForever(taskOf(ids["Drink water"]).id),
    ];
    expect(await deliver(...notices)).toEqual(allOk(notices));
    expect(await catchUpTodoist(userId, { force: true })).toBeNull();
    expect(await runTodoistDaily()).toEqual({ accounts: 0 });
    expect(await getCell(userId, ids["Buy sunscreen"])).toMatchObject({ active: true, status: "todo" });
    expect(await getCell(userId, ids["Drink water"])).toMatchObject({ active: true, status: "todo", kind: "habit" });
    expect(await checkins(userId, ids["Drink water"])).toEqual([]);

    // Changes made here are not kept for Todoist, and nothing is sent.
    await setCheckin(userId, ids["Drink water"], TODAY, true);
    await updateCell(userId, ids["Buy sunscreen"], { text: "Buy SPF 30" });
    expect(await nextTodoistOutbox(userId)).toBeNull();
    await drainTodoist(userId);

    // Nobody connects meanwhile, not even with an approval started before the pause.
    const other = await person();
    const { url, cookie } = startTodoistConnect(other.userId, APP);
    const { code, state } = fake.approve(url, other.todoistUserId);
    expect(await finishTodoistConnect(other.userId, { code, state, error: null, cookie, origin: APP })).toBe("error");
    expect(await todoistRows(other.userId)).toBe(0);
    expect(fake.requests()).toHaveLength(requests);
  });
});
