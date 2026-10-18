import { NextResponse } from "next/server";
import { BACKUP_FORMAT, BACKUP_VERSION } from "@/domain/backup";
import { route } from "@/server/http";
import { exportData } from "@/server/repo";

/** Everything in the account as one JSON file. "Import a backup" reads the same file. */
export const GET = route(async (_request, _context, user) => {
  const data = await exportData(user.id);
  const day = new Date().toISOString().slice(0, 10);
  return NextResponse.json(
    {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      account: { email: user.email, headline: user.headline },
      ...data,
    },
    { headers: { "Content-Disposition": `attachment; filename="mandala-${day}.json"`, "Cache-Control": "no-store" } },
  );
});
