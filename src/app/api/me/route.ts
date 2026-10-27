import { NextResponse } from "next/server";
import { readJson, route, tooMany } from "@/server/http";
import { verifyPassword } from "@/server/passwords";
import { clearSessionCookies } from "@/server/session";
import { clearTries, countTry } from "@/server/throttle";
import { revokeTodoist } from "@/server/todoist";
import { deleteUser, getPasswordHash, updateHeadline } from "@/server/users";
import { accountPatchSchema, deleteAccountSchema } from "@/domain/validators";

const account = (user: { id: string; email: string; headline: string }) => ({
  id: user.id,
  email: user.email,
  headline: user.headline,
});

export const GET = route(async (_request, _context, user) => NextResponse.json(account(user)));

/** The line at the top of Today. */
export const PATCH = route(async (request, _context, user) => {
  const { headline } = await readJson(request, accountPatchSchema);
  return NextResponse.json(account(await updateHeadline(user.id, headline)));
});

/** Deletes the account and everything in it, after checking the password. */
export const DELETE = route(async (request, _context, user) => {
  const { password } = await readJson(request, deleteAccountSchema);
  // Counted per account, so someone at a signed-in device cannot guess the password at speed.
  const wait = await countTry("reauth", request, user.id);
  if (wait) return tooMany(wait);
  const hash = await getPasswordHash(user.id);
  if (!hash || !(await verifyPassword(password, hash))) {
    return NextResponse.json({ error: "Wrong password." }, { status: 403 });
  }
  await clearTries("reauth", request, user.id);
  // Best effort: revoke the Todoist token while it is still stored here.
  await revokeTodoist(user.id);
  await deleteUser(user.id);
  const response = NextResponse.json({ ok: true });
  clearSessionCookies(response);
  return response;
});
