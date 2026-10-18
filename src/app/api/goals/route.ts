import { NextResponse } from "next/server";
import { readJson, route } from "@/server/http";
import { createGoal } from "@/server/repo";
import { createGoalSchema } from "@/domain/validators";

export const POST = route(async (request, _context, user) => {
  const input = await readJson(request, createGoalSchema);
  return NextResponse.json(await createGoal(user.id, input), { status: 201 });
});
