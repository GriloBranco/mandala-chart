import { NextResponse } from "next/server";
import { route } from "@/server/http";
import { addDays, dayKey } from "@/domain/mandala";
import { loadState } from "@/server/repo";
import { todoistInfo } from "@/server/todoist";
import { daySchema } from "@/domain/validators";

// Everything the app needs in one request: the account and its Todoist connection, goals with all
// their squares, recent check-ins.
export const GET = route(async (request, _context, user) => {
  const since = request.nextUrl.searchParams.get("since");
  const from = since && daySchema.safeParse(since).success ? since : addDays(dayKey(), -200);
  const [state, todoist] = await Promise.all([loadState(user.id, from), todoistInfo(user)]);
  return NextResponse.json({
    ...state,
    user: { id: user.id, email: user.email, headline: user.headline, todoist },
  });
});
