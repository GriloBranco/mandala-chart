import { NextResponse } from "next/server";
import { leverage, leverageInputSchema } from "@/server/ai";
import { requireAi } from "@/server/gemini";
import { readJson, route } from "@/server/http";
import { useQuota } from "@/server/quota";
import { getGoal } from "@/server/repo";

export const maxDuration = 60;

// Impact, effort and synergy for every filled square, plus this week's picks. A suggestion
// layer only: the client decides what to apply.
export const POST = route(async (request, _context, user) => {
  requireAi();
  const { goalId, today, tzOffset } = await readJson(request, leverageInputSchema);
  const goal = await getGoal(user.id, goalId);
  const ask = leverage(goal, { today, tzOffset }); // bad input fails here, before any quota is used
  await useQuota(user.id, "ai");
  return NextResponse.json(await ask());
});
