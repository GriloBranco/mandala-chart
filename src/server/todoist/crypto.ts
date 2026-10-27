import "server-only";
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

// Todoist tokens are stored sealed (AES-256-GCM), so a copy of the database alone cannot act in
// anyone's Todoist. Keys come from TODOIST_TOKEN_KEY when it is set, else from SESSION_SECRET.

const SEALED = "v1";
const TAG_BYTES = 16;
/** The same dev-only fallback as auth.ts, so local development works without secrets. */
const DEV_SECRET = "dev-only-secret-not-for-production";

/** TODOIST_TOKEN_KEY's 32 bytes, or null when it is not set. */
function ownKey(): Buffer | null {
  const value = process.env.TODOIST_TOKEN_KEY?.trim();
  if (!value) return null;
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("TODOIST_TOKEN_KEY must be 32 random bytes in base64");
  return key;
}

function sessionSecret(): string {
  const value = process.env.SESSION_SECRET;
  if (value && value.length >= 16) return value;
  if (process.env.NODE_ENV === "production") throw new Error("Set TODOIST_TOKEN_KEY or SESSION_SECRET");
  return DEV_SECRET;
}

/** A 32-byte key for one use, so the token key and each signing key never match. */
function derive(info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", ownKey() ?? sessionSecret(), "", info, 32));
}

function tokenKey(): Buffer {
  return ownKey() ?? derive("mandala:todoist-token");
}

/** Seals a token for the database: AES-256-GCM, "v1.<iv>.<ciphertext+tag>" in base64url. */
export function sealToken(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return [SEALED, iv.toString("base64url"), data.toString("base64url")].join(".");
}

/** A stored token that does not open: it was changed, or sealed with another key. */
export class SealError extends Error {}

/**
 * Opens a sealed token. Throws SealError when it was changed or sealed with another key. A key
 * that cannot be built (a secret missing or malformed) throws as itself: that is a setup error.
 */
export function openToken(sealed: string): string {
  const [version, iv, data, ...rest] = sealed.split(".");
  if (version !== SEALED || !iv || !data || rest.length) throw new SealError("This is not a sealed Todoist token");
  const key = tokenKey();
  try {
    const bytes = Buffer.from(data, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"), { authTagLength: TAG_BYTES });
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    return Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - TAG_BYTES)), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    throw new SealError("The Todoist token was changed or sealed with another key");
  }
}

/** HMAC-SHA256 (base64url) with a key derived for `purpose`, for signing small values like the OAuth state. */
export function signValue(purpose: string, value: string): string {
  return createHmac("sha256", derive(`mandala:${purpose}`)).update(value).digest("base64url");
}
