import { NextResponse } from "next/server";
import { readJson, route } from "@/server/http";
import { queueTodoist, releaseTodoistOutbox } from "@/server/repo";
import { catchUpTodoist, rebuildTodoist, todoistInfo } from "@/server/todoist";
import { todoistSyncSchema } from "@/domain/validators";

/**
 * Takes in what changed in Todoist and sends what waits here. The app calls it when it opens or
 * comes back, and for "Sync now" (force) and "Set it up again" (rebuild). `synced` is false when
 * the catch-up could not run or failed, so "Sync now" does not claim it worked.
 */
export const POST = route(async (request, _context, user) => {
  const { timezone, force, rebuild } = await readJson(request, todoistSyncSchema);
  if (!user.todoist) return NextResponse.json({ changed: false, synced: false, todoist: await todoistInfo(user) });
  if (rebuild) await rebuildTodoist(user.id);
  if (force) {
    // Changes held back after a failed try go now too, not only once their wait is over.
    await releaseTodoistOutbox(user.id);
    await queueTodoist(user.id, "all");
  }
  const result = await catchUpTodoist(user.id, { force, timeZone: timezone });
  return NextResponse.json({
    changed: Boolean(result?.changed),
    synced: Boolean(result?.synced),
    todoist: await todoistInfo(user),
  });
});
