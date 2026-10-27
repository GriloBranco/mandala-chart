import "server-only";
import { createHash } from "node:crypto";
import { TODOIST_API, TODOIST_AUTHORIZE_URL, TODOIST_SCOPES, TODOIST_TOKEN_URL, todoistApp } from "./config";

// Todoist's HTTP API (v1): OAuth, /sync for changes and incremental reads, and a few REST reads.
// Every request goes through one swappable fetch (tests install a fake Todoist) and gives up
// after 15 s, Todoist's own limit for a standard request.

const TIMEOUT_MS = 15_000;
/** Todoist's largest page. */
const PAGE_SIZE = 200;
/** A safety stop for "all pages": 10,000 objects. */
const MAX_PAGES = 50;
/** Ids per GET /tasks?ids= request, so the URL stays short. */
const IDS_PER_REQUEST = 100;
/** Legacy apps get a 10-year token instead of one that expires: it never expires for us. */
const LONG_LIVED_S = 315_360_000;

// Only the fields we use; Todoist sends many more, which are ignored.

export interface TodoistDue {
  date: string;
  string: string;
  lang?: string;
  is_recurring: boolean;
  timezone?: string | null;
}

export interface TodoistTask {
  id: string;
  content: string;
  description: string;
  project_id: string;
  section_id: string | null;
  priority: number;
  due: TodoistDue | null;
  checked: boolean;
  is_deleted: boolean;
  completed_at: string | null;
  updated_at: string | null;
}

export interface TodoistProject {
  id: string;
  name: string;
  is_deleted?: boolean;
  is_archived?: boolean;
  inbox_project?: boolean;
  /** Shared with other Todoist users. */
  shared?: boolean;
  /** Set for a project in a team workspace. */
  workspace_id?: string | null;
}

export interface TodoistSectionObject {
  id: string;
  name: string;
  project_id: string;
  is_deleted?: boolean;
  is_archived?: boolean;
}

export interface TodoistUser {
  id: string;
  email: string;
  full_name?: string;
  tz_info?: { timezone?: string };
  start_day?: number;
  inbox_project_id?: string;
}

export interface SyncCommand {
  type: string;
  uuid: string;
  temp_id?: string;
  args: Record<string, unknown>;
}

export type CommandStatus =
  | "ok"
  | {
      error_code?: number;
      error_tag?: string;
      error?: string;
      http_code?: number;
      error_extra?: Record<string, unknown>;
    };

export interface SyncResult {
  sync_status?: Record<string, CommandStatus>;
  temp_id_mapping?: Record<string, string>;
  sync_token?: string;
  full_sync?: boolean;
  items?: TodoistTask[];
  projects?: TodoistProject[];
  sections?: TodoistSectionObject[];
  user?: TodoistUser;
}

export interface ActivityEvent {
  id?: number | null;
  object_type: string;
  object_id: string;
  event_type: string;
  event_date: string;
  parent_project_id?: string | null;
  extra_data?: Record<string, unknown> | null;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}

/** An error from Todoist or the network. status 0 = never reached Todoist. */
export class TodoistError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Seconds Todoist asked us to wait (429 and 5xx only), when it said. */
    readonly retryAfter: number | null = null,
    /** Todoist's error_code, when it sent one. */
    readonly code: number | null = null,
  ) {
    super(message);
  }
}

let fetchImpl: typeof fetch | null = null;

/** Tests swap fetch for a fake Todoist. Pass null to restore the real one. */
export function setTodoistFetch(impl: typeof fetch | null): void {
  fetchImpl = impl;
}

/** A stable UUID for a seed, so a retried command keeps its id and Todoist runs it once. */
export function commandId(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5 layout
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Call {
  method: "GET" | "POST";
  url: string;
  /** Sent as Authorization: the person's "Bearer ..." or the app's "Basic ...". */
  authorization?: string;
  /** Sent form-encoded, as Todoist wants for /sync and OAuth. */
  form?: Record<string, string>;
}

/** No answer in time, or no network (fetch throws a TypeError), as status 0. Any other error stays as it is. */
function unreachable(error: unknown): unknown {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return new TodoistError(0, "Todoist did not answer in time.");
  if (error instanceof TypeError) return new TodoistError(0, "Could not reach Todoist.");
  return error;
}

async function call({ method, url, authorization, form }: Call): Promise<Response> {
  const headers: Record<string, string> = {};
  if (authorization) headers.Authorization = authorization;
  if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
  try {
    return await (fetchImpl ?? fetch)(url, {
      method,
      headers,
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw unreachable(error);
  }
}

/** The answer as JSON, or null when it is empty or not JSON. */
async function readBody(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw unreachable(error);
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** Seconds to wait from Retry-After (seconds or a date), else from the body's error_extra.retry_after. */
function retryAfter(response: Response, body: Json): number | null {
  const header = response.headers.get("retry-after")?.trim();
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds);
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  }
  const extra = isRecord(body.error_extra) ? body.error_extra.retry_after : undefined;
  return typeof extra === "number" && extra >= 0 ? extra : null;
}

function failure(response: Response, body: unknown): TodoistError {
  const info = isRecord(body) ? body : {};
  const message = typeof info.error === "string" && info.error ? info.error : `Todoist answered ${response.status}.`;
  const code = typeof info.error_code === "number" ? info.error_code : null;
  const busy = response.status === 429 || response.status >= 500;
  return new TodoistError(response.status, message, busy ? retryAfter(response, info) : null, code);
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await readBody(response);
  if (!response.ok) throw failure(response, body);
  if (!isRecord(body)) throw new TodoistError(502, "Todoist sent an answer that could not be read.");
  return body as T;
}

function withQuery(url: string, query: Record<string, string>): string {
  const search = new URLSearchParams(query).toString();
  return search ? `${url}?${search}` : url;
}

function app(): { clientId: string; clientSecret: string } {
  const registered = todoistApp();
  if (!registered) throw new Error("Todoist is not set up: TODOIST_CLIENT_ID and TODOIST_CLIENT_SECRET are missing");
  return registered;
}

// ---------- OAuth (app credentials from config; no user token) ----------

export function authorizeUrl(state: string, redirectUri: string): string {
  return withQuery(TODOIST_AUTHORIZE_URL, {
    client_id: app().clientId,
    scope: TODOIST_SCOPES,
    state,
    redirect_uri: redirectUri,
    response_type: "code",
  });
}

async function tokenRequest(form: Record<string, string>): Promise<TokenSet> {
  const { clientId, clientSecret } = app();
  const response = await call({
    method: "POST",
    url: TODOIST_TOKEN_URL,
    form: { client_id: clientId, client_secret: clientSecret, ...form },
  });
  const body = await readBody(response);
  const info = isRecord(body) ? body : {};
  if (!response.ok) {
    // Only invalid_grant means the person must connect again. Other refusals are about our
    // app's setup, so they must not look like a lost connection (401).
    if (info.error === "invalid_grant") throw new TodoistError(401, "invalid_grant");
    const error = failure(response, body);
    if (response.status === 429 || response.status >= 500) throw error;
    throw new TodoistError(400, error.message);
  }
  if (typeof info.access_token !== "string" || !info.access_token) {
    throw new TodoistError(502, "Todoist sent no access token.");
  }
  const expiresIn = typeof info.expires_in === "number" ? info.expires_in : null;
  return {
    accessToken: info.access_token,
    refreshToken: typeof info.refresh_token === "string" && info.refresh_token ? info.refresh_token : null,
    expiresAt: expiresIn !== null && expiresIn < LONG_LIVED_S ? Date.now() + expiresIn * 1000 : null,
  };
}

export function exchangeCode(code: string, redirectUri: string): Promise<TokenSet> {
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
}

/**
 * Rotates the refresh token. The result's refreshToken is null when Todoist did not send a new one
 * (a retry inside its 60 s grace window): keep the stored one then. Throws TodoistError(401) on invalid_grant.
 */
export function refreshTokens(refreshToken: string): Promise<TokenSet> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
}

/** Best effort: POST /api/v1/revoke with Basic auth (form body token=..., token_type_hint=access_token). */
export async function revokeToken(accessToken: string): Promise<void> {
  const registered = todoistApp();
  if (!registered) return;
  try {
    const basic = Buffer.from(`${registered.clientId}:${registered.clientSecret}`).toString("base64");
    const response = await call({
      method: "POST",
      url: `${TODOIST_API}/revoke`,
      authorization: `Basic ${basic}`,
      form: { token: accessToken, token_type_hint: "access_token" },
    });
    await response.body?.cancel();
  } catch {
    // The token may already be dead, and forgetting the connection must not fail on it.
  }
}

// ---------- One account's API ----------

export interface TodoistApi {
  /** POST /api/v1/sync, form-encoded: commands (JSON), sync_token, resource_types (JSON). */
  sync(input: { commands?: SyncCommand[]; syncToken?: string; resourceTypes?: string[] }): Promise<SyncResult>;
  user(): Promise<TodoistUser>;
  /** Active tasks by id (GET /api/v1/tasks?ids=a,b, all pages). Completed or deleted ones are absent. */
  tasks(ids: string[]): Promise<TodoistTask[]>;
  /** Active tasks of a project (all pages). */
  projectTasks(projectId: string): Promise<TodoistTask[]>;
  /** Sections of a project (GET /api/v1/sections?project_id=..., all pages). */
  sections(projectId: string): Promise<TodoistSectionObject[]>;
  /** GET /api/v1/projects/{id}; null when Todoist answers 404. */
  project(projectId: string): Promise<TodoistProject | null>;
  /**
   * Item activity since `since` (ISO), oldest first, at most `maxPages` pages of 200. Events at or
   * before `since` are left out (Todoist's date_from includes it), so the newest event already
   * handled does not come back. When more pages wait, the oldest events are the ones left out.
   */
  activities(since: string, maxPages?: number): Promise<ActivityEvent[]>;
}

/**
 * A client for one account. `token()` gives the access token to use; on a 401 the client calls
 * `refresh()` once for a new one and retries. Every request has a 15 s timeout. 429 and 5xx throw
 * TodoistError with retryAfter (seconds) when Todoist sent one; network failures throw status 0.
 */
export function todoistApi(auth: { token(): Promise<string>; refresh(): Promise<string> }): TodoistApi {
  async function request<T>(method: "GET" | "POST", path: string, params: Record<string, string>): Promise<T> {
    const url = `${TODOIST_API}${path}`;
    const send = (token: string) =>
      method === "GET"
        ? call({ method, url: withQuery(url, params), authorization: `Bearer ${token}` })
        : call({ method, url, authorization: `Bearer ${token}`, form: params });
    let response = await send(await auth.token());
    if (response.status === 401) {
      // The token expired or was revoked: get a new one once, then try again.
      await response.body?.cancel();
      response = await send(await auth.refresh());
    }
    return readJson<T>(response);
  }

  async function pages<T>(path: string, query: Record<string, string>, maxPages = MAX_PAGES): Promise<T[]> {
    const all: T[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const params: Record<string, string> = { ...query, limit: String(PAGE_SIZE) };
      if (cursor) params.cursor = cursor;
      const body = await request<{ results?: T[]; next_cursor?: string | null }>("GET", path, params);
      all.push(...(body.results ?? []));
      cursor = body.next_cursor ?? null;
      if (!cursor) break;
    }
    return all;
  }

  return {
    sync({ commands, syncToken, resourceTypes }) {
      const form: Record<string, string> = {};
      if (commands) form.commands = JSON.stringify(commands);
      if (syncToken !== undefined) form.sync_token = syncToken;
      if (resourceTypes) form.resource_types = JSON.stringify(resourceTypes);
      return request<SyncResult>("POST", "/sync", form);
    },

    user() {
      return request<TodoistUser>("GET", "/user", {});
    },

    async tasks(ids) {
      const unique = [...new Set(ids)];
      const found: TodoistTask[] = [];
      for (let i = 0; i < unique.length; i += IDS_PER_REQUEST) {
        found.push(...(await pages<TodoistTask>("/tasks", { ids: unique.slice(i, i + IDS_PER_REQUEST).join(",") })));
      }
      return found;
    },

    projectTasks(projectId) {
      return pages<TodoistTask>("/tasks", { project_id: projectId });
    },

    sections(projectId) {
      return pages<TodoistSectionObject>("/sections", { project_id: projectId });
    },

    async project(projectId) {
      try {
        return await request<TodoistProject>("GET", `/projects/${encodeURIComponent(projectId)}`, {});
      } catch (error) {
        if (error instanceof TodoistError && error.status === 404) return null;
        throw error;
      }
    },

    async activities(since, maxPages = 5) {
      const query: Record<string, string> = { object_type: "item" };
      if (since) query.date_from = since;
      const events = await pages<ActivityEvent>("/activities", query, maxPages);
      const after = since ? Date.parse(since) : Number.NaN;
      const newer = Number.isNaN(after) ? events : events.filter((event) => Date.parse(event.event_date) > after);
      // Todoist lists the newest first; reversed, a stable sort keeps same-time events in order.
      return newer.reverse().sort((a, b) => Date.parse(a.event_date) - Date.parse(b.event_date));
    },
  };
}
