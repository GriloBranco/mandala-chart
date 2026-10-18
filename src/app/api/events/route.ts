import { NextResponse } from "next/server";
import { route } from "@/server/http";
import { listEvents } from "@/server/repo";

export const GET = route(async (request, _context, user) => {
  const params = request.nextUrl.searchParams;
  const goalId = params.get("goalId") ?? undefined;
  const limit = Math.min(500, Math.max(1, Number(params.get("limit")) || 100));
  return NextResponse.json(await listEvents(user.id, { goalId, limit }));
});
