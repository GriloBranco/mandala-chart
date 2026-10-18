import { NextResponse } from "next/server";
import { readJson, route } from "@/server/http";
import { updateCells } from "@/server/repo";
import { cellBatchSchema } from "@/domain/validators";

// Several square changes at once, applied in one transaction.
export const POST = route(async (request, _context, user) => {
  const { updates } = await readJson(request, cellBatchSchema);
  return NextResponse.json(await updateCells(user.id, updates));
});
