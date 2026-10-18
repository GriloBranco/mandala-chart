import { NextResponse } from "next/server";
import { readJson, route } from "@/server/http";
import { listReportsWithEvents, saveReport } from "@/server/repo";
import { saveReportSchema } from "@/domain/validators";

export const GET = route(async (request, _context, user) => {
  const params = request.nextUrl.searchParams;
  const goalId = params.get("goalId") ?? undefined;
  const limit = Math.min(200, Math.max(1, Number(params.get("limit")) || 50));
  return NextResponse.json(await listReportsWithEvents(user.id, { goalId, limit }));
});

// Saves a reviewed report and applies only the updates the user kept.
export const POST = route(async (request, _context, user) => {
  const input = await readJson(request, saveReportSchema);
  return NextResponse.json(await saveReport(user.id, input), { status: 201 });
});
