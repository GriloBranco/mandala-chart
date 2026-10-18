import { NextResponse } from "next/server";
import { route } from "@/server/http";
import { exportData } from "@/server/repo";

/** Everything in the account as one JSON file. */
export const GET = route(async (_request, _context, user) => {
  const data = await exportData(user.id);
  const day = new Date().toISOString().slice(0, 10);
  return NextResponse.json(
    { exportedAt: new Date().toISOString(), account: { email: user.email, headline: user.headline }, ...data },
    { headers: { "Content-Disposition": `attachment; filename="mandala-${day}.json"`, "Cache-Control": "no-store" } },
  );
});
