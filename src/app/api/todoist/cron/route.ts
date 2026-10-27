import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { publicRoute } from "@/server/http";
import { runTodoistDaily } from "@/server/todoist";

// The daily job stops itself after about 50 seconds.
export const maxDuration = 60;

/** Compares without leaking where the texts differ; hashing first gives both the same length. */
function sameText(a: string, b: string): boolean {
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** Vercel Cron sends CRON_SECRET as a bearer token. With no secret set, nobody may run the job. */
function fromCron(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && sameText(request.headers.get("authorization") ?? "", `Bearer ${secret}`);
}

// Once a day (vercel.json): catches up every connected Todoist account, including the ones
// nobody opened the app for, since Todoist's notices can arrive late or not at all.
export const GET = publicRoute(async (request) => {
  if (!fromCron(request)) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  return NextResponse.json(await runTodoistDaily());
});
