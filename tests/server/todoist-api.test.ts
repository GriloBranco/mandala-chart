import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimTodoistLease, getTodoistAccount, saveTodoistAccount, type TodoistAccountRow } from "@/server/repo";
import {
  authorizeUrl,
  commandId,
  exchangeCode,
  refreshTokens,
  revokeToken,
  setTodoistFetch,
  todoistApi,
  TodoistError,
  type SyncCommand,
  type TodoistApi,
} from "@/server/todoist/api";
import { openToken, sealToken, signValue } from "@/server/todoist/crypto";
import { withTodoist } from "@/server/todoist/session";
import { newAccount } from "../support/accounts";
import { DEFAULT_TODOIST_USER, FakeTodoist, type FakeWebhook } from "../support/fake-todoist";

process.env.TODOIST_CLIENT_ID = "test-client-id";
process.env.TODOIST_CLIENT_SECRET = "test-client-secret";

const REDIRECT = "https://mandaala.test/api/todoist/callback";
const HOUR = 3_600_000;

let fake: FakeTodoist;

beforeEach(() => {
  fake = new FakeTodoist();
  setTodoistFetch(fake.fetch);
});

afterEach(() => {
  setTodoistFetch(null);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** The TodoistError a promise rejects with. */
async function failure(promise: Promise<unknown>): Promise<TodoistError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TodoistError) return error;
    throw error;
  }
  throw new Error("Expected a TodoistError");
}

/** How many times anyone asked the fake for a refreshed token. */
function refreshes(): number {
  return fake
    .requests()
    .filter((r) => r.url.pathname === "/oauth/access_token")
    .filter((r) => new URLSearchParams(r.body).get("grant_type") === "refresh_token").length;
}

/** A client that always sends this token; a "refresh" gives the same one back. */
function clientFor(accessToken: string): TodoistApi {
  return todoistApi({ token: async () => accessToken, refresh: async () => accessToken });
}

function command(type: string, args: Record<string, unknown>, withTempId = false): SyncCommand {
  return { type, uuid: crypto.randomUUID(), args, ...(withTempId ? { temp_id: crypto.randomUUID() } : {}) };
}

/** A new Mandaala project in the fake, made through the API. */
async function newProject(api: TodoistApi): Promise<string> {
  const add = command("project_add", { name: "Mandaala" }, true);
  return (await api.sync({ commands: [add] })).temp_id_mapping![add.temp_id!];
}

/** A Mandaala account connected to a new Todoist user, its tokens sealed in the database as connecting does. */
async function connectedAccount(changes: Partial<Omit<TodoistAccountRow, "userId">> = {}) {
  const user = await newAccount();
  const todoistUserId = crypto.randomUUID();
  const tokens = await exchangeCode(fake.authorize(todoistUserId), REDIRECT);
  const now = new Date().toISOString();
  await saveTodoistAccount(user.id, {
    todoistUserId,
    email: `${todoistUserId}@example.com`,
    accessToken: sealToken(tokens.accessToken),
    refreshToken: tokens.refreshToken && sealToken(tokens.refreshToken),
    expiresAt: tokens.expiresAt,
    projectId: null,
    appUrl: "https://mandaala.test",
    timeZone: "UTC",
    weekStart: 1,
    status: "ok",
    lastError: "",
    syncToken: null,
    activitySince: now,
    lastSyncAt: null,
    lastCatchupAt: 0,
    rolloverDay: "",
    connectedAt: now,
    ...changes,
  });
  return { userId: user.id, todoistUserId, tokens };
}

describe("sealed tokens", () => {
  it("open back to the token and never show it", () => {
    const sealed = sealToken("secret-token");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("secret-token");
    expect(sealToken("secret-token")).not.toBe(sealed); // a new IV every time
    expect(openToken(sealed)).toBe("secret-token");
  });

  it("refuse a changed token", () => {
    const [version, iv, data] = sealToken("secret-token").split(".");
    const changed = (data[0] === "A" ? "B" : "A") + data.slice(1);
    expect(() => openToken([version, iv, changed].join("."))).toThrow();
    expect(() => openToken("secret-token")).toThrow();
  });

  it("refuse a token sealed with another key", () => {
    vi.stubEnv("TODOIST_TOKEN_KEY", Buffer.alloc(32, 1).toString("base64"));
    const sealed = sealToken("secret-token");
    expect(openToken(sealed)).toBe("secret-token");
    vi.stubEnv("TODOIST_TOKEN_KEY", Buffer.alloc(32, 2).toString("base64"));
    expect(() => openToken(sealed)).toThrow();
    vi.stubEnv("TODOIST_TOKEN_KEY", "");
    expect(() => openToken(sealed)).toThrow();
  });

  it("use a key from SESSION_SECRET when TODOIST_TOKEN_KEY is not set", () => {
    vi.stubEnv("TODOIST_TOKEN_KEY", "");
    const sealed = sealToken("secret-token");
    vi.stubEnv("SESSION_SECRET", "another-session-secret-long-enough");
    expect(() => openToken(sealed)).toThrow();
  });

  it("need a 32-byte TODOIST_TOKEN_KEY, and a secret in production", () => {
    vi.stubEnv("TODOIST_TOKEN_KEY", Buffer.alloc(16).toString("base64"));
    expect(() => sealToken("x")).toThrow(/32/);
    vi.stubEnv("TODOIST_TOKEN_KEY", "");
    vi.stubEnv("SESSION_SECRET", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => sealToken("x")).toThrow();
  });

  it("sign values with a key for each purpose", () => {
    const signed = signValue("todoist-state", "state.user");
    expect(signed).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(signValue("todoist-state", "state.user")).toBe(signed);
    expect(signValue("todoist-other", "state.user")).not.toBe(signed);
    expect(signValue("todoist-state", "state.other")).not.toBe(signed);
  });
});

describe("command ids", () => {
  it("are the same UUID for the same seed and another for another seed", () => {
    expect(commandId("abc")).toBe("ba7816bf-8f01-5fea-8141-40de5dae2223");
    const seed = ["user", "cell", "item_update", 3, "{}"].join(":");
    expect(commandId(seed)).toBe(commandId(seed));
    expect(commandId(seed.replace(":3:", ":4:"))).not.toBe(commandId(seed));
    expect(commandId("anything")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("OAuth", () => {
  it("builds an approval URL that Todoist accepts", () => {
    const url = new URL(authorizeUrl("state-1", REDIRECT));
    expect(`${url.origin}${url.pathname}`).toBe("https://app.todoist.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "test-client-id",
      scope: "data:read_write,data:delete",
      state: "state-1",
      redirect_uri: REDIRECT,
      response_type: "code",
    });
    expect(fake.approve(url.toString())).toMatchObject({ state: "state-1", redirectUri: REDIRECT });
  });

  it("swaps a code once for tokens that last an hour", async () => {
    const code = fake.authorize();
    const tokens = await exchangeCode(code, REDIRECT);
    expect(tokens.refreshToken).toEqual(expect.any(String));
    expect(tokens.expiresAt! - Date.now()).toBeGreaterThan(HOUR - 5000);
    expect((await failure(exchangeCode(code, REDIRECT))).status).toBe(400);
    const request = fake.requests()[0];
    expect(request.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(request.body))).toMatchObject({
      client_id: "test-client-id",
      client_secret: "test-client-secret",
      code,
      redirect_uri: REDIRECT,
    });
  });

  it("rotates the refresh token on every refresh", async () => {
    const first = await exchangeCode(fake.authorize(), REDIRECT);
    const second = await refreshTokens(first.refreshToken!);
    const third = await refreshTokens(second.refreshToken!);
    expect(new Set([first.refreshToken, second.refreshToken, third.refreshToken]).size).toBe(3);
    expect(third.accessToken).not.toBe(second.accessToken);
    expect((await clientFor(third.accessToken).user()).id).toBe(DEFAULT_TODOIST_USER);
  });

  it("answers a retry inside the 60 s grace window with the same access token and no refresh token", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const first = await exchangeCode(fake.authorize(), REDIRECT);
    const rotated = await refreshTokens(first.refreshToken!);
    vi.setSystemTime(Date.now() + 59_000);
    const retry = await refreshTokens(first.refreshToken!);
    expect(retry.accessToken).toBe(rotated.accessToken);
    expect(retry.refreshToken).toBeNull();
    expect(retry.expiresAt).toEqual(expect.any(Number));
  });

  it("revokes every token when a spent refresh token comes back after the grace window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const first = await exchangeCode(fake.authorize(), REDIRECT);
    const rotated = await refreshTokens(first.refreshToken!);
    vi.setSystemTime(Date.now() + 61_000);
    expect((await failure(refreshTokens(first.refreshToken!))).status).toBe(401);
    expect((await failure(clientFor(rotated.accessToken).user())).status).toBe(401);
    expect((await failure(refreshTokens(rotated.refreshToken!))).status).toBe(401);
  });

  it("gives legacy apps a token that never expires", async () => {
    const legacy = new FakeTodoist({ legacyTokens: true });
    setTodoistFetch(legacy.fetch);
    expect(await exchangeCode(legacy.authorize(), REDIRECT)).toMatchObject({ refreshToken: null, expiresAt: null });
  });

  it("does not take a refusal of our app for a lost connection", async () => {
    setTodoistFetch(new FakeTodoist({ clientSecret: "another-secret" }).fetch);
    expect((await failure(refreshTokens("anything"))).status).toBe(400);
  });

  it("revokes a token with the app's Basic auth, and never throws doing it", async () => {
    const tokens = await exchangeCode(fake.authorize(), REDIRECT);
    await revokeToken(tokens.accessToken);
    expect((await failure(clientFor(tokens.accessToken).user())).status).toBe(401);
    expect((await failure(refreshTokens(tokens.refreshToken!))).status).toBe(401);
    const revoke = fake.requests().find((r) => r.url.pathname === "/api/v1/revoke")!;
    const basic = Buffer.from("test-client-id:test-client-secret").toString("base64");
    expect(revoke.headers.get("authorization")).toBe(`Basic ${basic}`);
    expect(Object.fromEntries(new URLSearchParams(revoke.body))).toEqual({
      token: tokens.accessToken,
      token_type_hint: "access_token",
    });
    fake.failNext(1, 0);
    await expect(revokeToken(tokens.accessToken)).resolves.toBeUndefined();
  });
});

describe("the API client", () => {
  let api: TodoistApi;

  beforeEach(() => {
    api = clientFor(fake.grant().accessToken);
  });

  it("sends /sync form-encoded, and every request with a timeout", async () => {
    const add = command("project_add", { name: "Mandaala" }, true);
    const result = await api.sync({ commands: [add], syncToken: "*", resourceTypes: ["projects", "user"] });
    expect(result.sync_status).toEqual({ [add.uuid]: "ok" });
    expect(result.projects!.map((p) => p.id)).toContain(result.temp_id_mapping![add.temp_id!]);
    expect(result.user!.id).toBe(DEFAULT_TODOIST_USER);
    const request = fake.requests().at(-1)!;
    expect(request.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    expect(request.headers.get("authorization")).toMatch(/^Bearer \S+$/);
    const form = new URLSearchParams(request.body);
    expect(JSON.parse(form.get("commands")!)).toEqual([add]);
    expect(form.get("sync_token")).toBe("*");
    expect(JSON.parse(form.get("resource_types")!)).toEqual(["projects", "user"]);
    await api.user();
    expect(fake.requests().every((r) => r.signal instanceof AbortSignal)).toBe(true);
  });

  it("resolves temp ids within a request, and runs a repeated uuid once", async () => {
    const project = command("project_add", { name: "Mandaala" }, true);
    const section = command("section_add", { name: "Read", project_id: project.temp_id }, true);
    const due = { string: "every day", date: "2026-10-25", lang: "en" };
    const where = { project_id: project.temp_id, section_id: section.temp_id };
    const add = command("item_add", { content: "Read", ...where, due }, true);
    const first = await api.sync({ commands: [project, section, add] });
    expect(Object.values(first.sync_status!)).toEqual(["ok", "ok", "ok"]);
    expect(fake.task(first.temp_id_mapping![add.temp_id!])).toMatchObject({
      section_id: first.temp_id_mapping![section.temp_id!],
      due: { date: "2026-10-25", string: "every day", lang: "en", is_recurring: true },
    });
    const again = await api.sync({ commands: [project, section, add] });
    expect(Object.values(again.sync_status!)).toEqual(["ok", "ok", "ok"]);
    expect(again.temp_id_mapping).toEqual({});
    expect(fake.tasks()).toHaveLength(1);
    expect(fake.commands().map((c) => c.repeated)).toEqual([false, false, false, true, true, true]);
  });

  it("answers a command on a missing task with Todoist's error object", async () => {
    const update = command("item_update", { id: "6X7rM8997g3RQmvh", content: "x" });
    const result = await api.sync({ commands: [update] });
    expect(result.sync_status![update.uuid]).toMatchObject({
      error_tag: "ITEM_NOT_FOUND",
      error_code: 22,
      http_code: 404,
    });
  });

  it("reads every page of tasks, active ones only", async () => {
    const projectId = await newProject(api);
    const ids: string[] = [];
    for (const size of [100, 100, 50]) {
      const adds = Array.from({ length: size }, (_, i) =>
        command("item_add", { content: `Task ${i}`, project_id: projectId }, true),
      );
      const result = await api.sync({ commands: adds });
      ids.push(...adds.map((add) => result.temp_id_mapping![add.temp_id!]));
    }
    const before = fake.requests().length;
    expect(await api.projectTasks(projectId)).toHaveLength(250);
    expect(fake.requests().length - before).toBe(2); // pages of 200
    await api.sync({ commands: [command("item_complete", { id: ids[0] }), command("item_delete", { id: ids[1] })] });
    const found = await api.tasks([...ids, ids[2]]);
    expect(found).toHaveLength(248);
    expect(found.map((task) => task.id)).not.toContain(ids[0]);
    expect(found.map((task) => task.id)).not.toContain(ids[1]);
    expect(await api.tasks([])).toEqual([]);
  });

  it("reads a project's sections, and null for a project that is gone", async () => {
    const projectId = await newProject(api);
    await api.sync({ commands: [command("section_add", { name: "Read", project_id: projectId })] });
    expect((await api.sections(projectId)).map((section) => section.name)).toEqual(["Read"]);
    expect(await api.project(projectId)).toMatchObject({ id: projectId, name: "Mandaala" });
    fake.removeProject(projectId);
    expect(await api.project(projectId)).toBeNull();
  });

  it("reads what changed after a sync token, completed tasks too", async () => {
    const projectId = await newProject(api);
    const add = command("item_add", { content: "Stretch", project_id: projectId }, true);
    const taskId = (await api.sync({ commands: [add] })).temp_id_mapping![add.temp_id!];
    const full = await api.sync({ syncToken: "*", resourceTypes: ["items"] });
    expect(full.full_sync).toBe(true);
    expect(full.items!.map((item) => item.id)).toEqual([taskId]);
    fake.complete(taskId);
    const changes = await api.sync({ syncToken: full.sync_token, resourceTypes: ["items"] });
    expect(changes.full_sync).toBe(false);
    expect(changes.items).toEqual([expect.objectContaining({ id: taskId, checked: true })]);
    expect((await api.sync({ syncToken: changes.sync_token, resourceTypes: ["items"] })).items).toEqual([]);
  });

  it("lists item activity oldest first, and only after `since`", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-25T10:00:00Z"));
    api = clientFor(fake.grant().accessToken);
    const task = fake.add({ content: "Stretch" });
    vi.setSystemTime(new Date("2026-10-25T10:01:00Z"));
    fake.complete(task.id);
    vi.setSystemTime(new Date("2026-10-25T10:02:00Z"));
    fake.uncomplete(task.id);
    expect((await api.activities("")).map((event) => event.event_type)).toEqual(["added", "completed", "uncompleted"]);
    const since = await api.activities("2026-10-25T10:00:00.000Z");
    expect(since.map((event) => event.event_type)).toEqual(["completed", "uncompleted"]);
    expect(since[0]).toMatchObject({
      object_type: "item",
      object_id: task.id,
      event_date: "2026-10-25T10:01:00.000000Z",
    });
  });

  it("reads at most maxPages pages of activity", async () => {
    for (let i = 0; i < 250; i++) fake.add({ content: `Task ${i}` });
    const events = await api.activities("", 1);
    expect(events).toHaveLength(200);
    expect(events.at(-1)!.extra_data!.content).toBe("Task 249"); // Todoist lists the newest first
  });

  it("asks for a new token once after a 401, then tries again", async () => {
    let asked = 0;
    const refreshTo = (token: string) => async () => {
      asked++;
      return token;
    };
    const client = todoistApi({ token: async () => "dead-token", refresh: refreshTo(fake.grant().accessToken) });
    expect((await client.user()).id).toBe(DEFAULT_TODOIST_USER);
    expect(asked).toBe(1);
    const stuck = todoistApi({ token: async () => "dead-token", refresh: refreshTo("still-dead") });
    expect((await failure(stuck.user())).status).toBe(401);
    expect(asked).toBe(2);
  });

  it("passes on how long Todoist asked to wait after a 429", async () => {
    fake.failNext(1, 429, { retryAfter: 30 });
    expect(await failure(api.user())).toMatchObject({ status: 429, retryAfter: 30 });
  });

  it("throws 5xx with a wait only when Todoist sent one", async () => {
    fake.failNext(1, 503);
    expect(await failure(api.user())).toMatchObject({ status: 503, retryAfter: null });
    fake.failNext(1, 500, { retryAfter: 5 });
    const read = api.sync({ syncToken: "*", resourceTypes: ["user"] });
    expect(await failure(read)).toMatchObject({ status: 500, retryAfter: 5 });
  });

  it("throws status 0 when Todoist cannot be reached or does not answer in time", async () => {
    fake.failNext(1, 0);
    expect(await failure(api.user())).toMatchObject({ status: 0, retryAfter: null });
    setTodoistFetch(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    expect(await failure(api.user())).toMatchObject({ status: 0, message: "Todoist did not answer in time." });
  });

  it("throws other 4xx with Todoist's error code and no wait", async () => {
    const error = await failure(api.sync({ syncToken: "not-a-token", resourceTypes: ["items"] }));
    expect(error).toMatchObject({ status: 400, code: 20, retryAfter: null });
  });
});

describe("one Todoist worker per account", () => {
  it("runs nothing without a Todoist account", async () => {
    const user = await newAccount();
    expect(await withTodoist(user.id, async () => "ran")).toBeNull();
  });

  it("lets one worker in at a time, and the next one after it is done", async () => {
    const { userId } = await connectedAccount();
    let finish: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const steps: string[] = [];
    const first = withTodoist(userId, async () => {
      steps.push("first in");
      await held;
      steps.push("first out");
      return "first";
    });
    await vi.waitFor(() => expect(steps).toEqual(["first in"]));
    expect(await withTodoist(userId, async () => "second")).toBeNull();
    const third = withTodoist(
      userId,
      async () => {
        steps.push("third in");
        return "third";
      },
      { waitMs: 5000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(steps).toEqual(["first in"]);
    finish();
    expect(await first).toBe("first");
    expect(await third).toBe("third");
    expect(steps).toEqual(["first in", "first out", "third in"]);
  });

  it("releases the lease when the work throws", async () => {
    const { userId } = await connectedAccount();
    await expect(withTodoist(userId, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await withTodoist(userId, async () => "next")).toBe("next");
  });

  it("stops a worker whose lease ran out and was taken", async () => {
    const { userId } = await connectedAccount();
    vi.useFakeTimers({ toFake: ["Date"] });
    const run = withTodoist(userId, async (worker) => {
      await worker.keepAlive();
      vi.setSystemTime(Date.now() + 61_000);
      expect(await claimTodoistLease(userId, "another-worker", Date.now() + 60_000, Date.now())).toBe(true);
      await worker.keepAlive();
    });
    await expect(run).rejects.toThrow("Another Todoist worker took over this account.");
  });

  it("saves changes to the account row and to worker.account", async () => {
    const { userId } = await connectedAccount();
    await withTodoist(userId, async (worker) => {
      await worker.update({ lastError: "Something went wrong.", syncToken: "token-1", projectId: undefined });
      expect(worker.account).toMatchObject({
        lastError: "Something went wrong.",
        syncToken: "token-1",
        projectId: null,
      });
    });
    expect(await getTodoistAccount(userId)).toMatchObject({ lastError: "Something went wrong.", syncToken: "token-1" });
  });
});

describe("tokens in a worker", () => {
  it("are stored sealed", async () => {
    const { userId, tokens } = await connectedAccount();
    const row = (await getTodoistAccount(userId))!;
    expect(row.accessToken).not.toContain(tokens.accessToken);
    expect(openToken(row.accessToken)).toBe(tokens.accessToken);
    expect(openToken(row.refreshToken!)).toBe(tokens.refreshToken);
  });

  it("are refreshed before use when they expire within a minute, and the new pair is saved sealed", async () => {
    const { userId, todoistUserId, tokens } = await connectedAccount({ expiresAt: Date.now() + 30_000 });
    const user = await withTodoist(userId, (worker) => worker.api.user());
    expect(user?.id).toBe(todoistUserId);
    expect(refreshes()).toBe(1);
    const row = (await getTodoistAccount(userId))!;
    expect(openToken(row.accessToken)).not.toBe(tokens.accessToken);
    expect(openToken(row.refreshToken!)).not.toBe(tokens.refreshToken);
    expect(row.expiresAt! - Date.now()).toBeGreaterThan(HOUR - 60_000);
    expect(fake.requests().at(-1)!.headers.get("authorization")).toBe(`Bearer ${openToken(row.accessToken)}`);
  });

  it("are refreshed once after a 401", async () => {
    const { userId, todoistUserId } = await connectedAccount({ expiresAt: Date.now() + 10 * HOUR });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * HOUR); // Todoist's token died while we thought it had hours left
    expect((await withTodoist(userId, (worker) => worker.api.user()))?.id).toBe(todoistUserId);
    expect(refreshes()).toBe(1);
  });

  it("keep the stored refresh token when a retry inside the grace window brings none", async () => {
    const { userId, tokens } = await connectedAccount({ expiresAt: Date.now() + 30_000 });
    const before = (await getTodoistAccount(userId))!;
    // The first answer is lost after Todoist spent the refresh token; the worker asks again at once.
    let lose = true;
    setTodoistFetch(async (input, init) => {
      const response = await fake.fetch(input, init);
      if (lose && String(input).endsWith("/oauth/access_token")) {
        lose = false;
        throw new TypeError("fetch failed");
      }
      return response;
    });
    expect(await withTodoist(userId, (worker) => worker.api.user())).not.toBeNull();
    expect(refreshes()).toBe(2);
    const after = (await getTodoistAccount(userId))!;
    expect(after.refreshToken).toBe(before.refreshToken);
    expect(openToken(after.accessToken)).not.toBe(tokens.accessToken);
  });

  it("set reauth when Todoist refuses the refresh, and are not asked for again", async () => {
    const { userId, todoistUserId } = await connectedAccount({ expiresAt: Date.now() + 30_000 });
    fake.revokeApp(todoistUserId);
    const calls = await withTodoist(userId, async (worker) => {
      const first = await failure(worker.api.user());
      const second = await failure(worker.api.sync({ syncToken: "*", resourceTypes: ["user"] }));
      return [first.status, second.status];
    });
    expect(calls).toEqual([401, 401]);
    expect(refreshes()).toBe(1);
    expect(fake.requests().filter((request) => request.url.pathname.startsWith("/api/v1/"))).toEqual([]);
    expect(await getTodoistAccount(userId)).toMatchObject({
      status: "reauth",
      lastError: "Todoist asked you to connect again.",
    });
  });

  it("set reauth when a long-lived token stops working", async () => {
    fake = new FakeTodoist({ legacyTokens: true });
    setTodoistFetch(fake.fetch);
    const { userId, todoistUserId } = await connectedAccount();
    expect(await getTodoistAccount(userId)).toMatchObject({ refreshToken: null, expiresAt: null });
    expect((await withTodoist(userId, (worker) => worker.api.user()))?.id).toBe(todoistUserId);
    fake.revokeApp(todoistUserId);
    expect((await failure(withTodoist(userId, (worker) => worker.api.user()))).status).toBe(401);
    expect(refreshes()).toBe(0);
    expect(await getTodoistAccount(userId)).toMatchObject({ status: "reauth" });
  });

  it("set reauth when the token was sealed with a key we no longer have", async () => {
    const { userId } = await connectedAccount();
    vi.stubEnv("TODOIST_TOKEN_KEY", Buffer.alloc(32, 7).toString("base64"));
    expect((await failure(withTodoist(userId, (worker) => worker.api.user()))).status).toBe(401);
    expect(await getTodoistAccount(userId)).toMatchObject({ status: "reauth" });
  });

  it("are never refreshed twice at once for an account", async () => {
    const { userId } = await connectedAccount({ expiresAt: Date.now() + 30_000 });
    const [both, other] = await Promise.all([
      withTodoist(userId, (worker) => Promise.all([worker.api.user(), worker.api.user()]), { waitMs: 5000 }),
      withTodoist(userId, (worker) => worker.api.user(), { waitMs: 5000 }),
    ]);
    expect(both).toHaveLength(2);
    expect(other).not.toBeNull();
    expect(refreshes()).toBe(1);
  });
});

describe("the fake Todoist", () => {
  const signed = (webhook: FakeWebhook) =>
    createHmac("sha256", "test-client-secret").update(webhook.raw).digest("base64") ===
    webhook.headers.get("X-Todoist-Hmac-SHA256");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-28T12:00:00Z")); // a Wednesday
  });

  it("moves a repeating task to its next day and signs the webhook like Todoist", () => {
    const task = fake.add({ content: "Cut nails", due: { string: "every sunday", date: "2026-10-25" } });
    const webhook = fake.complete(task.id);
    expect(signed(webhook)).toBe(true);
    expect(webhook.headers.get("X-Todoist-Delivery-ID")).toEqual(expect.any(String));
    const payload = JSON.parse(webhook.raw);
    expect(payload).toMatchObject({
      event_name: "item:updated",
      user_id: DEFAULT_TODOIST_USER,
      event_data: {
        id: task.id,
        checked: false,
        due: { date: "2026-11-01", string: "every sunday", is_recurring: true },
      },
      event_data_extra: { update_intent: "item_completed", old_item: { due: { date: "2026-10-25" } } },
      triggered_at: "2026-10-28T12:00:00.000000Z",
    });
    expect(fake.uncomplete(task.id).raw).toContain('"update_intent":"item_uncompleted"');
    expect(fake.task(task.id)!.due!.date).toBe("2026-10-25");
    expect(JSON.parse(fake.completeForever(task.id).raw)).toMatchObject({
      event_name: "item:completed",
      event_data: { checked: true },
    });
  });

  it("knows month ends and keeps the time of day", () => {
    const next = (string: string, date: string) => {
      const task = fake.add({ content: "Routine", due: { string, date } });
      fake.complete(task.id);
      return fake.task(task.id)!.due!.date;
    };
    expect(next("every last day", "2026-10-31")).toBe("2026-11-30");
    expect(next("every 31st", "2027-01-31")).toBe("2027-02-28");
    expect(next("every 5th", "2026-10-05")).toBe("2026-11-05");
    expect(next("every day", "2026-10-28T10:00:00")).toBe("2026-10-29T10:00:00");
    expect(next("every day", "2026-10-20")).toBe("2026-10-29");
  });

  it("sets the date item_update_date_complete gives, and logs every change", async () => {
    const api = clientFor(fake.grant().accessToken);
    const task = fake.add({ content: "Stretch", due: { string: "every day", date: "2026-10-28" } });
    const due = { date: "2026-10-29", string: "every day", lang: "en" };
    await api.sync({ commands: [command("item_update_date_complete", { id: task.id, due, is_forward: 1 })] });
    expect(fake.task(task.id)!.due).toMatchObject({ date: "2026-10-29", is_recurring: true });
    const back = { ...due, date: "2026-10-28" };
    await api.sync({ commands: [command("item_update_date_complete", { id: task.id, due: back, is_forward: 0 })] });
    expect(fake.task(task.id)!.due!.date).toBe("2026-10-28");
    expect(fake.activities().map((event) => event.event_type)).toEqual(["added", "completed", "uncompleted"]);
    const intents = fake.webhooks().map((webhook) => JSON.parse(webhook.raw).event_data_extra?.update_intent);
    expect(intents).toEqual(["item_completed", "item_uncompleted"]);
  });

  it("completes a section's tasks when it is archived, and brings the section back with one", async () => {
    const api = clientFor(fake.grant().accessToken);
    const projectId = await newProject(api);
    const section = command("section_add", { name: "Read", project_id: projectId }, true);
    const add = command("item_add", { content: "Mine", project_id: projectId, section_id: section.temp_id }, true);
    const ids = (await api.sync({ commands: [section, add] })).temp_id_mapping!;
    await api.sync({ commands: [command("section_archive", { id: ids[section.temp_id!] })] });
    expect(fake.task(ids[add.temp_id!])).toMatchObject({ checked: true });
    expect(await api.sections(projectId)).toEqual([]);
    fake.uncomplete(ids[add.temp_id!]);
    expect((await api.sections(projectId)).map((s) => s.name)).toEqual(["Read"]);
  });

  it("moves a task between sections the way the person does", async () => {
    const api = clientFor(fake.grant().accessToken);
    const projectId = await newProject(api);
    const section = command("section_add", { name: "Read", project_id: projectId }, true);
    const sectionId = (await api.sync({ commands: [section] })).temp_id_mapping![section.temp_id!];
    const task = fake.add({ content: "Mine", projectId });
    expect(JSON.parse(fake.move(task.id, { sectionId }).raw).event_name).toBe("item:updated");
    expect(fake.task(task.id)).toMatchObject({ project_id: projectId, section_id: sectionId });
    fake.move(task.id, { projectId });
    expect(fake.task(task.id)!.section_id).toBeNull();
    expect(fake.activities().filter((event) => event.event_type === "moved")).toHaveLength(2);
  });

  it("refuses a new project over the plan's limit", async () => {
    fake.addUser({ maxProjects: 1 });
    const api = clientFor(fake.grant().accessToken);
    await newProject(api);
    const add = command("project_add", { name: "Mandaala" }, true);
    const result = await api.sync({ commands: [add] });
    expect(result.sync_status![add.uuid]).toMatchObject({ http_code: 403, error_tag: "MAX_PROJECTS_LIMIT_REACHED" });
    expect((await api.user()).inbox_project_id).toEqual(expect.any(String));
  });

  it("loses the answer of a request when asked, after running it", async () => {
    const api = clientFor(fake.grant().accessToken);
    const add = command("project_add", { name: "Mandaala" }, true);
    fake.dropResponseOf(add.uuid);
    expect((await failure(api.sync({ commands: [add] }))).status).toBe(0);
    expect(fake.projects().filter((project) => project.name === "Mandaala")).toHaveLength(1);
    const retry = await api.sync({ commands: [add] });
    expect(retry.sync_status![add.uuid]).toBe("ok");
    expect(retry.temp_id_mapping).toEqual({});
  });
});
