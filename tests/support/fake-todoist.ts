import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type {
  ActivityEvent,
  CommandStatus,
  SyncCommand,
  TodoistDue,
  TodoistProject,
  TodoistSectionObject,
  TodoistTask,
  TodoistUser,
} from "@/server/todoist/api";

// A Todoist that lives in memory, for tests. It answers the real URLs the client calls (OAuth,
// /sync, the REST reads and the activity log) the way Todoist's v1 docs describe, keeps each
// Todoist user's projects, sections and tasks, logs an activity event for every task change, and
// builds signed webhooks for what happens. Install it with setTodoistFetch(fake.fetch), then act
// like the person in Todoist with complete(), edit(), remove() and the other helpers.
//
// Times look like Todoist's ("2026-10-25T10:39:38.123000Z", six fraction digits), which is not the
// format of toISOString(): compare times as instants (Date.parse), not as strings.

const ORIGIN = "https://api.todoist.com";
const AUTHORIZE_URL = "https://app.todoist.com/oauth/authorize";
const SCOPE = "data:read_write,data:delete";
/** Access tokens of apps with refresh tokens last an hour. */
const ACCESS_TTL_S = 3600;
/** What legacy apps get instead of an expiry: ten years. */
const LEGACY_TTL_S = 315_360_000;
/** A spent refresh token may come back this long after it was used (a network retry). */
const GRACE_MS = 60_000;
const DAY_MS = 86_400_000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
/** First words of due strings Todoist reads as repeating, in English and Portuguese. */
const REPEAT_WORDS = [
  ["every!?", "ev!?", "each", "daily", "everyday", "weekly", "monthly", "yearly"],
  ["todos?", "todas?", "cada", "a cada", "diariamente", "semanalmente", "mensalmente", "aos"],
].flat();
const RECURRING = new RegExp(`^(${REPEAT_WORDS.join("|")})(\\s|$)`, "i");
const DUE_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?Z?)?$/;
const TEMP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The webhook events the Mandaala app subscribes to in Todoist's App Management Console. */
export const SUBSCRIBED_EVENTS = [
  "item:updated",
  "item:completed",
  "item:uncompleted",
  "item:deleted",
  "project:deleted",
  "project:archived",
];

/** The Todoist user the helpers act for when no id is given (the id in Todoist's docs). */
export const DEFAULT_TODOIST_USER = "2671355";

/** One webhook delivery, as Todoist POSTs it: the exact body and its signed headers. */
export interface FakeWebhook {
  raw: string;
  headers: Headers;
}

/** A task with the fields Todoist's task object has. */
export interface FakeTask extends TodoistTask {
  user_id: string;
  parent_id: null;
  child_order: number;
  labels: string[];
  added_at: string;
  added_by_uid: string;
  responsible_uid: null;
  deadline: null;
  duration: null;
}

export interface FakeProject extends TodoistProject {
  is_deleted: boolean;
  is_archived: boolean;
  color: string;
  parent_id: null;
  child_order: number;
  view_style: "list";
  created_at: string;
  updated_at: string;
}

export interface FakeSection extends TodoistSectionObject {
  user_id: string;
  section_order: number;
  is_collapsed: boolean;
  is_deleted: boolean;
  is_archived: boolean;
  archived_at: string | null;
  added_at: string;
  updated_at: string;
}

/** An activity log entry, as GET /api/v1/activities lists it. */
export interface FakeActivity extends ActivityEvent {
  id: number;
  parent_item_id: null;
  initiator_id: null;
  extra_data_id: number;
  extra_data: Record<string, unknown>;
}

/** One sync command the fake received, with its answer. `repeated`: its uuid had already run, so it was skipped. */
export interface FakeCommand extends SyncCommand {
  userId: string;
  status: CommandStatus;
  repeated: boolean;
}

/** One HTTP request the fake received. `signal` is the one the client passed (it should always pass one). */
export interface FakeRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
  signal: AbortSignal | null;
}

export interface FakeUserOptions {
  /** Todoist user id (default DEFAULT_TODOIST_USER). */
  id?: string;
  email?: string;
  fullName?: string;
  /** The user's time zone in Todoist (tz_info.timezone), which decides "today" (default "UTC"). */
  timeZone?: string;
  /** First day of the week, 1 = Monday ... 7 = Sunday (default 1). */
  startDay?: number;
  /** How many projects besides the Inbox the plan allows (default: no limit; Todoist's free plan has 5). */
  maxProjects?: number;
}

export interface FakeTodoistOptions {
  /** Defaults to TODOIST_CLIENT_ID, so set the env vars before making the fake. */
  clientId?: string;
  /** Signs the webhooks. Defaults to TODOIST_CLIENT_SECRET. */
  clientSecret?: string;
  /** An app made before refresh tokens: one long-lived access token, no refresh token. */
  legacyTokens?: boolean;
  /** Webhook events that are subscribed (logged in webhooks()). Defaults to SUBSCRIBED_EVENTS. */
  events?: string[];
}

/** The due input the API takes: a date, a string ("every day", "tomorrow"), or both. */
export interface DueInput {
  date?: string;
  string?: string;
  lang?: string;
}

interface User {
  id: string;
  email: string;
  fullName: string;
  timeZone: string;
  startDay: number;
  maxProjects: number;
  inboxId: string;
  rev: number;
}

interface Token {
  kind: "access" | "refresh";
  userId: string;
  /** One OAuth approval; refreshing keeps it, revoking a token ends it. */
  grant: string;
  expiresAt: number | null;
  consumedAt: number | null;
  /** The access token a refresh token was spent for. */
  replacement: string | null;
  revoked: boolean;
}

interface Stored<T> {
  value: T;
  owner: string;
  /** The revision of its last change, for incremental sync. */
  rev: number;
}

interface StoredTask extends Stored<FakeTask> {
  /** Due dates before each repeating completion, newest last, so the person can undo them. */
  undo: TodoistDue[];
}

interface Failure {
  left: number;
  status: number;
  retryAfter?: number;
  path?: string;
}

type TaskChanges = Partial<
  Pick<FakeTask, "content" | "description" | "priority" | "due" | "project_id" | "section_id">
>;
type ErrorStatus = Exclude<CommandStatus, "ok">;
type Json = Record<string, unknown>;

/** A command that Todoist refuses: answered in sync_status, while the other commands still run. */
class CommandError extends Error {
  constructor(readonly status: ErrorStatus) {
    super(`Fake Todoist: ${status.error ?? status.error_tag}`);
  }
}

// Error codes 22 (item not found), 20 and 19 are Todoist's; the others are placeholders. Match on
// error_tag and http_code.
const notFound = (tag: string, code: number, what: string): ErrorStatus => ({
  error_tag: tag,
  error_code: code,
  error: `${what} not found`,
  http_code: 404,
  error_extra: {},
});
const itemNotFound = () => notFound("ITEM_NOT_FOUND", 22, "Task");
const projectNotFound = () => notFound("PROJECT_NOT_FOUND", 21, "Project");
const sectionNotFound = () => notFound("SECTION_NOT_FOUND", 23, "Section");
const invalid = (argument: string, explanation?: string): ErrorStatus => ({
  error_tag: "INVALID_ARGUMENT_VALUE",
  error_code: 20,
  error: "Invalid argument value",
  http_code: 400,
  error_extra: explanation ? { argument, explanation } : { argument },
});
const missing = (argument: string): ErrorStatus => ({
  error_tag: "ARGUMENT_MISSING",
  error_code: 19,
  error: "Required argument is missing",
  http_code: 400,
  error_extra: { argument },
});

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

/** An HTTP error with Todoist's error body; retry_after in `extra` also goes out as Retry-After. */
function apiError(status: number, tag: string, code: number, message: string, extra: Json = {}): Response {
  const headers: Record<string, string> = {};
  if (typeof extra.retry_after === "number") headers["Retry-After"] = String(extra.retry_after);
  if (status === 401) headers["WWW-Authenticate"] = 'Bearer error="invalid_token", error_description="Unauthorized"';
  const body = {
    error: message,
    error_code: code,
    error_extra: { event_id: randomBytes(8).toString("hex"), ...extra },
    error_tag: tag,
    http_code: status,
  };
  return json(body, status, headers);
}

/** What Todoist answers for a missing, expired or revoked token. */
const unauthorized = () => apiError(401, "UNAUTHORIZED", 477, "Unauthorized", { retry_after: 3 });

/** A 400 for a request argument Todoist cannot use. */
function badArgument(argument: string, explanation?: string): Response {
  const extra = explanation ? { argument, explanation } : { argument };
  return apiError(400, "INVALID_ARGUMENT_VALUE", 20, "Invalid argument value", extra);
}

function outage(status: number, retryAfter?: number): Response {
  if (status === 401) return unauthorized();
  const extra = retryAfter === undefined ? {} : { retry_after: retryAfter };
  if (status === 429) return apiError(429, "TOO_MANY_REQUESTS", 429, "Too many requests", extra);
  if (status >= 500) return apiError(status, "SERVICE_UNAVAILABLE", status, "Service unavailable", extra);
  if (status === 404) return apiError(404, "NOT_FOUND", 478, "Not found");
  return apiError(status, "BAD_REQUEST", 400, "Bad request", extra);
}

const oauthError = (status: number, error: string) => json({ error }, status);

function isForm(headers: Headers): boolean {
  return (headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded");
}

/** A JSON form field: undefined when absent, null when it is not JSON. */
function jsonField(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const clone = <T>(value: T): T => structuredClone(value);

// Days as YYYY-MM-DD, counted in UTC so the machine's time zone never matters.

function utc(day: string): number {
  return Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
}

function addDays(day: string, delta: number): string {
  return new Date(utc(day) + delta * DAY_MS).toISOString().slice(0, 10);
}

const daysBetween = (from: string, to: string) => Math.round((utc(to) - utc(from)) / DAY_MS);
const weekday = (day: string) => new Date(utc(day)).getUTCDay();
const dayOfMonth = (day: string) => Number(day.slice(8, 10));
const monthIndex = (day: string) => Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1;
const modulo = (value: number, by: number) => ((value % by) + by) % by;

function lastDayOfMonth(day: string): number {
  return new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).getUTCDate();
}

/** True for a well-formed due date that exists ("2026-02-30" does not). */
function isDueDate(value: string): boolean {
  return DUE_DATE.test(value) && addDays(value.slice(0, 10), 0) === value.slice(0, 10);
}

/** YYYY-MM-DD of an instant in a time zone. */
function localDay(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

function gmtOffset(timeZone: string, ms: number): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(ms)
    .find((part) => part.type === "timeZoneName")?.value;
  return !name || name === "GMT" ? "+00:00" : name.replace("GMT", "");
}

function weekdayIndex(word: string): number {
  return word.length < 3 ? -1 : WEEKDAYS.findIndex((name) => name.startsWith(word));
}

/**
 * Which days a repeat string lands on, counted from `anchor` (the occurrence it repeats from).
 * Knows our strings ("every day", "every sunday", "every 5th", "every last day") and the common
 * English ones (intervals, "every weekday", weekday lists, "every month"). Anything else: daily.
 */
function repeatRule(text: string, anchor: string): (day: string) => boolean {
  const rule = text
    .toLowerCase()
    .replace(/^(every!?|ev!?|each)\s+/, "")
    .replace(/\s+(at|@|starting|from)\s.*$/, "")
    .trim();
  const onDate = (date: number) => (day: string) => dayOfMonth(day) === Math.min(date, lastDayOfMonth(day));
  if (["day", "daily", "everyday"].includes(rule)) return () => true;
  if (rule === "week" || rule === "weekly") return (day) => weekday(day) === weekday(anchor);
  if (rule === "weekday" || rule === "workday") return (day) => weekday(day) >= 1 && weekday(day) <= 5;
  if (rule === "month" || rule === "monthly") return onDate(dayOfMonth(anchor));
  if (rule === "last day") return (day) => dayOfMonth(day) === lastDayOfMonth(day);
  const date = /^(\d{1,2})(st|nd|rd|th)?$/.exec(rule);
  if (date && Number(date[1]) >= 1 && Number(date[1]) <= 31) return onDate(Number(date[1]));
  const interval = /^(\d+|other) (day|week|month)s?$/.exec(rule);
  if (interval) {
    const every = interval[1] === "other" ? 2 : Math.max(1, Number(interval[1]));
    if (interval[2] === "day") return (day) => modulo(daysBetween(anchor, day), every) === 0;
    if (interval[2] === "week") return (day) => modulo(daysBetween(anchor, day), every * 7) === 0;
    return (day) => onDate(dayOfMonth(anchor))(day) && modulo(monthIndex(day) - monthIndex(anchor), every) === 0;
  }
  const days = rule.split(/\s*(?:,|\band\b)\s*/).map(weekdayIndex);
  if (days.length && days.every((index) => index >= 0)) return (day) => days.includes(weekday(day));
  return () => true;
}

/** The first day after `after` that the repeat string lands on. */
function nextOccurrence(text: string, after: string, anchor: string): string {
  const lands = repeatRule(text, anchor);
  for (let step = 1; step <= 800; step++) {
    const day = addDays(after, step);
    if (lands(day)) return day;
  }
  return addDays(after, 1);
}

/**
 * An in-memory Todoist for tests: `setTodoistFetch(fake.fetch)`.
 *
 * - OAuth: codes from authorize() / approve(), refresh tokens that rotate, access tokens that last an
 *   hour, Todoist's 60 s grace window for a spent refresh token (same access token again, no refresh
 *   token) and its replay alarm after it (every token of that user is revoked).
 * - /api/v1/sync: commands with temp ids (resolved within one request), per-uuid idempotency (a uuid
 *   that already ran answers "ok" and runs nothing, with no temp_id_mapping) and error objects like
 *   Todoist's; reads with sync_token "*" (active objects) or an earlier token (everything changed since,
 *   completed and deleted objects too).
 * - REST reads: /user, /tasks (ids, project_id, section_id; active tasks only), /sections, /projects/{id},
 *   /activities (newest first, date_from, date_to, object_type, event_type). All pages hold at most
 *   `limit` (default 50, max 200) and carry next_cursor.
 * - Repeating tasks: completing one moves it to the first day its string lands on after the later of
 *   its date and the user's today, keeping any time; item_update_date_complete sets the date it is given.
 */
export class FakeTodoist {
  readonly clientId: string;
  readonly clientSecret: string;
  private readonly legacyTokens: boolean;
  private readonly subscribed: Set<string>;
  private readonly users = new Map<string, User>();
  private readonly codes = new Map<string, { userId: string; used: boolean }>();
  private readonly tokens = new Map<string, Token>();
  private readonly projectStore = new Map<string, Stored<FakeProject>>();
  private readonly sectionStore = new Map<string, Stored<FakeSection>>();
  private readonly taskStore = new Map<string, StoredTask>();
  private readonly activityLog: { owner: string; event: FakeActivity }[] = [];
  private readonly commandLog: FakeCommand[] = [];
  private readonly requestLog: FakeRequest[] = [];
  private readonly webhookLog: FakeWebhook[] = [];
  private readonly ranUuids = new Set<string>();
  private readonly lostUuids = new Set<string>();
  private readonly failures: Failure[] = [];
  private loseAnswer = false;
  private revision = 0;
  private order = 0;

  constructor(options: FakeTodoistOptions = {}) {
    this.clientId = options.clientId ?? process.env.TODOIST_CLIENT_ID ?? "fake-client-id";
    this.clientSecret = options.clientSecret ?? process.env.TODOIST_CLIENT_SECRET ?? "fake-client-secret";
    this.legacyTokens = options.legacyTokens ?? false;
    this.subscribed = new Set(options.events ?? SUBSCRIBED_EVENTS);
  }

  /** Now in ms: Date.now(), so vi.setSystemTime moves the fake's clock (token expiry, "today", timestamps). */
  clock(): number {
    return Date.now();
  }

  /** Pass to setTodoistFetch(). Answers https://api.todoist.com like Todoist does; any other host throws. */
  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
    this.requestLog.push({ method: request.method, url, headers: new Headers(request.headers), body, signal });
    if (url.origin !== ORIGIN) throw new Error(`Fake Todoist: unexpected request to ${url.origin}`);
    const failure = this.takeFailure(url.pathname);
    if (failure?.status === 0) throw new TypeError("fetch failed");
    if (failure) return outage(failure.status, failure.retryAfter);
    const response = this.answer(request.method, url, request.headers, body);
    if (this.loseAnswer) {
      this.loseAnswer = false;
      throw new TypeError("fetch failed");
    }
    return response;
  };

  // ---------- Set-up and acting like the person ----------

  /**
   * Adds a Todoist user with an Inbox project, or changes one (a change shows up in the next
   * incremental sync). Returns the user as GET /api/v1/user shows it.
   */
  addUser(options: FakeUserOptions = {}): TodoistUser {
    const id = options.id ?? DEFAULT_TODOIST_USER;
    let user = this.users.get(id);
    if (!user) {
      user = {
        id,
        email: `todoist-${id}@example.com`,
        fullName: "Fake Person",
        timeZone: "UTC",
        startDay: 1,
        maxProjects: Number.POSITIVE_INFINITY,
        inboxId: "",
        rev: 0,
      };
      this.users.set(id, user);
      user.inboxId = this.newProject(user, "Inbox", true).id;
    }
    if (options.email !== undefined) user.email = options.email;
    if (options.fullName !== undefined) user.fullName = options.fullName;
    if (options.timeZone !== undefined) user.timeZone = options.timeZone;
    if (options.startDay !== undefined) user.startDay = options.startDay;
    if (options.maxProjects !== undefined) user.maxProjects = options.maxProjects;
    user.rev = ++this.revision;
    return this.userJson(user);
  }

  /** The Todoist user as GET /api/v1/user shows it (made on first use). */
  user(userId = DEFAULT_TODOIST_USER): TodoistUser {
    return this.userJson(this.userOf(userId));
  }

  /** A one-time authorization code for this Todoist user (made on first use), as Todoist's redirect brings it. */
  authorize(userId = DEFAULT_TODOIST_USER): string {
    this.userOf(userId);
    const code = randomBytes(16).toString("hex");
    this.codes.set(code, { userId, used: false });
    return code;
  }

  /**
   * Acts out the person approving the app on Todoist's consent page: checks the authorize URL (the
   * client id, a scope, response_type and a state) and returns what Todoist sends to the redirect_uri.
   */
  approve(authorizeUrl: string, userId = DEFAULT_TODOIST_USER): { code: string; state: string; redirectUri: string } {
    const url = new URL(authorizeUrl);
    const params = url.searchParams;
    if (`${url.origin}${url.pathname}` !== AUTHORIZE_URL) {
      throw new Error(`Fake Todoist: not the authorize URL: ${authorizeUrl}`);
    }
    if (params.get("client_id") !== this.clientId) throw new Error("Fake Todoist: unknown client_id");
    if (!params.get("scope")) throw new Error("Fake Todoist: no scope");
    if ((params.get("response_type") ?? "code") !== "code") throw new Error("Fake Todoist: unsupported_response_type");
    const state = params.get("state");
    if (!state) throw new Error("Fake Todoist: no state");
    return { code: this.authorize(userId), state, redirectUri: params.get("redirect_uri") ?? "" };
  }

  /** A token pair for this Todoist user without the OAuth dance, as exchangeCode would get it. */
  grant(userId = DEFAULT_TODOIST_USER): { accessToken: string; refreshToken: string | null; expiresAt: number | null } {
    this.userOf(userId);
    const pair = this.issue(userId, randomUUID());
    return { accessToken: pair.access, refreshToken: pair.refresh, expiresAt: this.tokens.get(pair.access)!.expiresAt };
  }

  /** The person removes the app in Todoist's settings: every token of this user stops working. */
  revokeApp(userId = DEFAULT_TODOIST_USER): void {
    for (const token of this.tokens.values()) if (token.userId === userId) token.revoked = true;
  }

  /** The person adds a task of their own (it stays in Todoist only). item:added is not subscribed: no webhook. */
  add(fields: {
    content: string;
    projectId?: string;
    sectionId?: string | null;
    description?: string;
    due?: DueInput | null;
    userId?: string;
  }): FakeTask {
    const user = this.userOf(fields.userId ?? DEFAULT_TODOIST_USER);
    const task = this.addTask(user, {
      content: fields.content,
      description: fields.description ?? "",
      project_id: fields.projectId ?? user.inboxId,
      section_id: fields.sectionId ?? null,
      priority: 1,
      due: fields.due ? this.dueFrom(user, fields.due) : null,
    });
    return clone(task);
  }

  /**
   * The person ticks the task. A repeating task moves to its next date and Todoist sends item:updated
   * with update_intent "item_completed" (old_item has the date that was done); any other task is
   * completed: item:completed.
   */
  complete(taskId: string): FakeWebhook {
    const { user, stored } = this.personTask(taskId);
    if (stored.value.checked) throw new Error(`Fake Todoist: task ${taskId} is already completed`);
    if (stored.value.due?.is_recurring) return this.completeOccurrence(user, stored, null);
    return this.completeTask(user, stored, this.stamp());
  }

  /** The person completes a task for good, a repeating one too: item:completed with checked: true. */
  completeForever(taskId: string): FakeWebhook {
    const { user, stored } = this.personTask(taskId);
    if (stored.value.checked) throw new Error(`Fake Todoist: task ${taskId} is already completed`);
    return this.completeTask(user, stored, this.stamp());
  }

  /**
   * The person undoes a tick. A completed task comes back: item:uncompleted. A repeating task's last
   * completion is undone, back to the date it had: item:updated with update_intent "item_uncompleted".
   */
  uncomplete(taskId: string): FakeWebhook {
    const { user, stored } = this.personTask(taskId);
    if (stored.value.checked) return this.uncompleteTask(user, stored);
    if (stored.value.due?.is_recurring && stored.undo.length) return this.undoOccurrence(user, stored, null);
    throw new Error(`Fake Todoist: task ${taskId} has no completion to undo`);
  }

  /**
   * The person edits the task. `due` is read like the API reads it ({ string } like "every 2 weeks",
   * { date }, or both; null removes it). Sends item:updated with update_intent "item_updated".
   */
  edit(
    taskId: string,
    changes: { content?: string; description?: string; priority?: number; due?: DueInput | null },
  ): FakeWebhook {
    const { user, stored } = this.personTask(taskId);
    const update: TaskChanges = {};
    if (changes.content !== undefined) update.content = changes.content;
    if (changes.description !== undefined) update.description = changes.description;
    if (changes.priority !== undefined) update.priority = changes.priority;
    if (changes.due !== undefined) update.due = this.dueFrom(user, changes.due);
    return this.updateTask(user, stored, update);
  }

  /**
   * The person moves the task into a section, or to the top level of a project (section null).
   * Logs a "moved" activity event and sends item:updated.
   */
  move(taskId: string, to: { sectionId: string } | { projectId: string }): FakeWebhook {
    const { user, stored } = this.personTask(taskId);
    const section = "sectionId" in to ? this.sectionStore.get(to.sectionId) : undefined;
    if ("sectionId" in to && !section) throw new Error(`Fake Todoist: no section ${to.sectionId}`);
    const from = { project_id: stored.value.project_id, section_id: stored.value.section_id };
    const target = section
      ? { project_id: section.value.project_id, section_id: section.value.id }
      : { project_id: "projectId" in to ? to.projectId : from.project_id, section_id: null };
    const what = { object_type: "item", object_id: taskId, event_type: "moved", parent_project_id: target.project_id };
    this.logActivity(user, what, {
      content: stored.value.content,
      source_project_id: from.project_id,
      destination_project_id: target.project_id,
      section_id: target.section_id,
      last_section_id: from.section_id,
    });
    return this.updateTask(user, stored, target);
  }

  /** The person deletes the task: item:deleted. */
  remove(taskId: string): FakeWebhook {
    const { user, stored } = this.personTask(taskId);
    return this.deleteTask(user, stored);
  }

  /**
   * The person deletes a project with its sections and tasks. Returns project:deleted; the item:deleted
   * of each task that was still there goes to webhooks() too, before it.
   */
  removeProject(projectId: string): FakeWebhook {
    const { user, stored } = this.personProject(projectId);
    for (const task of this.taskStore.values()) {
      if (task.value.project_id === projectId && !task.value.is_deleted) this.deleteTask(user, task);
    }
    for (const section of this.sectionStore.values()) {
      if (section.value.project_id === projectId && !section.value.is_deleted) {
        section.value.is_deleted = true;
        this.touch(section);
      }
    }
    stored.value.is_deleted = true;
    this.touch(stored);
    const what = { object_type: "project", object_id: projectId, event_type: "deleted", parent_project_id: projectId };
    this.logActivity(user, what, { name: stored.value.name });
    return this.emit(user, "project:deleted", stored.value);
  }

  /** The person archives a project (its tasks stay in it): project:archived. */
  archiveProject(projectId: string): FakeWebhook {
    const { user, stored } = this.personProject(projectId);
    stored.value.is_archived = true;
    this.touch(stored);
    const what = { object_type: "project", object_id: projectId, event_type: "archived", parent_project_id: projectId };
    this.logActivity(user, what, { name: stored.value.name });
    return this.emit(user, "project:archived", stored.value);
  }

  // ---------- Outages ----------

  /**
   * Makes the next `count` requests fail, to act out an outage: status 0 is a network failure (fetch
   * throws), any other status an HTTP error with Todoist's error body; `retryAfter` (seconds) adds
   * Retry-After. `path` limits it to requests whose path contains it ("/api/v1/sync", "/oauth/access_token").
   */
  failNext(count: number, status: number, options: { retryAfter?: number; path?: string } = {}): void {
    this.failures.push({ left: count, status, ...options });
  }

  /** The next /sync request that carries this command uuid runs, but its answer is lost (fetch throws). */
  dropResponseOf(uuid: string): void {
    this.lostUuids.add(uuid);
  }

  // ---------- Inspection (copies, oldest first) ----------

  /** One task as Todoist holds it, completed or deleted ones too; undefined when it never existed. */
  task(id: string): FakeTask | undefined {
    const stored = this.taskStore.get(id);
    return stored && clone(stored.value);
  }

  /** Every task, completed and deleted ones too: filter on `checked` and `is_deleted`. */
  tasks(): FakeTask[] {
    return [...this.taskStore.values()].map((stored) => clone(stored.value));
  }

  /** Every section, archived and deleted ones too. */
  sections(): FakeSection[] {
    return [...this.sectionStore.values()].map((stored) => clone(stored.value));
  }

  /** Every project, each user's Inbox and archived or deleted ones too. */
  projects(): FakeProject[] {
    return [...this.projectStore.values()].map((stored) => clone(stored.value));
  }

  /** Every sync command received, with its answer. */
  commands(): FakeCommand[] {
    return clone(this.commandLog);
  }

  /** The activity log of one user (all users when no id is given). */
  activities(userId?: string): FakeActivity[] {
    return this.activityLog.filter(({ owner }) => !userId || owner === userId).map(({ event }) => clone(event));
  }

  /** Every webhook Todoist would have sent for subscribed events, ours and the person's changes alike. */
  webhooks(): FakeWebhook[] {
    return this.webhookLog.map(({ raw, headers }) => ({ raw, headers: new Headers(headers) }));
  }

  /** Every HTTP request received. */
  requests(): FakeRequest[] {
    return [...this.requestLog];
  }

  // ---------- HTTP ----------

  private takeFailure(path: string): Failure | null {
    const failure = this.failures.find((item) => item.left > 0 && (!item.path || path.includes(item.path)));
    if (!failure) return null;
    failure.left -= 1;
    return failure;
  }

  private answer(method: string, url: URL, headers: Headers, body: string): Response {
    const path = url.pathname;
    if (method === "POST" && path === "/oauth/access_token") return this.tokenEndpoint(headers, body);
    if (method === "POST" && path === "/api/v1/revoke") return this.revokeEndpoint(headers, body);
    if (!path.startsWith("/api/v1/")) return outage(404);
    const user = this.bearer(headers);
    if (!user) return unauthorized();
    const project = /^\/api\/v1\/projects\/([^/]+)$/.exec(path);
    if (method === "GET" && path === "/api/v1/user") return json(this.userJson(user));
    if (method === "GET" && path === "/api/v1/tasks") return this.listTasks(user, url.searchParams);
    if (method === "GET" && path === "/api/v1/sections") return this.listSections(user, url.searchParams);
    if (method === "GET" && path === "/api/v1/activities") return this.listActivities(user, url.searchParams);
    if (method === "GET" && project) return this.getProject(user, decodeURIComponent(project[1]));
    if (method === "POST" && path === "/api/v1/sync") return this.syncEndpoint(user, headers, body);
    return outage(404);
  }

  private tokenEndpoint(headers: Headers, body: string): Response {
    if (!isForm(headers)) return oauthError(400, "invalid_request");
    const form = new URLSearchParams(body);
    const ownApp = form.get("client_id") === this.clientId && form.get("client_secret") === this.clientSecret;
    const grantType = form.get("grant_type") ?? "authorization_code";
    if (grantType === "authorization_code") {
      if (!ownApp) return oauthError(400, "incorrect_application_credentials");
      const entry = this.codes.get(form.get("code") ?? "");
      if (!entry || entry.used) return oauthError(400, "bad_authorization_code");
      entry.used = true;
      const pair = this.issue(entry.userId, randomUUID());
      return this.tokenAnswer(pair.access, pair.refresh);
    }
    if (grantType === "refresh_token") {
      if (!ownApp) return oauthError(401, "invalid_client");
      return this.refreshGrant(form.get("refresh_token") ?? "");
    }
    return oauthError(400, "unsupported_grant_type");
  }

  private refreshGrant(value: string): Response {
    const spent = this.tokens.get(value);
    if (!spent || spent.kind !== "refresh" || spent.revoked) return oauthError(400, "invalid_grant");
    const now = this.clock();
    if (spent.consumedAt === null) {
      spent.consumedAt = now;
      const pair = this.issue(spent.userId, spent.grant);
      spent.replacement = pair.access;
      return this.tokenAnswer(pair.access, pair.refresh);
    }
    const replacement = spent.replacement ? this.tokens.get(spent.replacement) : undefined;
    if (now - spent.consumedAt <= GRACE_MS && replacement && !replacement.revoked) {
      // A network retry: the same new access token again, but no refresh token.
      return this.tokenAnswer(spent.replacement!, null);
    }
    // A spent refresh token after the grace window looks stolen: Todoist revokes everything.
    this.revokeApp(spent.userId);
    return oauthError(400, "invalid_grant");
  }

  private issue(userId: string, grant: string): { access: string; refresh: string | null } {
    const base = { userId, grant, consumedAt: null, replacement: null, revoked: false };
    const access = randomBytes(20).toString("hex");
    const expiresAt = this.legacyTokens ? null : this.clock() + ACCESS_TTL_S * 1000;
    this.tokens.set(access, { ...base, kind: "access", expiresAt });
    if (this.legacyTokens) return { access, refresh: null };
    const refresh = randomBytes(20).toString("hex");
    this.tokens.set(refresh, { ...base, kind: "refresh", expiresAt: null });
    return { access, refresh };
  }

  private tokenAnswer(access: string, refresh: string | null): Response {
    const expiresAt = this.tokens.get(access)?.expiresAt ?? null;
    const expiresIn = expiresAt === null ? LEGACY_TTL_S : Math.max(0, Math.floor((expiresAt - this.clock()) / 1000));
    const answer: Json = { access_token: access, token_type: "Bearer", expires_in: expiresIn };
    if (refresh) answer.refresh_token = refresh;
    answer.scope = SCOPE;
    return json(answer);
  }

  private revokeEndpoint(headers: Headers, body: string): Response {
    const basic = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`;
    if (headers.get("authorization") !== basic) return oauthError(401, "invalid_client");
    if (!isForm(headers)) return oauthError(400, "invalid_request");
    const token = this.tokens.get(new URLSearchParams(body).get("token") ?? "");
    // RFC 7009: the token goes, with the refresh token of the same approval.
    if (token) for (const other of this.tokens.values()) if (other.grant === token.grant) other.revoked = true;
    return new Response(null, { status: 200 });
  }

  private bearer(headers: Headers): User | null {
    const value = /^Bearer (\S+)$/.exec(headers.get("authorization") ?? "")?.[1];
    const token = value ? this.tokens.get(value) : undefined;
    if (!token || token.kind !== "access" || token.revoked) return null;
    if (token.expiresAt !== null && token.expiresAt <= this.clock()) return null;
    return this.users.get(token.userId) ?? null;
  }

  /** One page of `items`, Todoist style: { results, next_cursor }. */
  private page<T>(items: T[], params: URLSearchParams): Response {
    const limit = Number(params.get("limit") ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return badArgument("limit");
    const cursor = params.get("cursor");
    const start = cursor ? Number(/^(\d+)\.page$/.exec(cursor)?.[1] ?? Number.NaN) : 0;
    if (Number.isNaN(start)) return badArgument("cursor");
    const end = start + limit;
    return json({ results: items.slice(start, end), next_cursor: end < items.length ? `${end}.page` : null });
  }

  private listTasks(user: User, params: URLSearchParams): Response {
    const ids = params.get("ids")?.split(",").map((id) => id.trim());
    const projectId = params.get("project_id");
    const sectionId = params.get("section_id");
    const tasks = [...this.taskStore.values()]
      .map((stored) => stored.value)
      .filter(
        (task) =>
          task.user_id === user.id &&
          !task.checked &&
          !task.is_deleted &&
          (!ids || ids.includes(task.id)) &&
          (!projectId || task.project_id === projectId) &&
          (!sectionId || task.section_id === sectionId),
      );
    return this.page(tasks.map(clone), params);
  }

  private listSections(user: User, params: URLSearchParams): Response {
    const projectId = params.get("project_id");
    const sections = [...this.sectionStore.values()]
      .filter(({ owner, value }) => owner === user.id && !value.is_deleted && !value.is_archived)
      .filter(({ value }) => !projectId || value.project_id === projectId)
      .map(({ value }) => clone(value));
    return this.page(sections, params);
  }

  private listActivities(user: User, params: URLSearchParams): Response {
    const objectType = params.get("object_type");
    const eventType = params.get("event_type");
    const from = params.get("date_from") ? Date.parse(params.get("date_from")!) : null;
    const to = params.get("date_to") ? Date.parse(params.get("date_to")!) : null;
    if (Number.isNaN(from)) return badArgument("date_from");
    if (Number.isNaN(to)) return badArgument("date_to");
    const events = this.activityLog
      .filter(({ owner }) => owner === user.id)
      .map(({ event }) => event)
      .filter((event) => !objectType || event.object_type === objectType)
      .filter((event) => !eventType || event.event_type === eventType)
      .filter((event) => from === null || Date.parse(event.event_date) >= from)
      .filter((event) => to === null || Date.parse(event.event_date) < to)
      .map(clone)
      .reverse(); // newest first
    return this.page(events, params);
  }

  private getProject(user: User, id: string): Response {
    const stored = this.projectStore.get(id);
    if (!stored || stored.owner !== user.id || stored.value.is_deleted) {
      return apiError(404, "NOT_FOUND", 478, "Project not found");
    }
    return json(clone(stored.value));
  }

  // ---------- /sync ----------

  private syncEndpoint(user: User, headers: Headers, body: string): Response {
    if (!isForm(headers)) return badArgument("body", "Sync requests are form-encoded");
    const form = new URLSearchParams(body);
    const answer: Json = {};
    const commands = jsonField(form.get("commands"));
    if (commands !== undefined) {
      if (!Array.isArray(commands) || !commands.every(isCommand)) return badArgument("commands");
      if (commands.length > 100) return badArgument("commands", "At most 100 commands per request");
      Object.assign(answer, this.runCommands(user, commands));
    }
    const token = form.get("sync_token");
    if (token !== null) {
      const since = token === "*" ? null : Number(/^fake\.(\d+)$/.exec(token)?.[1] ?? Number.NaN);
      if (Number.isNaN(since)) return badArgument("sync_token");
      const types = jsonField(form.get("resource_types")) ?? [];
      const valid = Array.isArray(types) && types.every((type) => typeof type === "string");
      if (!valid) return badArgument("resource_types");
      Object.assign(answer, this.read(user, since, types));
    }
    answer.sync_token ??= this.syncToken();
    return json(answer);
  }

  private syncToken(): string {
    return `fake.${this.revision}`;
  }

  /** Everything active (since null), or everything changed after revision `since`. */
  private read(user: User, since: number | null, types: string[]): Json {
    const wants = (type: string) => (types.includes("all") || types.includes(type)) && !types.includes(`-${type}`);
    const fresh = (stored: { rev: number }, active: boolean) => (since === null ? active : stored.rev > since);
    const mine = <T>(store: Map<string, Stored<T>>, active: (value: T) => boolean) =>
      [...store.values()]
        .filter((stored) => stored.owner === user.id && fresh(stored, active(stored.value)))
        .map((stored) => clone(stored.value));
    const open = (value: { is_deleted: boolean; is_archived: boolean }) => !value.is_deleted && !value.is_archived;
    const answer: Json = { full_sync: since === null, sync_token: this.syncToken() };
    if (since === null) answer.full_sync_date_utc = this.stamp();
    if (wants("items")) answer.items = mine(this.taskStore, (task) => !task.checked && !task.is_deleted);
    if (wants("projects")) answer.projects = mine(this.projectStore, open);
    if (wants("sections")) answer.sections = mine(this.sectionStore, open);
    if (wants("user") && fresh(user, true)) answer.user = this.userJson(user);
    return answer;
  }

  private runCommands(user: User, commands: SyncCommand[]): Json {
    const status: Record<string, CommandStatus> = {};
    const mapping: Record<string, string> = {};
    for (const command of commands) {
      const key = `${user.id}:${command.uuid}`;
      const repeated = this.ranUuids.has(key);
      let result: CommandStatus = "ok";
      if (!repeated) {
        try {
          const created = this.run(user, command, mapping);
          if (created && command.temp_id) mapping[command.temp_id] = created;
          this.ranUuids.add(key);
        } catch (error) {
          if (!(error instanceof CommandError)) throw error;
          result = error.status;
        }
      }
      status[command.uuid] = result;
      this.commandLog.push({ ...clone(command), userId: user.id, status: result, repeated });
      if (this.lostUuids.delete(command.uuid)) this.loseAnswer = true;
    }
    return { sync_status: status, temp_id_mapping: mapping };
  }

  /** Runs one command. Returns the id of what it created, if anything. */
  private run(user: User, { type, args }: SyncCommand, mapping: Record<string, string>): string | null {
    const ref = (name: string) => this.resolve(args[name], mapping, name);
    switch (type) {
      case "project_add":
        return this.projectAdd(user, args);
      case "section_add":
        return this.sectionAdd(user, args, ref("project_id"));
      case "section_update": {
        const section = this.ownSection(user, ref("id"));
        if (args.name !== undefined) section.value.name = text(args.name, "name", 2048);
        this.touch(section);
        return null;
      }
      case "section_archive":
        this.archiveSection(user, this.ownSection(user, ref("id")));
        return null;
      case "section_unarchive": {
        const section = this.ownSection(user, ref("id"));
        section.value.is_archived = false;
        section.value.archived_at = null;
        this.touch(section);
        return null;
      }
      case "section_delete":
        this.deleteSection(user, this.ownSection(user, ref("id")));
        return null;
      case "item_add":
        return this.itemAdd(user, args, mapping);
      case "item_update":
        this.itemUpdate(user, this.ownTask(user, ref("id")), args);
        return null;
      case "item_delete":
        this.deleteTask(user, this.ownTask(user, ref("id")));
        return null;
      case "item_complete": {
        const task = this.ownTask(user, ref("id"));
        if (!task.value.checked) this.completeTask(user, task, this.completedAt(args.date_completed));
        return null;
      }
      case "item_uncomplete": {
        const task = this.ownTask(user, ref("id"));
        if (task.value.checked) this.uncompleteTask(user, task);
        return null;
      }
      case "item_close": {
        // What Todoist's own apps do on a tick: a repeating task moves on, any other is completed.
        const task = this.ownTask(user, ref("id"));
        if (task.value.checked) return null;
        if (task.value.due?.is_recurring) this.completeOccurrence(user, task, null);
        else this.completeTask(user, task, this.stamp());
        return null;
      }
      case "item_update_date_complete": {
        const task = this.ownTask(user, ref("id"));
        const current = task.value.due;
        const given = isRecord(args.due) ? { string: current?.string, lang: current?.lang, ...args.due } : undefined;
        const due = given ? this.dueFrom(user, given) : null;
        const forward = args.is_forward === undefined || Number(args.is_forward) === 1;
        if (forward) this.completeOccurrence(user, task, due);
        else this.undoOccurrence(user, task, due);
        return null;
      }
      default:
        throw new CommandError(invalid("type", `Unknown command ${type}`));
    }
  }

  /** A real id, an id made earlier in this request (temp_id), or an error. */
  private resolve(value: unknown, mapping: Record<string, string>, argument: string): string {
    if (typeof value !== "string" || !value) throw new CommandError(missing(argument));
    if (mapping[value]) return mapping[value];
    // Todoist's own ids are short; a UUID here is a temp id nobody made in this request.
    if (TEMP_ID.test(value)) {
      throw new CommandError({
        error_tag: "INVALID_TEMPID",
        error_code: 15,
        error: "Invalid temporary id",
        http_code: 400,
        error_extra: { argument },
      });
    }
    return value;
  }

  private projectAdd(user: User, args: Json): string {
    const name = text(args.name, "name", 120);
    const own = [...this.projectStore.values()].filter(
      ({ owner, value }) => owner === user.id && !value.inbox_project && !value.is_deleted && !value.is_archived,
    );
    if (own.length >= user.maxProjects) {
      // The free plan's limit. The tag is a guess; the docs do not name it.
      throw new CommandError({
        error_tag: "MAX_PROJECTS_LIMIT_REACHED",
        error_code: 35,
        error: "Maximum number of projects per user limit reached",
        http_code: 403,
        error_extra: { max_count: user.maxProjects },
      });
    }
    return this.newProject(user, name).id;
  }

  private sectionAdd(user: User, args: Json, projectId: string): string {
    const name = text(args.name, "name", 2048);
    const project = this.ownProject(user, projectId);
    if (project.value.is_archived) throw new CommandError(invalid("project_id", "The project is archived"));
    const at = this.stamp();
    const section: FakeSection = {
      id: newId(),
      name,
      project_id: projectId,
      user_id: user.id,
      section_order: ++this.order,
      is_collapsed: false,
      is_deleted: false,
      is_archived: false,
      archived_at: null,
      added_at: at,
      updated_at: at,
    };
    this.sectionStore.set(section.id, { value: section, owner: user.id, rev: ++this.revision });
    return section.id;
  }

  /** Archiving a section completes its open tasks, as in Todoist. */
  private archiveSection(user: User, section: Stored<FakeSection>): void {
    for (const task of this.taskStore.values()) {
      const open = !task.value.checked && !task.value.is_deleted;
      if (open && task.value.section_id === section.value.id) this.completeTask(user, task, this.stamp());
    }
    section.value.is_archived = true;
    section.value.archived_at = this.stamp();
    this.touch(section);
  }

  /** Deleting a section deletes its tasks. */
  private deleteSection(user: User, section: Stored<FakeSection>): void {
    for (const task of this.taskStore.values()) {
      if (task.value.section_id === section.value.id && !task.value.is_deleted) this.deleteTask(user, task);
    }
    section.value.is_deleted = true;
    this.touch(section);
  }

  private itemAdd(user: User, args: Json, mapping: Record<string, string>): string {
    const content = text(args.content, "content", 500);
    const projectId = args.project_id == null ? user.inboxId : this.resolve(args.project_id, mapping, "project_id");
    const project = this.ownProject(user, projectId);
    if (project.value.is_archived) throw new CommandError(invalid("project_id", "The project is archived"));
    let sectionId: string | null = null;
    if (args.section_id != null) {
      const section = this.ownSection(user, this.resolve(args.section_id, mapping, "section_id"));
      if (section.value.project_id !== projectId) {
        throw new CommandError(invalid("section_id", "The section is in another project"));
      }
      if (section.value.is_archived) throw new CommandError(invalid("section_id", "The section is archived"));
      sectionId = section.value.id;
    }
    const task = this.addTask(user, {
      content,
      description: args.description === undefined ? "" : description(args.description),
      project_id: projectId,
      section_id: sectionId,
      priority: args.priority === undefined ? 1 : priority(args.priority),
      due: args.due === undefined ? null : this.dueFrom(user, args.due),
    });
    return task.id;
  }

  private itemUpdate(user: User, task: StoredTask, args: Json): void {
    const update: TaskChanges = {};
    if (args.content !== undefined) update.content = text(args.content, "content", 500);
    if (args.description !== undefined) update.description = description(args.description);
    if (args.priority !== undefined) update.priority = priority(args.priority);
    if (args.due !== undefined) update.due = this.dueFrom(user, args.due);
    this.updateTask(user, task, update);
  }

  /** Reads a due like the API: { date }, { string }, both, or null. Throws a command error when it cannot. */
  private dueFrom(user: User, input: unknown): TodoistDue | null {
    if (input === null) return null;
    if (!isRecord(input)) throw new CommandError(invalid("due"));
    const words = typeof input.string === "string" ? input.string.trim() : "";
    const lang = typeof input.lang === "string" && input.lang ? input.lang : "en";
    const recurring = RECURRING.test(words);
    const today = localDay(this.clock(), user.timeZone);
    let date = typeof input.date === "string" ? input.date : "";
    if (!date) {
      if (recurring) date = nextOccurrence(words, addDays(today, -1), today);
      else if (words.toLowerCase() === "today") date = today;
      else if (words.toLowerCase() === "tomorrow") date = addDays(today, 1);
      else date = words;
    }
    if (!isDueDate(date)) throw new CommandError(invalid("due", "Invalid date format"));
    return { date, string: words || date, lang, is_recurring: recurring, timezone: null };
  }

  private completedAt(value: unknown): string {
    const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
    // Todoist uses now for a missing date, or one more than a day ahead.
    const now = this.clock();
    return this.stamp(Number.isNaN(at) || at > now + DAY_MS ? now : at);
  }

  // ---------- Changes shared by commands and the person ----------

  private addTask(
    user: User,
    fields: Pick<FakeTask, "content" | "description" | "project_id" | "section_id" | "priority" | "due">,
  ): FakeTask {
    const at = this.stamp();
    const task: FakeTask = {
      id: newId(),
      user_id: user.id,
      ...fields,
      parent_id: null,
      child_order: ++this.order,
      labels: [],
      checked: false,
      is_deleted: false,
      added_at: at,
      added_by_uid: user.id,
      responsible_uid: null,
      completed_at: null,
      updated_at: at,
      deadline: null,
      duration: null,
    };
    this.taskStore.set(task.id, { value: task, owner: user.id, rev: ++this.revision, undo: [] });
    this.logTask(user, "added", task);
    this.emit(user, "item:added", task);
    return task;
  }

  private updateTask(user: User, stored: StoredTask, changes: TaskChanges): FakeWebhook {
    const old = clone(stored.value);
    Object.assign(stored.value, changes);
    this.touch(stored);
    // The activity log keeps changes to content, description and due date only.
    const task = stored.value;
    const extra: Json = {};
    if (task.content !== old.content) extra.last_content = old.content;
    if (task.description !== old.description) {
      Object.assign(extra, { description: task.description, last_description: old.description });
    }
    if (task.due?.date !== old.due?.date) {
      Object.assign(extra, { due_date: task.due?.date ?? null, last_due_date: old.due?.date ?? null });
    }
    if (Object.keys(extra).length) this.logTask(user, "updated", task, extra);
    return this.emit(user, "item:updated", task, { old_item: old, update_intent: "item_updated" });
  }

  private deleteTask(user: User, stored: StoredTask): FakeWebhook {
    stored.value.is_deleted = true;
    this.touch(stored);
    this.logTask(user, "deleted", stored.value);
    return this.emit(user, "item:deleted", stored.value);
  }

  private completeTask(user: User, stored: StoredTask, at: string): FakeWebhook {
    stored.value.checked = true;
    stored.value.completed_at = at;
    this.touch(stored);
    this.logTask(user, "completed", stored.value);
    return this.emit(user, "item:completed", stored.value);
  }

  private uncompleteTask(user: User, stored: StoredTask): FakeWebhook {
    stored.value.checked = false;
    stored.value.completed_at = null;
    this.touch(stored);
    // Uncompleting brings back the section it sits in, as Todoist does.
    const section = stored.value.section_id ? this.sectionStore.get(stored.value.section_id) : undefined;
    if (section?.value.is_archived) {
      section.value.is_archived = false;
      section.value.archived_at = null;
      this.touch(section);
    }
    this.logTask(user, "uncompleted", stored.value);
    return this.emit(user, "item:uncompleted", stored.value);
  }

  /** One occurrence of a repeating task done: to the given due, or the next date its string lands on. */
  private completeOccurrence(user: User, stored: StoredTask, due: TodoistDue | null): FakeWebhook {
    const old = clone(stored.value);
    const current = stored.value.due;
    if (!current) throw new CommandError(invalid("due", "The task has no due date"));
    stored.undo.push(clone(current));
    stored.value.due = due ?? { ...current, date: this.nextDate(user, current) };
    this.touch(stored);
    this.logTask(user, "completed", stored.value, { due_date: stored.value.due.date, last_due_date: current.date });
    return this.emit(user, "item:updated", stored.value, { old_item: old, update_intent: "item_completed" });
  }

  /** A repeating completion undone: to the given due, or back to the date before the last completion. */
  private undoOccurrence(user: User, stored: StoredTask, due: TodoistDue | null): FakeWebhook {
    const old = clone(stored.value);
    const before = stored.undo.pop() ?? null;
    const back = due ?? before;
    if (!back) throw new CommandError(invalid("due", "There is no completion to undo"));
    stored.value.due = back;
    this.touch(stored);
    this.logTask(user, "uncompleted", stored.value, { due_date: back.date, last_due_date: old.due?.date ?? null });
    return this.emit(user, "item:updated", stored.value, { old_item: old, update_intent: "item_uncompleted" });
  }

  /** The next date after the later of the task's date and the user's today, with the same time of day. */
  private nextDate(user: User, due: TodoistDue): string {
    const day = due.date.slice(0, 10);
    const today = localDay(this.clock(), user.timeZone);
    return nextOccurrence(due.string, day > today ? day : today, day) + due.date.slice(10);
  }

  // ---------- Bookkeeping ----------

  private touch(stored: { value: { updated_at: string | null }; rev: number }): void {
    stored.rev = ++this.revision;
    stored.value.updated_at = this.stamp();
  }

  /** Todoist's time format: six fraction digits. */
  private stamp(ms = this.clock()): string {
    return new Date(ms).toISOString().replace("Z", "000Z");
  }

  private userOf(id: string): User {
    if (!this.users.has(id)) this.addUser({ id });
    return this.users.get(id)!;
  }

  private userJson(user: User): TodoistUser {
    const tzInfo = { timezone: user.timeZone, gmt_string: gmtOffset(user.timeZone, this.clock()) };
    return {
      id: user.id,
      email: user.email,
      full_name: user.fullName,
      inbox_project_id: user.inboxId,
      start_day: user.startDay,
      tz_info: tzInfo,
    };
  }

  private newProject(user: User, name: string, inbox = false): FakeProject {
    const at = this.stamp();
    const project: FakeProject = {
      id: newId(),
      name,
      color: "charcoal",
      parent_id: null,
      child_order: ++this.order,
      view_style: "list",
      is_deleted: false,
      is_archived: false,
      created_at: at,
      updated_at: at,
    };
    if (inbox) project.inbox_project = true;
    this.projectStore.set(project.id, { value: project, owner: user.id, rev: ++this.revision });
    return project;
  }

  private ownTask(user: User, id: string): StoredTask {
    const stored = this.taskStore.get(id);
    if (!stored || stored.owner !== user.id || stored.value.is_deleted) throw new CommandError(itemNotFound());
    return stored;
  }

  private ownProject(user: User, id: string): Stored<FakeProject> {
    const stored = this.projectStore.get(id);
    if (!stored || stored.owner !== user.id || stored.value.is_deleted) throw new CommandError(projectNotFound());
    return stored;
  }

  private ownSection(user: User, id: string): Stored<FakeSection> {
    const stored = this.sectionStore.get(id);
    if (!stored || stored.owner !== user.id || stored.value.is_deleted) throw new CommandError(sectionNotFound());
    return stored;
  }

  private personTask(taskId: string): { user: User; stored: StoredTask } {
    const stored = this.taskStore.get(taskId);
    if (!stored || stored.value.is_deleted) throw new Error(`Fake Todoist: no task ${taskId}`);
    return { user: this.userOf(stored.owner), stored };
  }

  private personProject(projectId: string): { user: User; stored: Stored<FakeProject> } {
    const stored = this.projectStore.get(projectId);
    if (!stored || stored.value.is_deleted) throw new Error(`Fake Todoist: no project ${projectId}`);
    return { user: this.userOf(stored.owner), stored };
  }

  private logTask(user: User, eventType: string, task: FakeTask, extra: Json = {}): void {
    const what = { object_type: "item", object_id: task.id, event_type: eventType, parent_project_id: task.project_id };
    this.logActivity(user, what, { content: task.content, ...extra });
  }

  private logActivity(
    user: User,
    what: Pick<FakeActivity, "object_type" | "object_id" | "event_type" | "parent_project_id">,
    extra: Json,
  ): void {
    const id = this.activityLog.length + 1;
    const event: FakeActivity = {
      id,
      ...what,
      event_date: this.stamp(),
      parent_item_id: null,
      initiator_id: null,
      extra_data_id: id,
      extra_data: { client: "fake-todoist", ...extra },
    };
    this.activityLog.push({ owner: user.id, event });
  }

  /** Builds the signed webhook for an event; subscribed events also go to webhooks(). */
  private emit(user: User, eventName: string, data: object, extra?: Json): FakeWebhook {
    const eventData = clone({ ...data }) as Json;
    if (eventName.startsWith("item:")) eventData.url = `https://app.todoist.com/app/task/${eventData.id}`;
    const payload: Json = { event_name: eventName, user_id: user.id, event_data: eventData };
    if (extra) payload.event_data_extra = clone(extra);
    payload.initiator = { email: user.email, full_name: user.fullName, id: user.id, image_id: null, is_premium: false };
    payload.triggered_at = this.stamp();
    payload.version = "10";
    const raw = JSON.stringify(payload);
    const headers = new Headers({
      "Content-Type": "application/json",
      "User-Agent": "Todoist-Webhooks",
      "X-Todoist-Hmac-SHA256": createHmac("sha256", this.clientSecret).update(raw).digest("base64"),
      "X-Todoist-Delivery-ID": randomUUID(),
    });
    if (this.subscribed.has(eventName)) this.webhookLog.push({ raw, headers: new Headers(headers) });
    return { raw, headers };
  }
}

/** A Todoist-looking id: 16 letters and digits. */
function newId(): string {
  return randomBytes(12).toString("base64url").replace(/[-_]/g, "x");
}

function isCommand(value: unknown): value is SyncCommand {
  return isRecord(value) && typeof value.type === "string" && typeof value.uuid === "string" && isRecord(value.args);
}

function text(value: unknown, argument: string, max: number): string {
  if (value === undefined || value === null) throw new CommandError(missing(argument));
  if (typeof value !== "string" || !value.trim()) throw new CommandError(invalid(argument));
  if (value.length > max) throw new CommandError(invalid(argument, `At most ${max} characters`));
  return value;
}

function description(value: unknown): string {
  if (typeof value !== "string") throw new CommandError(invalid("description"));
  if (value.length > 16384) throw new CommandError(invalid("description", "At most 16384 characters"));
  return value;
}

function priority(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 4) {
    throw new CommandError(invalid("priority"));
  }
  return value;
}
