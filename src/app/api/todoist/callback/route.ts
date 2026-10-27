import { after, NextResponse, type NextRequest } from "next/server";
import { readSession } from "@/server/auth";
import { publicRoute } from "@/server/http";
import { userFor } from "@/server/session";
import { spendBudget } from "@/server/throttle";
import { drainTodoist, finishTodoistConnect, STATE_COOKIE } from "@/server/todoist";

/** Goes on to `path` and drops the state cookie, which is good for one answer only. */
function leave(request: NextRequest, path: string): NextResponse {
  const response = NextResponse.redirect(new URL(path, request.url), 302);
  response.cookies.set(STATE_COOKIE, "", { path: "/api/todoist", maxAge: 0 });
  return response;
}

// Todoist sends the browser back here after the person approves the app or says no. Public
// because a browser that is no longer signed in should land on sign-in, not on a 401.
export const GET = publicRoute(async (request) => {
  const session = await readSession(request.cookies);
  const user = session && (await userFor(session));
  if (!user) return leave(request, "/login");
  // It can ask Todoist for a token with the app's secret, so it counts toward the account's request budget.
  if (await spendBudget(user.id)) return leave(request, "/?todoist=error");
  const query = request.nextUrl.searchParams;
  const result = await finishTodoistConnect(user.id, {
    code: query.get("code"),
    state: query.get("state"),
    error: query.get("error"),
    cookie: request.cookies.get(STATE_COOKIE)?.value,
    origin: request.nextUrl.origin,
  });
  // The first send of everything starts once the browser is on its way back to the app.
  if (result === "connected") after(() => drainTodoist(user.id));
  return leave(request, `/?todoist=${result}`);
});
