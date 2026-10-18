import { NextResponse } from "next/server";
import { readJson, route } from "@/server/http";
import { updateCell } from "@/server/repo";
import { cellPatchSchema } from "@/domain/validators";

export const PATCH = route<RouteContext<"/api/cells/[id]">>(async (request, { params }, user) => {
  const { id } = await params;
  const patch = await readJson(request, cellPatchSchema);
  return NextResponse.json(await updateCell(user.id, id, patch));
});
