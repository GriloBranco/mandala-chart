import { NextResponse } from "next/server";
import { route } from "@/lib/http";
import { deleteReport } from "@/lib/repo";

export const DELETE = route<RouteContext<"/api/reports/[id]">>(async (_request, { params }, user) => {
  const { id } = await params;
  await deleteReport(user.id, id);
  return NextResponse.json({ ok: true });
});
