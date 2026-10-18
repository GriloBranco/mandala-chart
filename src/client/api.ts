// Browser-side calls to the app's own API. Every call sends the session cookie.

import { OTHER_ACCOUNT } from "@/domain/errors";

export { OTHER_ACCOUNT };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
  /** True when the request never reached the server (offline, DNS, dropped). */
  get offline(): boolean {
    return this.status === 0;
  }
}

// ---------- the page's account ----------
// Every tab shares the cookies. After someone else signs in (or this account signs out) in
// another tab, a page still open here must not send its work: it would land in the other
// account. So the page is pinned to the account it loaded. Each call first checks that the
// browser is still signed in as it, and names it in a header the server checks too.

export interface PageAccount {
  id: string;
  /** False when the page loaded without the id cookie and took the id from the server. */
  fromCookie: boolean;
  /** Runs before the page leaves because the browser is no longer signed in as this account. */
  onSwitch: () => void;
  /** Runs before going to sign in because the session ended (password changed elsewhere, say). */
  onSignedOut: () => void;
}

let page: PageAccount | null = null;
let leaving = false;

/** The account the browser is signed in as now, from the readable mandala_uid cookie. */
export function cookieAccount(): string | null {
  if (typeof document === "undefined") return null;
  const match = /(?:^|;\s*)mandala_uid=([0-9a-f-]{36})(?:;|$)/.exec(document.cookie);
  return match ? match[1] : null;
}

export function pinAccount(account: PageAccount) {
  page = account;
}

function switched(): boolean {
  if (!page) return false;
  const now = cookieAccount();
  // A page that loaded without the cookie learns of a sign-out from the server's 401 instead.
  return now ? now !== page.id : page.fromCookie;
}

/** Leaves the page for the account the browser is signed in as now, or for sign-in. */
export function leavePage() {
  if (leaving) return;
  leaving = true;
  page?.onSwitch();
  const now = cookieAccount();
  // Reload only into another account. When the cookie still names this one, the server
  // disagrees with it, and a reload would just come back here.
  if (now && now !== page?.id) window.location.reload();
  else window.location.replace("/login");
}

/** Leaves the page when the browser is no longer signed in as its account. True when it did. */
export function leaveIfSwitched(): boolean {
  if (!switched()) return false;
  leavePage();
  return true;
}

function signInAgain() {
  // Even when the page is already leaving: the cookie change that came with this 401 can
  // have started a plain leave first, and this account's copy must still go.
  page?.onSignedOut();
  // Without the readable id, the next open of the app shows nothing of this account.
  if (page && cookieAccount() === page.id) {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `mandala_uid=; Max-Age=0; Path=/; SameSite=Lax${secure}`;
  }
  if (leaving) return;
  leaving = true;
  const next = window.location.pathname + window.location.search;
  window.location.replace(`/login${next !== "/" ? `?next=${encodeURIComponent(next)}` : ""}`);
}

/** fetch for the app's own API: checks the page's account first, names it, and handles 401. */
export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (leaving) throw new ApiError(401, "Not signed in");
  // Not sent: it would go out with another account's cookie.
  if (leaveIfSwitched()) throw new ApiError(401, OTHER_ACCOUNT);
  const headers = new Headers(init.headers);
  if (page) headers.set("X-Mandala-Account", page.id);
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers, credentials: "same-origin", cache: "no-store" });
  } catch {
    throw new ApiError(0, "You're offline. It will sync when you're back.");
  }
  if (response.status === 401) {
    // Read a copy: sign-in calls still need the body for their own message ("Wrong password").
    const data = (await response.clone().json().catch(() => null)) as { error?: string } | null;
    // An account switch is handled the same on every route, sign-out included.
    if (data?.error === OTHER_ACCOUNT) {
      if (typeof window !== "undefined") leavePage();
      throw new ApiError(401, OTHER_ACCOUNT);
    }
    if (!url.startsWith("/api/auth/")) {
      if (typeof window !== "undefined") signInAgain();
      throw new ApiError(401, data?.error ?? "Not signed in");
    }
  }
  return response;
}

interface RequestOptions {
  /** Let the request finish while the page closes (browsers allow up to 64 KB of body). */
  keepalive?: boolean;
}

async function request<T>(method: string, url: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  const form = body instanceof FormData ? body : null;
  const json = body === undefined || form ? undefined : JSON.stringify(body);
  const response = await apiFetch(url, {
    method,
    headers: json === undefined ? undefined : { "Content-Type": "application/json" },
    body: form ?? json,
    keepalive: Boolean(options.keepalive) && (json?.length ?? 0) < 60_000,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (data as { error?: string } | null)?.error ?? `Request failed (${response.status})`;
    throw new ApiError(response.status, message);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body?: unknown, options?: RequestOptions) => request<T>("POST", url, body, options),
  patch: <T>(url: string, body: unknown, options?: RequestOptions) => request<T>("PATCH", url, body, options),
  delete: <T>(url: string, body?: unknown) => request<T>("DELETE", url, body),
};
