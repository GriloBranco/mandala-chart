import "server-only";
import type { Row } from "@libsql/client";
import { getDb } from "./db";
import { HttpError } from "@/domain/errors";

export interface User {
  id: string;
  email: string;
  headline: string;
  /** Bumped to sign out every device (password change, "sign out everywhere"). */
  sessionVersion: number;
  createdAt: string;
}

function toUser(row: Row): User {
  return {
    id: String(row.id),
    email: String(row.email),
    headline: String(row.headline),
    sessionVersion: Number(row.session_version),
    createdAt: String(row.created_at),
  };
}

function isConflict(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return /SQLITE_CONSTRAINT|UNIQUE constraint/i.test(`${String(code ?? "")} ${String(message ?? "")}`);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function getUser(id: string): Promise<User | null> {
  const db = await getDb();
  const result = await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [id] });
  return result.rows.length ? toUser(result.rows[0]) : null;
}

export async function getUserForLogin(email: string): Promise<(User & { passwordHash: string }) | null> {
  const db = await getDb();
  const result = await db.execute({ sql: "SELECT * FROM users WHERE email = ?", args: [normalizeEmail(email)] });
  if (!result.rows.length) return null;
  return { ...toUser(result.rows[0]), passwordHash: String(result.rows[0].password_hash) };
}

export async function createUser(email: string, passwordHash: string): Promise<User> {
  const db = await getDb();
  const id = crypto.randomUUID();
  try {
    await db.execute({
      sql: "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
      args: [id, normalizeEmail(email), passwordHash, new Date().toISOString()],
    });
  } catch (error) {
    if (isConflict(error)) throw new HttpError(409, "An account with this email already exists. Sign in instead.");
    throw error;
  }
  const user = await getUser(id);
  if (!user) throw new HttpError(500, "Could not create the account");
  return user;
}

export async function updateHeadline(id: string, headline: string): Promise<User> {
  const db = await getDb();
  await db.execute({ sql: "UPDATE users SET headline = ? WHERE id = ?", args: [headline, id] });
  const user = await getUser(id);
  if (!user) throw new HttpError(404, "Account not found");
  return user;
}

/** New password; every other device is signed out. */
export async function setPassword(id: string, passwordHash: string): Promise<User> {
  const db = await getDb();
  await db.execute({
    sql: "UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?",
    args: [passwordHash, id],
  });
  const user = await getUser(id);
  if (!user) throw new HttpError(404, "Account not found");
  return user;
}

export async function getPasswordHash(id: string): Promise<string | null> {
  const db = await getDb();
  const result = await db.execute({ sql: "SELECT password_hash FROM users WHERE id = ?", args: [id] });
  return result.rows.length ? String(result.rows[0].password_hash) : null;
}

/** Deletes the account and everything in it. */
export async function deleteUser(id: string): Promise<void> {
  const db = await getDb();
  await db.batch(
    [
      { sql: "DELETE FROM cells WHERE goal_id IN (SELECT id FROM goals WHERE user_id = ?)", args: [id] },
      { sql: "DELETE FROM checkins WHERE user_id = ?", args: [id] },
      { sql: "DELETE FROM events WHERE user_id = ?", args: [id] },
      { sql: "DELETE FROM reports WHERE user_id = ?", args: [id] },
      { sql: "DELETE FROM goals WHERE user_id = ?", args: [id] },
      { sql: "DELETE FROM users WHERE id = ?", args: [id] },
    ],
    "write",
  );
}
