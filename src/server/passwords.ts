import "server-only";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

// scrypt with a per-password salt. N=2^15, r=8 costs about 32 MB and a fraction of a second,
// which makes guessing slow while staying light for a serverless function.
const COST = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const KEY_LENGTH = 32;

function scrypt(password: string, salt: Buffer, length: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password.normalize("NFKC"), salt, length, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH, COST);
  return ["scrypt", COST.N, COST.r, COST.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, n, r, p, salt, hash] = stored.split("$");
  if (algorithm !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: COST.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Same work as a real check, for an unknown email, so timing does not reveal which emails exist. */
export async function spendPasswordTime(password: string): Promise<void> {
  await scrypt(password, randomBytes(16), KEY_LENGTH, COST);
}
