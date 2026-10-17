import { NextResponse } from "next/server";
import { readJson, route } from "@/lib/http";
import { deleteGoal, updateGoal } from "@/lib/repo";
import { goalPatchSchema } from "@/lib/validators";

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
