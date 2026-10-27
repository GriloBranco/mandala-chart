import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { after, connection, NextResponse, type NextRequest } from "next/server";
import { ZodError, type ZodType } from "zod";
import { readSession, SESSION_COOKIE, UID_COOKIE } from "./auth";
import { HttpError, OTHER_ACCOUNT } from "@/domain/errors";
import { clearSessionCookies, userFor } from "./session";
import { budgetWait, spendBudget } from "./throttle";
import { drainTodoist } from "./todoist";
import type { User } from "./users";

export { HttpError };

/** Every API call from the app names the account its page was loaded for. */
const ACCOUNT_HEADER = "x-mandala-account";

type Handler<C> = (request: NextRequest, context: C, user: User) => Promise<Response>;

/** Methods that change nothing, so a request from another site does no harm. */
const READS = new Set(["GET", "HEAD"]);

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    const response = NextResponse.json({ error: error.message }, { status: error.status });
    // Thrown when the account was deleted while this request ran: drop its cookies too.
    if (error.status === 401) clearSessionCookies(response);
    return response;
  }
  if (error instanceof ZodError) {
    return NextResponse.json({ error: "Invalid input", issues: error.issues }, { status: 400 });
  }
  console.error(error);
  return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
}

/**
 * True when a browser sent this from a page on another site, such as a form that posts to the
 * sign-in route. Scripts send neither header and pass, but they cannot carry someone else's
 * cookies either.
 */
function crossSite(request: NextRequest): boolean {
  // Set by the browser itself, so a page cannot fake it. "none" means the person typed the URL.
  const site = request.headers.get("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "none";
  // Browsers without fetch metadata still send Origin on these requests.
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).host; // "null" (sandboxed pages, some redirects) throws
  } catch {
    return true;
  }
  // Behind a proxy the browser's host arrives as x-forwarded-host, as in Next's Server Actions check.
  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0].trim().toLowerCase();
  const direct = (request.headers.get("host") ?? request.nextUrl.host).toLowerCase();
  return host !== forwarded && host !== direct;
}

function fromAnotherSite(): Response {
  return NextResponse.json({ error: "This request came from another site." }, { status: 403 });
}

/** True when the body is declared as JSON. A form on another site cannot declare that. */
export function isJson(request: Request): boolean {
  return request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json";
}

/** Refuses a body that is not declared as JSON, which also stops cross-site form posts. */
export function requireJson(request: Request): void {
  if (!isJson(request)) throw new HttpError(415, "Send the body as JSON (Content-Type: application/json).");
}

/** 429 with Retry-After, for a caller over one of the limits in throttle.ts. */
export function tooMany(minutes: number, message = `Too many tries. Try again in ${minutes} min.`): Response {
  return NextResponse.json({ error: message }, { status: 429, headers: { "Retry-After": String(minutes * 60) } });
}

/**
 * 401 when the page was loaded for another account than the cookie names: the browser has signed
 * in as someone else since. The cookies stay, since they belong to that other account.
 */
export function otherAccount(request: NextRequest, userId: string): Response | null {
  const page = request.headers.get(ACCOUNT_HEADER);
  if (!page || page === userId) return null;
  return NextResponse.json({ error: OTHER_ACCOUNT }, { status: 401 });
}

function notSignedIn(request: NextRequest): Response {
  const response = NextResponse.json({ error: "Not signed in" }, { status: 401 });
  // A cookie whose account is gone or was signed out: drop it, so the next visit goes straight
  // to sign-in instead of showing this device's copy of that account first.
  if (request.cookies.has(SESSION_COOKIE) || request.cookies.has(UID_COOKIE)) clearSessionCookies(response);
  return response;
}

// Wraps a route handler with the auth check (the proxy checks the cookie too; this is the real
// lock, since it also checks the account exists and was not signed out) and hands the handler
// the signed-in user. Every handler scopes its data to that user. It also refuses changes sent
// from other sites and holds each account to a request budget. Thrown errors become small JSON
// responses.
export function route<C>(handler: Handler<C>): (request: NextRequest, context: C) => Promise<Response> {
  return async (request, context) => {
    await connection(); // API data is per request; never prerender it at build time
    try {
      if (!READS.has(request.method) && crossSite(request)) return fromAnotherSite();
      const session = await readSession(request.cookies);
      if (!session) return notSignedIn(request);
      const mismatch = otherAccount(request, session.userId);
      if (mismatch) return mismatch;
      // Already over budget on this instance: answer without touching the database.
      const known = budgetWait(session.userId);
      if (known) return tooMany(known, `Too many requests. Try again in ${known} min.`);
      const user = await userFor(session);
      if (!user) return notSignedIn(request);
      const wait = await spendBudget(user.id);
      if (wait) return tooMany(wait, `Too many requests. Try again in ${wait} min.`);
      const response = await handler(request, context, user);
      // A change may have queued work for Todoist. It goes out after the answer, so the app
      // never waits on Todoist; what Todoist cannot take now stays queued and is tried later.
      if (user.todoist && !READS.has(request.method)) after(() => drainTodoist(user.id));
      return response;
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/** For routes anyone may call (sign up, sign in, sign out): same checks on origin and errors, no user. */
export function publicRoute<C>(
  handler: (request: NextRequest, context: C) => Promise<Response>,
): (request: NextRequest, context: C) => Promise<Response> {
  return async (request, context) => {
    await connection();
    try {
      if (!READS.has(request.method) && crossSite(request)) return fromAnotherSite();
      return await handler(request, context);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/** Compares without leaking where the texts differ; hashing first gives both the same length. */
function sameText(a: string, b: string): boolean {
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * True for the scheduled jobs (Vercel Cron, the reminder scheduler), which send CRON_SECRET as a
 * bearer token. With no secret set, nobody may run them.
 */
export function fromCron(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && sameText(request.headers.get("authorization") ?? "", `Bearer ${secret}`);
}

export async function readJson<T>(request: NextRequest, schema: ZodType<T>): Promise<T> {
  requireJson(request);
  const body = await request.json().catch(() => {
    throw new HttpError(400, "Body must be JSON");
  });
  return schema.parse(body);
}
