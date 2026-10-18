import { NextResponse } from "next/server";
import { readJson, route } from "@/server/http";
import { deleteGoal, updateGoal } from "@/server/repo";
import { goalPatchSchema } from "@/domain/validators";

export const PATCH = route<RouteContext<"/api/goals/[id]">>(async (request, { params }, user) => {
  const { id } = await params;
  const patch = await readJson(request, goalPatchSchema);
  return NextResponse.json(await updateGoal(user.id, id, patch));
});

export const DELETE = route<RouteContext<"/api/goals/[id]">>(async (_request, { params }, user) => {
  const { id } = await params;
  await deleteGoal(user.id, id);
  return NextResponse.json({ ok: true });
});
