import { NextResponse } from "next/server";
import { fromCron, publicRoute } from "@/server/http";
import { runTodoistDaily } from "@/server/todoist";

// The daily job stops itself after about 50 seconds.
export const maxDuration = 60;

// Once a day (vercel.json): catches up every connected Todoist account, including the ones
// nobody opened the app for, since Todoist's notices can arrive late or not at all.
export const GET = publicRoute(async (request) => {
  if (!fromCron(request)) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  return NextResponse.json(await runTodoistDaily());
});
