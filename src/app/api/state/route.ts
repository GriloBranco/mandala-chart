import { NextResponse } from "next/server";
import { aiEnabled } from "@/lib/gemini";
import { route } from "@/lib/http";
import { addDays, dayKey } from "@/lib/mandala";
import { loadState } from "@/lib/repo";
import { daySchema } from "@/lib/validators";

// Everything the app needs in one request: the account, goals with all their squares, recent check-ins.
export const GET = route(async (request, _context, user) => {
  const since = request.nextUrl.searchParams.get("since");
  const from = since && daySchema.safeParse(since).success ? since : addDays(dayKey(), -60);
  const state = await loadState(user.id, from);
  return NextResponse.json({
    ...state,
    user: { id: user.id, email: user.email, headline: user.headline },
    aiEnabled: aiEnabled(),
  });
});
