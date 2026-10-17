import { NextResponse } from "next/server";
import { readSession } from "@/lib/auth";
import { isJson, otherAccount, publicRoute } from "@/lib/http";
import { clearSessionCookies, endAllSessions, userFor } from "@/lib/session";

async function wantsEverywhere(request: Request): Promise<boolean> {
  if (!isJson(request)) return false;
  const body: unknown = await request.json().catch(() => null);
  return typeof body === "object" && body !== null && (body as { everywhere?: unknown }).everywhere === true;
}

/**
 * Signs this device out. With {"everywhere": true} it first ends every session of the account,
 * on every device, which needs a session that still works.
 */
export const POST = publicRoute(async (request) => {
  const session = await readSession(request.cookies);
  if (session) {
    // A page loaded for another account: these cookies belong to someone else now, so keep them.
    const mismatch = otherAccount(request, session.userId);
    if (mismatch) return mismatch;
  }
  if (await wantsEverywhere(request)) {
    const user = session && (await userFor(session));
    if (!user) {
      const response = NextResponse.json({ error: "Not signed in" }, { status: 401 });
      clearSessionCookies(response);
      return response;
    }
    // If this throws, the answer is a 500 and the cookies stay, so the person can try again.
    await endAllSessions(user.id);
  }
  const response = NextResponse.json({ ok: true });
  clearSessionCookies(response);
  return response;
});
