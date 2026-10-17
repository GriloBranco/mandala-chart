import "server-only";
import type { NextResponse } from "next/server";
import { createSessionToken, SESSION_COOKIE, SESSION_MAX_AGE, UID_COOKIE, type Session } from "./auth";
import { getDb } from "./db";
import { getUser, type User } from "./users";

/** The account a signed cookie names, or null when it was deleted or this session was signed out. */
export async function userFor(session: Session): Promise<User | null> {
  const user = await getUser(session.userId);
  return user && user.sessionVersion === session.version ? user : null;
}

/** Signs the account out on every device, this one too: every cookie issued before stops working. */
export async function endAllSessions(userId: string): Promise<void> {
  const db = await getDb();
  await db.execute({ sql: "UPDATE users SET session_version = session_version + 1 WHERE id = ?", args: [userId] });
}

export async function setSessionCookies(response: NextResponse, user: User): Promise<void> {
  const secure = process.env.NODE_ENV === "production";
  response.cookies.set(SESSION_COOKIE, await createSessionToken({ userId: user.id, version: user.sessionVersion }), {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  // Not secret: the page uses it to keep each person's offline copy apart on a shared device.
  response.cookies.set(UID_COOKIE, user.id, { secure, sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE });
}

export function clearSessionCookies(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  response.cookies.set(UID_COOKIE, "", { path: "/", maxAge: 0 });
}
