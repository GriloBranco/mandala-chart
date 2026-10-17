import { NextResponse } from "next/server";
import { readJson, route } from "@/lib/http";
import { setCheckin } from "@/lib/repo";
import { checkinSchema } from "@/lib/validators";

export const POST = route(async (request, _context, user) => {
  const { cellId, day, done } = await readJson(request, checkinSchema);
  await setCheckin(user.id, cellId, day, done);
  return NextResponse.json({ ok: true });
});
