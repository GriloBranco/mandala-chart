// Accounts: email + password, and an HMAC-signed session cookie that names the user.
// Web Crypto only, so the proxy and route handlers check it the same way. The proxy only
// checks the signature; route handlers also check the user still exists and the session
// was not signed out (sessionVersion), which needs the database.

export const SESSION_COOKIE = "mandala_session";
/** Readable by the page: only used to keep each person's offline copy separate on a shared device. */
export const UID_COOKIE = "mandala_uid";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 180; // 180 days

const encoder = new TextEncoder();

export interface Session {
  userId: string;
  version: number;
}

/** Null when signing is impossible: production must have a real SESSION_SECRET. */
function secret(): string | null {
  const value = process.env.SESSION_SECRET;
  if (value && value.length >= 16) return value;
  return process.env.NODE_ENV === "production" ? null : "dev-only-secret-not-for-production";
}

export function authReady(): boolean {
  return secret() !== null;
}

function toBase64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(data: string): Promise<string> {
  const key = secret();
  if (!key) throw new Error("SESSION_SECRET is not set");
  const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return toBase64Url(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data)));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function createSessionToken(session: Session): Promise<string> {
  const expires = Date.now() + SESSION_MAX_AGE * 1000;
  const payload = `v2.${session.userId}.${session.version}.${expires}`;
  return `${payload}.${await hmac(payload)}`;
}

export async function readSessionToken(token: string | undefined): Promise<Session | null> {
  if (!token || !authReady()) return null;
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== "v2") return null;
  const [, userId, version, expires, signature] = parts;
  if (!UUID.test(userId) || !/^\d+$/.test(version)) return null;
  const until = Number(expires);
  if (!Number.isFinite(until) || until < Date.now()) return null;
  if (!safeEqual(signature, await hmac(`v2.${userId}.${version}.${expires}`))) return null;
  return { userId, version: Number(version) };
}

type CookieSource = { get(name: string): { value: string } | undefined };

export function readSession(cookies: CookieSource): Promise<Session | null> {
  return readSessionToken(cookies.get(SESSION_COOKIE)?.value);
}
