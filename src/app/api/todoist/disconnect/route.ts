import { NextResponse } from "next/server";
import { route } from "@/server/http";
import { disconnectTodoist, todoistInfo } from "@/server/todoist";

/** Stops the sync and revokes Todoist's token. Tasks already in Todoist stay there. */
export const POST = route(async (_request, _context, user) => {
  await disconnectTodoist(user.id);
  return NextResponse.json({ todoist: await todoistInfo({ ...user, todoist: false }) });
});
