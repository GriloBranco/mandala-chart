import { NextResponse } from "next/server";
import { readJson, route } from "@/server/http";
import { setCheckin } from "@/server/repo";
import { checkinSchema } from "@/domain/validators";

export const POST = route(async (request, _context, user) => {
  const { cellId, day, done } = await readJson(request, checkinSchema);
  await setCheckin(user.id, cellId, day, done);
  return NextResponse.json({ ok: true });
});
