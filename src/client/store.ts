"use client";

// The client's single source of truth. Every change shows up at once (optimistic), then
// syncs in the background. Unsaved changes survive closing the app (kept in localStorage)
// and flush when the network comes back, so quick edits on the phone are never lost.

import { useSyncExternalStore } from "react";
import { api, ApiError, cookieAccount, leaveIfSwitched, leavePage, OTHER_ACCOUNT, pinAccount } from "./api";
import { addDays, applyPatch, dayKey, syncPatch } from "@/domain/mandala";
import type {
  Account,
  AppState,
  Cell,
  CellPatch,
  Checkin,
  GoalPatch,
  GoalWithCells,
  ProposedUpdate,
  Report,
  ReportSource,
} from "@/domain/types";

export interface StoreState {
  status: "idle" | "loading" | "ready" | "error";
  /** The signed-in account (null until the first answer from the server or the device copy). */
  user: Account | null;
  goals: GoalWithCells[];
  checkins: Checkin[];
  aiEnabled: boolean;
  /** Local changes not yet saved on the server. */
  unsynced: number;
  offline: boolean;
  error: string | null;
}

type Op =
  | { kind: "cell"; id: string; patch: CellPatch }
  | { kind: "goal"; id: string; patch: GoalPatch }
  | { kind: "checkin"; cellId: string; day: string; done: boolean };

// Each person's copy lives under their own keys, so two accounts on one device never mix.
// The page belongs to the account it loaded: the id in the readable mandala_uid cookie the
// server sets at sign-in. Without that cookie it takes the server's first answer, and then
// keeps nothing on the device.
let owner: string | null = null;
let ownerFromCookie = false;
/** Set once the page lets go of its account (signed out, or someone else signed in). */
let closed = false;

function storageKey(name: "state" | "queue"): string | null {
  return owner && ownerFromCookie ? `mandala:${owner}:${name}:v1` : null;
}

/** Whether the browser is still signed in as this page's account. */
function signedInHere(): boolean {
  return owner !== null && cookieAccount() === owner;
}

/** Where this page's account keeps `name` on this device, or null when nothing may be kept now. */
export function localKey(name: string): { account: string; key: string } | null {
  if (!owner || !ownerFromCookie || closed || !signedInHere()) return null;
  return { account: owner, key: `mandala:${owner}:${name}` };
}

const INITIAL: StoreState = {
  status: "idle",
  user: null,
  goals: [],
  checkins: [],
  aiEnabled: false,
  unsynced: 0,
  offline: false,
  error: null,
};

let state: StoreState = INITIAL;
const listeners = new Set<() => void>();
const queue = new Map<string, Op>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let inflight: Promise<void> | null = null;
let flushAgain = false;
/** Ops being sent right now. They stay in the saved queue until the server confirms them. */
let sending: Op[] = [];
/** Goals and squares deleted (or being deleted): their leftover ops are skipped. */
const deleted = new Set<string>();
/** Ops the server confirmed, numbered, so a refresh can re-apply what its answer may lack. */
type Confirmed = Op | { kind: "create"; goal: GoalWithCells };
let confirmedSeq = 0;
let confirmed: { seq: number; op: Confirmed }[] = [];
let refreshTicket = 0;
let retryDelay = 2000;
let started = false;

// ---------- subscription ----------

function emit(next: Partial<StoreState>) {
  // Once the page let go of its account, work still on its way must not show it again.
  if (closed) return;
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getState(): StoreState {
  return state;
}

/** The whole store. Derive what you need with useMemo; the object changes on every update. */
export function useAppState(): StoreState {
  return useSyncExternalStore(subscribe, getState, () => INITIAL);
}

export function useGoal(id: string | null | undefined): GoalWithCells | undefined {
  const { goals } = useAppState();
  return id ? goals.find((g) => g.id === id) : undefined;
}

// ---------- local persistence ----------

function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or full storage: the app still works, it just will not open offline.
  }
}

function hasItem(key: string | null): boolean {
  try {
    return key !== null && window.localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function removeItem(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage blocked: nothing was kept anyway.
  }
}

function removeKeys(drop: (key: string) => boolean) {
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (drop(key)) window.localStorage.removeItem(key);
    }
  } catch {
    // Storage blocked: nothing was kept anyway.
  }
}

function persistState() {
  const key = storageKey("state");
  // Only while the browser is still signed in as this account, so a page left open never
  // writes it back after a sign-out, or next to someone else's.
  if (!key || closed || !signedInHere() || state.user?.id !== owner) return;
  writeJson(key, { user: state.user, goals: state.goals, checkins: state.checkins, aiEnabled: state.aiEnabled });
}

function persistQueue() {
  const key = storageKey("queue");
  if (!key || closed) return;
  // Signed in as someone else now: the edits wait here for this account's next sign-in.
  // But when signing out already removed this account's things, they are not written back.
  if (!signedInHere() && !hasItem(key) && !hasItem(storageKey("state"))) return;
  const ops = [...sending, ...queue.values()];
  if (ops.length) writeJson(key, ops);
  else removeItem(key);
}

/**
 * The page lets go of its account: nothing more is saved, sent or shown. Its unsent edits
 * are already saved under its queue key (every change to the queue is), so they wait there
 * for its next sign-in, unless a sign-out removed them.
 */
function close() {
  closed = true;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = undefined;
  queue.clear();
  sending = [];
  confirmed = [];
  state = INITIAL;
  for (const listener of listeners) listener();
}

/** The session ended (password changed or account deleted elsewhere). The page then goes to sign in. */
function forgetSession() {
  close();
  // Unsent edits stay, and go out after the next sign-in. The copy and the drafts go.
  const account = owner;
  if (account) removeKeys((key) => key.startsWith(`mandala:${account}:`) && key !== `mandala:${account}:queue:v1`);
}

/**
 * Forgets this account on the device (sign out, account deleted): its keys, the keys that
 * name no account, and other accounts' copies. Other accounts' unsent edits and drafts stay.
 */
export function clearLocalData() {
  const account = owner ?? cookieAccount();
  close();
  removeKeys((key) => {
    if (!key.startsWith("mandala:")) return false;
    const match = /^mandala:([0-9a-f-]{36}):(.+)$/.exec(key);
    return !match || match[1] === account || match[2] === "state:v1";
  });
}

// ---------- queue ----------

function opKey(op: Op): string {
  if (op.kind === "checkin") return `checkin:${op.cellId}:${op.day}`;
  return `${op.kind}:${op.id}`;
}

function opTarget(op: Op): string {
  return op.kind === "checkin" ? op.cellId : op.id;
}

function isGone(op: Op): boolean {
  return deleted.has(opTarget(op));
}

function enqueue(op: Op, delay: number) {
  if (isGone(op)) return;
  const key = opKey(op);
  const existing = queue.get(key);
  if (existing && existing.kind === op.kind && op.kind !== "checkin" && existing.kind !== "checkin") {
    queue.set(key, { ...op, patch: { ...existing.patch, ...op.patch } } as Op);
  } else {
    queue.set(key, op);
  }
  persistQueue();
  emit({ unsynced: queue.size });
  scheduleFlush(delay);
}

function scheduleFlush(delay: number) {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flush(), delay);
}

/** Puts failed ops back without overwriting newer edits made while they were in flight. */
function requeue(ops: Op[]) {
  for (const op of ops) {
    if (isGone(op)) continue;
    const key = opKey(op);
    const newer = queue.get(key);
    if (!newer) queue.set(key, op);
    else if (newer.kind !== "checkin" && op.kind !== "checkin") {
      queue.set(key, { ...op, patch: { ...op.patch, ...newer.patch } } as Op);
    }
  }
  persistQueue();
}

type CellOp = Extract<Op, { kind: "cell" }>;

/** The server said no (bad input, square gone): retrying will not help, so drop that op. */
function isRefusal(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 401 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

/** Sends one batch of square edits. Returns the ones the server refused, if any. */
async function sendCells(chunk: CellOp[], keepalive: boolean): Promise<{ refused: CellOp[]; message: string }> {
  try {
    const saved = await api.post<Cell[]>(
      "/api/cells",
      { updates: chunk.map(({ id, patch }) => ({ id, patch })) },
      { keepalive },
    );
    if (!Array.isArray(saved)) return { refused: [], message: "" };
    // The answer lists the squares it has. One left out was not saved (deleted meanwhile, or
    // not this account's), so it must not look saved.
    const found = new Set(saved.map((cell) => cell.id));
    const refused = chunk.filter((op) => !found.has(op.id));
    return { refused, message: refused.length ? "Cell not found" : "" };
  } catch (error) {
    if (!isRefusal(error)) throw error;
    if (chunk.length === 1) return { refused: chunk, message: error.message };
    // One bad square must not sink the others: send them one by one, drop only the bad ones.
    const refused: CellOp[] = [];
    let message = error.message;
    for (const op of chunk) {
      try {
        await api.patch(`/api/cells/${op.id}`, op.patch, { keepalive });
      } catch (single) {
        if (!isRefusal(single)) throw single;
        refused.push(op);
        message = single.message;
      }
    }
    return { refused, message };
  }
}

/** Sends queued edits. While a send is running, returns that send and queues one more pass. */
export function flush(options: { keepalive?: boolean } = {}): Promise<void> {
  if (closed) return Promise.resolve();
  if (inflight) {
    flushAgain = true;
    return inflight;
  }
  if (!queue.size) return Promise.resolve();
  inflight = sendQueued(Boolean(options.keepalive)).finally(() => {
    inflight = null;
    if (flushAgain) {
      flushAgain = false;
      scheduleFlush(0);
    }
  });
  return inflight;
}

async function sendQueued(keepalive: boolean): Promise<void> {
  sending = [...queue.values()].filter((op) => !isGone(op));
  queue.clear();
  persistQueue(); // still saved (as "sending") until the server confirms
  const unsettled = new Set<Op>(sending);
  let refusal: string | null = null;
  const settle = (ops: Op[], refused: Op[] = []) => {
    for (const op of ops) {
      unsettled.delete(op);
      if (!refused.includes(op)) confirmed.push({ seq: ++confirmedSeq, op });
    }
  };
  try {
    const cells = sending.filter((op): op is CellOp => op.kind === "cell");
    for (let i = 0; i < cells.length; i += 100) {
      const chunk = cells.slice(i, i + 100);
      const result = await sendCells(chunk, keepalive);
      if (result.refused.length) refusal = result.message;
      settle(chunk, result.refused);
    }
    for (const op of sending) {
      if (op.kind === "cell") continue;
      try {
        if (op.kind === "goal") await api.patch(`/api/goals/${op.id}`, op.patch, { keepalive });
        else await api.post("/api/checkins", { cellId: op.cellId, day: op.day, done: op.done }, { keepalive });
        settle([op]);
      } catch (error) {
        if (!isRefusal(error)) throw error;
        refusal = error.message;
        settle([op], [op]);
      }
    }
    retryDelay = 2000;
    emit({ unsynced: queue.size, offline: false, error: refusal });
    // Show the server's copy of whatever it refused.
    if (refusal) void refresh();
  } catch (error) {
    const apiError = error instanceof ApiError ? error : new ApiError(0, "Network error");
    // Everything not confirmed goes back in the queue, under any newer edits.
    requeue([...unsettled]);
    if (apiError.status === 401) {
      // Signed out: the edits stay saved on this device and are sent after signing back in.
      emit({ unsynced: queue.size });
    } else {
      emit({ unsynced: queue.size, offline: apiError.offline });
      scheduleFlush(retryDelay);
      retryDelay = Math.min(retryDelay * 2, 60_000);
    }
  } finally {
    sending = [];
    persistQueue();
  }
}

/**
 * Sends pending edits now and waits for them (a few rounds at most), so a server call that
 * reads the chart (AI, reports) sees what is on screen. False when offline or still unsent.
 */
export async function synced(): Promise<boolean> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  for (let round = 0; round < 4; round++) {
    if (!inflight && !queue.size) return true;
    if (state.offline || closed) return false;
    await flush();
  }
  return !inflight && !queue.size;
}

// ---------- local edits ----------

function nowIso() {
  return new Date().toISOString();
}

function replaceCell(goals: GoalWithCells[], id: string, update: (cell: Cell) => Cell): GoalWithCells[] {
  return goals.map((goal) =>
    goal.cells.some((c) => c.id === id)
      ? { ...goal, cells: goal.cells.map((c) => (c.id === id ? update(c) : c)) }
      : goal,
  );
}

function findCell(id: string): Cell | undefined {
  for (const goal of state.goals) {
    const cell = goal.cells.find((c) => c.id === id);
    if (cell) return cell;
  }
  return undefined;
}

function cellIn(goals: GoalWithCells[], id: string): Cell | undefined {
  for (const goal of goals) {
    const cell = goal.cells.find((c) => c.id === id);
    if (cell) return cell;
  }
  return undefined;
}

/** Edits this device still owes the server: being sent, then queued. */
function localOps(): Op[] {
  return [...sending, ...queue.values()];
}

/**
 * Re-applies local work on top of server data, so a refresh never undoes typing: goals created
 * or edits confirmed after the GET started, edits in flight and edits still queued.
 */
function rebase(
  server: Pick<AppState, "goals" | "checkins">,
  ops: Confirmed[],
): Pick<StoreState, "goals" | "checkins"> {
  let goals = server.goals.filter((g) => !deleted.has(g.id));
  let checkins = server.checkins.filter((c) => !deleted.has(c.goalId));
  const time = nowIso();
  for (const op of ops) {
    if (op.kind === "create") {
      if (!deleted.has(op.goal.id) && !goals.some((g) => g.id === op.goal.id)) goals = [op.goal, ...goals];
    }
    if (op.kind === "cell") goals = replaceCell(goals, op.id, (c) => applyPatch(c, op.patch, time));
    if (op.kind === "goal") goals = goals.map((g) => (g.id === op.id ? { ...g, ...op.patch } : g));
    if (op.kind === "checkin") {
      checkins = checkins.filter((c) => !(c.cellId === op.cellId && c.day === op.day));
      const goal = goals.find((g) => g.cells.some((c) => c.id === op.cellId));
      if (op.done && goal) checkins = [...checkins, { cellId: op.cellId, goalId: goal.id, day: op.day }];
    }
  }
  return { goals, checkins };
}

/** Drops queued edits for goals or squares that no longer exist (deleted on another device). */
function pruneQueue(goals: GoalWithCells[]) {
  const goalIds = new Set(goals.map((g) => g.id));
  const cellIds = new Set(goals.flatMap((g) => g.cells.map((c) => c.id)));
  let changed = false;
  for (const [key, op] of queue) {
    const exists = op.kind === "goal" ? goalIds.has(op.id) : cellIds.has(opTarget(op));
    if (!exists) {
      queue.delete(key);
      changed = true;
    }
  }
  if (changed) {
    persistQueue();
    emit({ unsynced: queue.size });
  }
}

export const actions = {
  /** Text edits wait a moment so typing sends one request, not one per key. */
  updateCell(id: string, patch: CellPatch, options: { debounce?: boolean } = {}) {
    const before = findCell(id);
    if (!before) return;
    const time = nowIso();
    emit({ goals: replaceCell(state.goals, id, (c) => applyPatch(c, patch, time)) });
    persistState();
    // Send what the screen now shows, so the server never re-derives it from another state.
    enqueue({ kind: "cell", id, patch: syncPatch(before, patch, time) }, options.debounce ? 700 : 0);
  },

  updateCells(updates: { id: string; patch: CellPatch }[]) {
    const time = nowIso();
    let goals = state.goals;
    const ops: Op[] = [];
    for (const { id, patch } of updates) {
      const before = cellIn(goals, id);
      if (!before) continue;
      goals = replaceCell(goals, id, (c) => applyPatch(c, patch, time));
      ops.push({ kind: "cell", id, patch: syncPatch(before, patch, time) });
    }
    if (!ops.length) return;
    emit({ goals });
    persistState();
    for (const op of ops) enqueue(op, 0);
  },

  updateGoal(id: string, patch: GoalPatch, options: { debounce?: boolean } = {}) {
    if (!state.goals.some((g) => g.id === id)) return;
    emit({ goals: state.goals.map((g) => (g.id === id ? { ...g, ...patch, updatedAt: nowIso() } : g)) });
    persistState();
    enqueue({ kind: "goal", id, patch }, options.debounce ? 700 : 0);
  },

  toggleCheckin(cellId: string, day: string, done: boolean) {
    const goal = state.goals.find((g) => g.cells.some((c) => c.id === cellId));
    if (!goal) return;
    const rest = state.checkins.filter((c) => !(c.cellId === cellId && c.day === day));
    emit({ checkins: done ? [...rest, { cellId, goalId: goal.id, day }] : rest });
    persistState();
    enqueue({ kind: "checkin", cellId, day, done }, 0);
  },

  /** Pass a client id (kept for retries) so a lost response cannot create the goal twice. */
  async createGoal(input: {
    id?: string;
    title: string;
    why?: string;
    deadline?: string | null;
    pillars?: string[];
  }): Promise<GoalWithCells> {
    const goal = await api.post<GoalWithCells>("/api/goals", input);
    // A refresh already on its way may not include the new goal; it re-adds it from here.
    confirmed.push({ seq: ++confirmedSeq, op: { kind: "create", goal } });
    emit({ goals: [goal, ...state.goals.filter((g) => g.id !== goal.id)] });
    persistState();
    return goal;
  },

  async deleteGoal(id: string): Promise<void> {
    const index = state.goals.findIndex((g) => g.id === id);
    if (index < 0) return;
    const goal = state.goals[index];
    const ids = [id, ...goal.cells.map((c) => c.id)];
    // Its queued edits are set aside, not thrown away, until the server confirms the delete.
    const removed: Op[] = [];
    for (const [key, op] of queue) {
      if (op.kind === "goal" ? op.id === id : ids.includes(opTarget(op))) {
        removed.push(op);
        queue.delete(key);
      }
    }
    for (const target of ids) deleted.add(target);
    emit({
      goals: state.goals.filter((g) => g.id !== id),
      checkins: state.checkins.filter((c) => c.goalId !== id),
      unsynced: queue.size,
    });
    persistQueue();
    try {
      await api.delete(`/api/goals/${id}`);
      persistState();
    } catch (error) {
      for (const target of ids) deleted.delete(target);
      requeue(removed);
      // Put it back where it was, keeping edits made to other goals meanwhile.
      const goals = [...state.goals];
      goals.splice(Math.min(index, goals.length), 0, goal);
      emit({
        goals,
        unsynced: queue.size,
        error: error instanceof Error ? error.message : "Could not delete",
      });
      void refresh();
      throw error;
    }
  },

  /** Shows the confirmed updates at once, saves the report, then reloads from the server. */
  async saveReport(input: {
    /** Kept for retries, so a lost response cannot save the report twice. */
    id?: string;
    goalId: string | null;
    source: ReportSource;
    transcript: string;
    summary: string;
    day: string;
    updates: ProposedUpdate[];
  }): Promise<Report> {
    const time = nowIso();
    const before = { goals: state.goals, checkins: state.checkins };
    let goals = state.goals;
    let checkins = state.checkins;
    for (const update of input.updates) {
      if (update.status) goals = replaceCell(goals, update.cellId, (c) => applyPatch(c, { status: update.status }, time));
      if (update.checkin) {
        const goal = goals.find((g) => g.cells.some((c) => c.id === update.cellId));
        if (goal && !checkins.some((c) => c.cellId === update.cellId && c.day === input.day)) {
          checkins = [...checkins, { cellId: update.cellId, goalId: goal.id, day: input.day }];
        }
      }
    }
    emit({ goals, checkins });
    await synced(); // earlier edits first, so the server applies the report on top of them
    let report: Report;
    try {
      report = await api.post<Report>("/api/reports", input);
    } catch (error) {
      // Nothing was saved: stop showing the report's changes (unless newer edits came in since).
      if (state.goals === goals && state.checkins === checkins) emit(before);
      else void refresh();
      throw error;
    }
    void refresh();
    return report;
  },

  /** The line at the top of Today. Shows at once; saved straight away (not queued). */
  async updateHeadline(headline: string): Promise<void> {
    if (!state.user) return;
    const previous = state.user;
    emit({ user: { ...previous, headline } });
    persistState();
    try {
      const user = await api.patch<Account>("/api/me", { headline });
      // Another account answered: the browser signed in as someone else. Keep none of it.
      if (user.id !== previous.id) {
        leavePage();
        throw new ApiError(401, OTHER_ACCOUNT);
      }
      emit({ user });
      persistState();
    } catch (error) {
      if (state.user?.headline === headline) emit({ user: previous });
      persistState();
      throw error;
    }
  },

  refresh: () => refresh(),
  flush: () => flush(),
  synced: () => synced(),
};

export function goalById(id: string): GoalWithCells | undefined {
  return state.goals.find((g) => g.id === id);
}

export function cellById(id: string): Cell | undefined {
  return findCell(id);
}

// ---------- loading ----------

async function refresh(): Promise<void> {
  if (closed) return;
  if (state.status === "idle") emit({ status: "loading" });
  const ticket = ++refreshTicket;
  const seq = confirmedSeq;
  try {
    const since = addDays(dayKey(), -60);
    const server = await api.get<AppState>(`/api/state?since=${since}`);
    if (ticket !== refreshTicket || closed) return; // a newer refresh is on its way, or the page closed
    if (!owner) pin(server.user.id, false);
    else if (server.user.id !== owner) {
      // The browser is signed in as someone else now: never mix their data into this page.
      leavePage();
      return;
    }
    // Work the server confirmed while this GET was in flight may be missing from its answer.
    const late = confirmed.filter((c) => c.seq > seq).map((c) => c.op);
    confirmed = confirmed.filter((c) => c.seq > seq);
    const merged = rebase(server, [...late, ...localOps()]);
    pruneQueue(merged.goals);
    emit({ ...merged, user: server.user, aiEnabled: server.aiEnabled, status: "ready", offline: false });
    persistState();
  } catch (error) {
    if (ticket !== refreshTicket || closed) return;
    const apiError = error instanceof ApiError ? error : null;
    emit({
      status: state.goals.length || state.status === "ready" ? "ready" : "error",
      offline: Boolean(apiError?.offline),
      error: apiError?.offline ? null : error instanceof Error ? error.message : "Could not load",
    });
  }
}

function pin(account: string, fromCookie: boolean) {
  owner = account;
  ownerFromCookie = fromCookie;
  pinAccount({ id: account, fromCookie, onSwitch: close, onSignedOut: forgetSession });
}

/** Call once on the client: paints the last saved copy at once, then syncs. */
export function startStore() {
  if (started || typeof window === "undefined") return;
  started = true;
  // Drafts saved before they were kept per account: whose they are is unknown, so they go.
  removeKeys((key) => /^mandala:(?:new-goal-draft$|brain-dump:|week1-picks:)/.test(key));
  const account = cookieAccount();
  if (account) pin(account, true);
  const stateKey = storageKey("state");
  const queueKey = storageKey("queue");
  const saved = stateKey ? readJson<Pick<AppState, "user" | "goals" | "checkins" | "aiEnabled">>(stateKey) : null;
  // A copy for another account (or an old one without an owner) is never shown.
  const cached = saved && saved.user?.id === owner ? saved : null;
  // The saved list can hold an op that was being sent and a newer one for the same square:
  // merge them in order so neither one's fields are lost.
  const pending = (queueKey ? readJson<Op[]>(queueKey) : null) ?? [];
  for (const op of pending) {
    const key = opKey(op);
    const existing = queue.get(key);
    queue.set(
      key,
      existing && existing.kind === op.kind && op.kind !== "checkin" && existing.kind !== "checkin"
        ? ({ ...op, patch: { ...existing.patch, ...op.patch } } as Op)
        : op,
    );
  }
  if (cached) {
    emit({
      ...rebase(cached, localOps()),
      user: cached.user,
      aiEnabled: cached.aiEnabled,
      status: "ready",
      unsynced: queue.size,
    });
  }
  void flush().then(refresh);

  const resume = () => {
    if (!leaveIfSwitched()) void flush().then(refresh);
  };
  window.addEventListener("online", () => {
    retryDelay = 2000;
    resume();
  });
  window.addEventListener("offline", () => emit({ offline: true }));
  // keepalive lets the last edits finish uploading while the app goes away.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") resume();
    else void flush({ keepalive: true });
  });
  window.addEventListener("pagehide", () => void flush({ keepalive: true }));
  // A window that stays on screen gets no visibility change when another tab signs out or
  // signs in as someone else. It must not keep showing (or sending) this account's data.
  const check = () => void leaveIfSwitched();
  window.addEventListener("storage", check);
  window.addEventListener("focus", check);
  window.addEventListener("pageshow", check);
  if ("cookieStore" in window) window.cookieStore.addEventListener("change", check);
}

export function clearError() {
  emit({ error: null });
}
