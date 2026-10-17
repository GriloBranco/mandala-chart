import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { authReady } from "@/lib/auth";
import { publicRoute, requireJson, tooMany } from "@/lib/http";
import { hashPassword } from "@/lib/passwords";
import { setSessionCookies } from "@/lib/session";
import { countTry } from "@/lib/throttle";
import { createUser } from "@/lib/users";
import { signupSchema } from "@/lib/validators";

/** Compares without leaking where the texts differ; hashing first gives both the same length. */
function sameText(a: string, b: string): boolean {
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(a), digest(b));
}

export const POST = publicRoute(async (request) => {
  if (!authReady()) {
    return NextResponse.json({ error: "Sign-up is not set up yet (SESSION_SECRET is missing)." }, { status: 503 });
  }
  if (process.env.SIGNUPS_CLOSED === "1") {
    return NextResponse.json({ error: "New accounts are closed right now." }, { status: 403 });
  }
  requireJson(request);
  const parsed = signupSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Check your email and password." }, { status: 400 });
  }
  // Invite-only mode: set SIGNUP_CODE and share it with the people you want in. Each try is
  // counted before the code is compared, so it cannot be guessed at speed.
  const invite = process.env.SIGNUP_CODE?.trim();
  if (invite) {
    const wait = await countTry("invite", request);
    if (wait) return tooMany(wait);
    if (!sameText(parsed.data.code?.trim() ?? "", invite)) {
      return NextResponse.json({ error: "That invite code is not right." }, { status: 403 });
    }
  }

  const wait = await countTry("signup", request);
  if (wait) return tooMany(wait, `Too many new accounts from here. Try again in ${wait} min.`);

  const user = await createUser(parsed.data.email, await hashPassword(parsed.data.password));
  const response = NextResponse.json(
    { ok: true, user: { id: user.id, email: user.email, headline: user.headline } },
    { status: 201 },
  );
  await setSessionCookies(response, user);
  return response;
});
