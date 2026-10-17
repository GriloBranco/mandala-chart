import { NextResponse } from "next/server";
import { readJson, route } from "@/lib/http";
import { updateCell } from "@/lib/repo";
import { cellPatchSchema } from "@/lib/validators";

export const PATCH = route<RouteContext<"/api/cells/[id]">>(async (request, { params }, user) => {
  const { id } = await params;
  const patch = await readJson(request, cellPatchSchema);
  return NextResponse.json(await updateCell(user.id, id, patch));
});
