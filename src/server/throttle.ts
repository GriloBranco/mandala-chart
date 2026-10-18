import "server-only";
import type { Client } from "@libsql/client";
import { getDb } from "./db";

// Slows down password guessing and account spam, in fixed windows kept in the database so every
// server instance shares them. Tries are counted before the password is checked, in one atomic
// upsert per key, so parallel requests cannot slip past.
//
// Sign-in has hard limits per network (an IP, or an IPv6 /64) and per account from one network.
// An account as a whole is never locked: anyone who knows the email could then keep its owner
// out. Past a number of tries from anywhere, each try on that account waits a few seconds
// instead. A correct password forgets the account's tries from that network and takes its own
// try back off the other counts, so they count only failures. There is no limit for everyone
// together, since one person could use it up and lock everyone out.
//
// Signed-in accounts also get a request budget (spendBudget), so no account can flood the database.

const MINUTE = 60_000;
/** How long a try waits once its account has had many tries from anywhere. */
const SLOW_MS = 3_000;

/** Where a limit applies: the caller's network, the account, or the account from that network. */
type Scope = "client" | "account" | "account+client";

interface Limit {
  scope: Scope;
  max: number;
  /** Past max, wait SLOW_MS and go ahead instead of refusing. */
  slow?: boolean;
}

interface Bucket {
  windowMs: number;
  limits: Limit[];
}

const BUCKETS = {
  login: {
    windowMs: 15 * MINUTE,
    limits: [
      { scope: "client", max: 20 },
      { scope: "account+client", max: 10 },
      { scope: "account", max: 10, slow: true },
    ],
  },
  signup: { windowMs: 60 * MINUTE, limits: [{ scope: "client", max: 5 }] },
  /** Invite codes (SIGNUP_CODE), counted before the code is compared. */
  invite: { windowMs: 60 * MINUTE, limits: [{ scope: "client", max: 10 }] },
  /**
   * Password checks by someone already signed in (change password, delete account). The account
   * limit ignores the network, since whoever holds the cookie can switch networks.
   */
  reauth: {
    windowMs: 15 * MINUTE,
    limits: [
      { scope: "client", max: 10 },
      { scope: "account", max: 5 },
    ],
  },
  /** Backup imports. Each can write megabytes into a new account, so new accounts cannot fill the database. */
  import: { windowMs: 24 * 60 * MINUTE, limits: [{ scope: "client", max: 5 }] },
} satisfies Record<string, Bucket>;

/** API requests per signed-in account. Generous: a busy person stays far below it. */
const BUDGET = { windowMs: 10 * MINUTE, max: 600 };

export type ThrottleBucket = keyof typeof BUCKETS;
const LONGEST_WINDOW = Math.max(BUDGET.windowMs, ...Object.values(BUCKETS).map((b) => b.windowMs));
const SWEEP_EVERY = 10 * MINUTE;

const COUNT_TRY = `INSERT INTO login_throttle (key, tries, window_start) VALUES (?, 1, ?)
  ON CONFLICT (key) DO UPDATE SET
    tries = CASE WHEN window_start > ? THEN tries + 1 ELSE 1 END,
    window_start = CASE WHEN window_start > ? THEN window_start ELSE excluded.window_start END
  RETURNING key, tries, window_start`;

let table: Promise<unknown> | undefined;
let lastSweep = 0;
// Lockouts this server instance has already seen, so a flood of tries skips the database.
const lockedUntil = new Map<string, number>();

async function db(): Promise<Client> {
  const client = await getDb();
  if (!table) {
    table = client
      .batch(
        [
          "CREATE TABLE IF NOT EXISTS login_throttle (key TEXT PRIMARY KEY, tries INTEGER NOT NULL, window_start INTEGER NOT NULL)",
          "CREATE INDEX IF NOT EXISTS login_throttle_window ON login_throttle (window_start)",
        ],
        "write",
      )
      .catch((error: unknown) => {
        table = undefined; // let the next request try again
        throw error;
      });
  }
  await table;
  return client;
}

/** Drops rows from finished windows now and then, so the table stays small. */
async function sweep(client: Client, now: number): Promise<void> {
  if (now - lastSweep < SWEEP_EVERY) return;
  lastSweep = now;
  await client
    .execute({ sql: "DELETE FROM login_throttle WHERE window_start <= ?", args: [now - LONGEST_WINDOW] })
    .catch((error: unknown) => console.error(error));
}

/** Minutes left on the longest lock among these keys, as this server instance knows it (0 when none). */
function knownWait(keys: string[], now: number): number {
  for (const [key, until] of lockedUntil) if (until <= now) lockedUntil.delete(key);
  const until = Math.max(0, ...keys.map((key) => lockedUntil.get(key) ?? 0));
  return until > now ? Math.ceil((until - now) / MINUTE) : 0;
}

// Vercel's edge sets these headers itself, so callers cannot fake them there.
function clientKey(request: Request): string {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown";
  if (!ip.includes(":") || ip.includes(".")) return `ip:${ip}`;
  // One IPv6 user usually holds a whole /64, so count that block, not each address in it.
  const [head, tail] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const zeros = tail === undefined ? [] : Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0");
  return `ip:${[...left, ...zeros, ...right].slice(0, 4).join(":")}::/64`;
}

interface Key {
  key: string;
  max: number;
  slow: boolean;
  /** After a correct password: forget the key, or only give back the try it just counted. */
  onSuccess: "clear" | "refund";
}

function keysFor(bucket: ThrottleBucket, request: Request, account?: string): Key[] {
  const { limits }: Bucket = BUCKETS[bucket];
  const client = clientKey(request);
  // Encoded, so a made-up "email" containing colons cannot name another account's key.
  const who = account === undefined ? undefined : encodeURIComponent(account);
  const keys: Key[] = [];
  for (const { scope, max, slow = false } of limits) {
    if (scope === "client") {
      keys.push({ key: `${bucket}:${client}`, max, slow, onSuccess: "refund" });
    } else if (who !== undefined) {
      const key = scope === "account" ? `${bucket}:account:${who}` : `${bucket}:account:${who}:${client}`;
      keys.push({ key, max, slow, onSuccess: scope === "account" ? "refund" : "clear" });
    }
  }
  return keys;
}

/**
 * Counts one try. Returns the minutes to wait when over a hard limit, or 0 to go ahead. When the
 * account has had many tries from anywhere, it first waits a few seconds before returning 0.
 */
export async function countTry(bucket: ThrottleBucket, request: Request, account?: string): Promise<number> {
  const now = Date.now();
  const { windowMs } = BUCKETS[bucket];
  const keys = keysFor(bucket, request, account);
  const known = knownWait(keys.map(({ key }) => key), now);
  if (known) return known;
  let until = 0;
  let delay = false;
  try {
    const client = await db();
    const start = now - windowMs;
    const results = await client.batch(
      keys.map(({ key }) => ({ sql: COUNT_TRY, args: [key, now, start, start] })),
      "write",
    );
    for (const [i, { key, max, slow }] of keys.entries()) {
      const row = results[i]?.rows[0];
      if (!row || Number(row.tries) <= max) continue;
      if (slow) {
        delay = true;
        continue;
      }
      const end = Number(row.window_start) + windowMs;
      lockedUntil.set(key, end);
      until = Math.max(until, end);
    }
    await sweep(client, now);
  } catch (error) {
    // A database hiccup must not lock everyone out: the password check still runs.
    console.error(error);
    return 0;
  }
  if (until > now) return Math.ceil((until - now) / MINUTE);
  // The wait comes before the password check, so giving up early tells a guesser nothing.
  if (delay) await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
  return 0;
}

/**
 * After a correct password: forgets the account's tries from this network, and takes this try
 * back off the network and account counts, so those count only failures.
 */
export async function clearTries(bucket: ThrottleBucket, request: Request, account?: string): Promise<void> {
  const keys = keysFor(bucket, request, account);
  for (const { key, onSuccess } of keys) if (onSuccess === "clear") lockedUntil.delete(key);
  try {
    const client = await db();
    await client.batch(
      keys.map(({ key, onSuccess }) =>
        onSuccess === "clear"
          ? { sql: "DELETE FROM login_throttle WHERE key = ?", args: [key] }
          : { sql: "UPDATE login_throttle SET tries = tries - 1 WHERE key = ? AND tries > 0", args: [key] },
      ),
      "write",
    );
  } catch (error) {
    console.error(error);
  }
}

/** Minutes this account must wait for its request budget, from what this instance knows. No database. */
export function budgetWait(userId: string): number {
  return knownWait([`budget:${userId}`], Date.now());
}

/** Counts one API request by a signed-in account. Returns the minutes to wait when over budget, or 0. */
export async function spendBudget(userId: string): Promise<number> {
  const key = `budget:${userId}`;
  const now = Date.now();
  const known = knownWait([key], now);
  if (known) return known;
  try {
    const client = await db();
    const start = now - BUDGET.windowMs;
    const result = await client.execute({ sql: COUNT_TRY, args: [key, now, start, start] });
    await sweep(client, now);
    const row = result.rows[0];
    if (!row || Number(row.tries) <= BUDGET.max) return 0;
    const end = Number(row.window_start) + BUDGET.windowMs;
    lockedUntil.set(key, end);
    return Math.ceil((end - now) / MINUTE);
  } catch (error) {
    // A database hiccup must not block the app; the request finds out on its own.
    console.error(error);
    return 0;
  }
}
