import { NextResponse } from "next/server";
import { suggest, suggestInputSchema } from "@/lib/ai";
import { requireAi } from "@/lib/gemini";
import { readJson, route } from "@/lib/http";
import { useQuota } from "@/lib/quota";
import { getGoal } from "@/lib/repo";

export const maxDuration = 60;

// Candidate pillars for a goal, or actions for one pillar. Nothing is saved: the user taps what to keep.
export const POST = route(async (request, _context, user) => {
  requireAi();
  const input = await readJson(request, suggestInputSchema);
  const goal = await getGoal(user.id, input.goalId);
  const ask = suggest(goal, input); // bad input fails here, before any quota is used
  await useQuota(user.id, "ai");
  return NextResponse.json(await ask());
});
