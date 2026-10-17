import { NextResponse } from "next/server";
import { readJson, route } from "@/lib/http";
import { createGoal } from "@/lib/repo";
import { createGoalSchema } from "@/lib/validators";

export const POST = route(async (request, _context, user) => {
  const input = await readJson(request, createGoalSchema);
  return NextResponse.json(await createGoal(user.id, input), { status: 201 });
});
