import { connection, NextResponse, type NextRequest } from "next/server";
import { handleTodoistWebhook } from "@/server/todoist";

/** Todoist's notices are a few KB. */
const MAX_BODY = 1024 * 1024;

// A notice can wait a few seconds for the account's worker, then send what waits in Mandaala.
export const maxDuration = 60;

function tooLarge(): Response {
  return NextResponse.json({ ok: false }, { status: 413 });
}

// Todoist's notices of changes made there. They come from Todoist's servers with its signature
// instead of a session, so this skips route(): webhook.ts checks the signature on the raw body.
export async function POST(request: NextRequest) {
  await connection();
  if (Number(request.headers.get("content-length")) > MAX_BODY) return tooLarge();
  const raw = await request.text();
  if (raw.length > MAX_BODY) return tooLarge();
  const status = await handleTodoistWebhook(raw, request.headers);
  return NextResponse.json({ ok: status === 200 }, { status });
}
