import { NextResponse } from "next/server";
import { readJson, route } from "@/lib/http";
import { updateCells } from "@/lib/repo";
import { cellBatchSchema } from "@/lib/validators";

// Several square changes at once, applied in one transaction.
export const POST = route(async (request, _context, user) => {
  const { updates } = await readJson(request, cellBatchSchema);
  return NextResponse.json(await updateCells(user.id, updates));
});
