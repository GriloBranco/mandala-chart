import { NextResponse } from "next/server";
import { route } from "@/server/http";
import { deleteReport } from "@/server/repo";

export const DELETE = route<RouteContext<"/api/reports/[id]">>(async (_request, { params }, user) => {
  const { id } = await params;
  await deleteReport(user.id, id);
  return NextResponse.json({ ok: true });
});
