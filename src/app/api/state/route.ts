import { NextResponse } from "next/server";
import { aiEnabled } from "@/server/ai/gemini";
import { route } from "@/server/http";
import { addDays, dayKey } from "@/domain/mandala";
import { loadState } from "@/server/repo";
import { daySchema } from "@/domain/validators";

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
