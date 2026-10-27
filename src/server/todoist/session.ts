import "server-only";
import {
  claimTodoistLease,
  getTodoistAccount,
  releaseTodoistLease,
  updateTodoistAccount,
  type TodoistAccountRow,
} from "@/server/repo";
import { refreshTokens, todoistApi, TodoistError, type TodoistApi, type TokenSet } from "./api";
import { openToken, SealError, sealToken } from "./crypto";

// One Todoist worker per account at a time, on any server instance. Todoist rotates the refresh
// token on every refresh and revokes every token when a used one comes back after its 60 s grace
// window, so two refreshes at once could cut the person off. A lease in the database prevents that.

/** How long a lease lasts unless keepAlive() extends it. */
const LEASE_MS = 60_000;
/** How often a waiting worker tries the lease again. */
const POLL_MS = 250;
/** A token that expires within this is refreshed before use. */
const EARLY_MS = 60_000;
const REAUTH = "Todoist asked you to connect again.";

type AccountPatch = Partial<Omit<TodoistAccountRow, "userId" | "todoistUserId">>;

export interface TodoistWorker {
  userId: string;
  /** The account as loaded (and kept up to date by update()). */
  account: TodoistAccountRow;
  api: TodoistApi;
  /** Saves changes to the account row and to `account`. */
  update(patch: AccountPatch): Promise<void>;
  /** Extends the lease; call between long steps. Throws when the lease was lost. */
  keepAlive(): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function expiring(account: TodoistAccountRow): boolean {
  return account.expiresAt !== null && account.expiresAt - Date.now() < EARLY_MS;
}

async function takeLease(userId: string, owner: string, waitMs: number): Promise<boolean> {
  const giveUp = Date.now() + waitMs;
  for (;;) {
    const now = Date.now();
    if (await claimTodoistLease(userId, owner, now + LEASE_MS, now)) return true;
    if (Date.now() >= giveUp) return false;
    await sleep(POLL_MS);
  }
}

function startWorker(userId: string, owner: string, account: TodoistAccountRow): TodoistWorker {
  let refreshing: Promise<string> | null = null;

  async function update(patch: AccountPatch): Promise<void> {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    await updateTodoistAccount(userId, defined);
    Object.assign(account, defined);
  }

  async function keepAlive(): Promise<void> {
    const now = Date.now();
    if (!(await claimTodoistLease(userId, owner, now + LEASE_MS, now))) {
      throw new Error("Another Todoist worker took over this account.");
    }
  }

  async function reauth(): Promise<never> {
    await update({ status: "reauth", lastError: REAUTH });
    throw new TodoistError(401, REAUTH);
  }

  /**
   * A token sealed with a key we no longer have is as good as revoked. A key that cannot be built
   * is a setup error: the run fails, and the connection works again once the setup is fixed.
   */
  async function open(sealed: string): Promise<string> {
    try {
      return openToken(sealed);
    } catch (error) {
      if (error instanceof SealError) return reauth();
      throw error;
    }
  }

  async function renew(refreshToken: string): Promise<TokenSet> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await refreshTokens(refreshToken);
      } catch (error) {
        if (!(error instanceof TodoistError)) throw error;
        if (error.status === 401) return reauth();
        // The answer may have been lost after Todoist spent the token. Asking again at once, inside
        // its 60 s grace window, gets the new access token back instead of a replay alarm later.
        if (error.status !== 0 || attempt === 2) throw error;
      }
    }
  }

  async function rotate(): Promise<string> {
    await keepAlive(); // only the lease holder may spend the refresh token
    const stored = await getTodoistAccount(userId);
    if (!stored) throw new TodoistError(401, "Todoist is not connected.");
    if (stored.accessToken !== account.accessToken && !expiring(stored)) {
      // Another worker rotated the pair after our lease ran out: use theirs.
      const { accessToken, refreshToken, expiresAt } = stored;
      Object.assign(account, { accessToken, refreshToken, expiresAt });
      return open(accessToken);
    }
    if (!stored.refreshToken) return reauth(); // a long-lived token that stopped working
    const tokens = await renew(await open(stored.refreshToken));
    await update({
      accessToken: sealToken(tokens.accessToken),
      // A retry inside the grace window brings no new refresh token: the stored one stays.
      refreshToken: tokens.refreshToken ? sealToken(tokens.refreshToken) : stored.refreshToken,
      expiresAt: tokens.expiresAt,
    });
    return tokens.accessToken;
  }

  /** One refresh at a time: requests that find the token dead together share it. */
  function refresh(): Promise<string> {
    refreshing ??= rotate().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  function token(): Promise<string> {
    // Todoist already refused this connection: no more tries until the person connects again.
    if (account.status === "reauth") return Promise.reject(new TodoistError(401, REAUTH));
    if (refreshing || expiring(account)) return refresh();
    return open(account.accessToken);
  }

  return { userId, account, api: todoistApi({ token, refresh }), update, keepAlive };
}

/**
 * Runs `work` while holding the account's lease, so only one Todoist worker runs per account (two token
 * refreshes at once could get every token revoked). Returns null when there is no account, or when another
 * worker still holds the lease after `waitMs` (default 0; polls every 250 ms). The lease lasts 60 s and is
 * extended by keepAlive(); it is always released in finally.
 * Tokens: refreshed before a call when they expire within 60 s, and once after a 401. A rotated token pair
 * is saved at once (sealed). A refresh that Todoist refuses sets status "reauth" and lastError
 * "Todoist asked you to connect again." and throws TodoistError(401).
 */
export async function withTodoist<T>(
  userId: string,
  work: (worker: TodoistWorker) => Promise<T>,
  options: { waitMs?: number } = {},
): Promise<T | null> {
  if (!(await getTodoistAccount(userId))) return null;
  const owner = crypto.randomUUID();
  if (!(await takeLease(userId, owner, options.waitMs ?? 0))) return null;
  try {
    // Read again under the lease: the last holder may have rotated the tokens meanwhile.
    const account = await getTodoistAccount(userId);
    if (!account) return null;
    return await work(startWorker(userId, owner, account));
  } finally {
    // A lease left behind runs out by itself within a minute.
    await releaseTodoistLease(userId, owner).catch((error: unknown) => console.error(error));
  }
}
