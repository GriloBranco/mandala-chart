import { NextResponse } from "next/server";
import { BACKUP_MAX_BYTES, backupSchema } from "@/domain/backup";
import { HttpError, readJson, route, tooMany } from "@/server/http";
import { importData } from "@/server/repo";
import { countTry } from "@/server/throttle";

/** Loads a "Download my data" file into this account, which must be empty. */
export const POST = route(async (request, _context, user) => {
  const size = Number(request.headers.get("content-length") ?? 0);
  if (size > BACKUP_MAX_BYTES) throw new HttpError(413, "This file is too large to import.");
  const wait = await countTry("import", request);
  if (wait) return tooMany(wait, `Too many imports from here today. Try again in ${Math.ceil(wait / 60)} h.`);
  const backup = await readJson(request, backupSchema);
  const imported = await importData(user.id, backup);
  return NextResponse.json(imported);
});
