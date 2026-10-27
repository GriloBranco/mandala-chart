import { NextResponse } from "next/server";
import { readJson, route } from "@/server/http";
import { listReminders, saveReminders } from "@/server/repo";
import { remindersSchema } from "@/domain/validators";

/** The account's reminders. */
export const GET = route(async (_request, _context, user) =>
  NextResponse.json({ reminders: await listReminders(user.id) }),
);

/** Replaces the account's reminders. */
export const PUT = route(async (request, _context, user) => {
  const { reminders } = await readJson(request, remindersSchema);
  return NextResponse.json({ reminders: await saveReminders(user.id, reminders) });
});
