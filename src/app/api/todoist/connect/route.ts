import { NextResponse } from "next/server";
import { route } from "@/server/http";
import { STATE_COOKIE, startTodoistConnect, todoistAvailable } from "@/server/todoist";

/** Sends the browser to Todoist to approve the app. The cookie ties Todoist's answer to this account. */
export const GET = route(async (request, _context, user) => {
  if (!todoistAvailable()) {
    return NextResponse.json({ error: "Todoist is not set up on this server." }, { status: 404 });
  }
  const { url, cookie } = startTodoistConnect(user.id, request.nextUrl.origin);
  const response = NextResponse.redirect(url, 302);
  // Only the callback reads it, within the few minutes the approval takes.
  response.cookies.set(STATE_COOKIE, cookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/todoist",
    maxAge: 600,
  });
  return response;
});
