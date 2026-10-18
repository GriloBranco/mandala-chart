import { NextResponse } from "next/server";
import { readJson, route, tooMany } from "@/server/http";
import { hashPassword, verifyPassword } from "@/server/passwords";
import { setSessionCookies } from "@/server/session";
import { clearTries, countTry } from "@/server/throttle";
import { getPasswordHash, setPassword } from "@/server/users";
import { changePasswordSchema } from "@/domain/validators";

/** New password. Every other device is signed out; this one gets a fresh session. */
export const POST = route(async (request, _context, user) => {
  const { current, next } = await readJson(request, changePasswordSchema);
  // Counted per account: someone at a signed-in device could otherwise guess the current
  // password at speed, then change it and lock the owner out.
  const wait = await countTry("reauth", request, user.id);
  if (wait) return tooMany(wait);
  const hash = await getPasswordHash(user.id);
  if (!hash || !(await verifyPassword(current, hash))) {
    return NextResponse.json({ error: "Your current password is not right." }, { status: 403 });
  }
  await clearTries("reauth", request, user.id);
  const updated = await setPassword(user.id, await hashPassword(next));
  const response = NextResponse.json({ ok: true });
  await setSessionCookies(response, updated);
  return response;
});
