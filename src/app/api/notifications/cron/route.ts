import { NextResponse } from "next/server";
import { fromCron, publicRoute } from "@/server/http";
import { runReminders } from "@/server/push";

export const maxDuration = 60;

// Every minute or few, from an outside scheduler (see Notifications in README.md): sends the
// reminders that are due. Vercel Cron runs at most once a day on the Hobby plan.
export const GET = publicRoute(async (request) => {
  if (!fromCron(request)) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  return NextResponse.json(await runReminders(request.nextUrl.origin));
});
