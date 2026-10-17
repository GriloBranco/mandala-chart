import { NextResponse } from "next/server";
import { authReady } from "@/lib/auth";
import { publicRoute, requireJson, tooMany } from "@/lib/http";
import { spendPasswordTime, verifyPassword } from "@/lib/passwords";
import { setSessionCookies } from "@/lib/session";
import { clearTries, countTry } from "@/lib/throttle";
import { getUserForLogin, normalizeEmail } from "@/lib/users";
import { loginSchema } from "@/lib/validators";

const WRONG = "Wrong email or password.";

export const POST = publicRoute(async (request) => {
  if (!authReady()) {
    return NextResponse.json({ error: "Sign-in is not set up yet (SESSION_SECRET is missing)." }, { status: 503 });
  }
  requireJson(request);
  const parsed = loginSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter your email and password." }, { status: 400 });
  const email = normalizeEmail(parsed.data.email);
  const { password } = parsed.data;

  const wait = await countTry("login", request, email);
  if (wait) return tooMany(wait);

  const user = await getUserForLogin(email);
  // The same slow work either way, so timing does not tell which emails have an account.
  const ok = user ? await verifyPassword(password, user.passwordHash) : (await spendPasswordTime(password), false);
  if (!user || !ok) return NextResponse.json({ error: WRONG }, { status: 401 });

  await clearTries("login", request, email);
  const response = NextResponse.json({ ok: true, user: { id: user.id, email: user.email, headline: user.headline } });
  await setSessionCookies(response, user);
  return response;
});
