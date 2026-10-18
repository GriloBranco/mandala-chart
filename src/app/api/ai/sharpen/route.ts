import { NextResponse } from "next/server";
import { sharpen, sharpenInputSchema } from "@/server/ai";
import { requireAi } from "@/server/ai/gemini";
import { readJson, route } from "@/server/http";
import { useQuota } from "@/server/quota";
import { getGoal } from "@/server/repo";

export const maxDuration = 60;

// Rewrites one square so it passes the method's tests. The goal is context only: the new-goal
// flow sharpens before the goal exists, and a deleted goal should not break the button.
export const POST = route(async (request, _context, user) => {
  requireAi();
  const input = await readJson(request, sharpenInputSchema);
  const goal = input.goalId ? await getGoal(user.id, input.goalId).catch(() => null) : null;
  const ask = sharpen(input, goal); // bad input fails here, before any quota is used
  await useQuota(user.id, "ai");
  return NextResponse.json(await ask());
});
