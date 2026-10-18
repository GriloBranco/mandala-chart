import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, readSessionToken, SESSION_MAX_AGE } from "@/server/auth";
import { hashPassword, verifyPassword } from "@/server/passwords";

const session = { userId: crypto.randomUUID(), version: 3 };

describe("session tokens", () => {
  afterEach(() => vi.useRealTimers());

  it("reads back what it signed", async () => {
    expect(await readSessionToken(await createSessionToken(session))).toEqual(session);
  });

  it("refuses a changed token", async () => {
    const token = await createSessionToken(session);
    const other = token.replace(session.userId, crypto.randomUUID());
    const newer = token.replace(".3.", ".4.");
    expect(await readSessionToken(other)).toBeNull();
    expect(await readSessionToken(newer)).toBeNull();
    expect(await readSessionToken("v2.x.1.1.y")).toBeNull();
  });

  it("refuses an expired token", async () => {
    const token = await createSessionToken(session);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + SESSION_MAX_AGE * 1000 + 1000);
    expect(await readSessionToken(token)).toBeNull();
  });
});

describe("passwords", () => {
  it("verifies the right password only", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("correct horse batterY", hash)).toBe(false);
  });
});
