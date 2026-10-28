# Backlog

## Todoist sync (paused)

The two-way Todoist sync went live on 2026-10-27. The next morning a daily routine was missing
from Today, so on 2026-10-28 the sync was paused. The code, the tables and the connections stay;
only the switch is off.

### What the pause does

- Unless `TODOIST_SYNC` is `on`, `todoistPaused()` in `src/server/todoist/config.ts` is true.
- The account page does not offer Todoist and shows no connection, so the app asks for no syncs.
- No worker runs (`withTodoist()` returns null): nothing is sent, no catch-up, no daily rollover.
- Todoist's notices are answered 200 and dropped, so Todoist does not send them again.
- Changes made in Mandaala are not queued for Todoist.
- The Mandaala project stays in the person's Todoist as it was. Its tasks no longer change.

### What can take a routine off Today

A routine shows on Today while its goal is active and its square is picked (`active`), a habit,
and not done. The sync can change each of these from Todoist's side:

1. A task deleted in Todoist takes its square out of this week (`deleted()` in
   `src/server/todoist/inbound.ts`), and so does a change Todoist refuses as not found
   (`taskGone()` in `push.ts`). Deleting a section in Todoist deletes its tasks, so it takes out
   every pick of that goal.
2. A routine finished for good in Todoist is done in Mandaala (`doneChanged()`). A webhook counts
   as "for good" when its task repeats and is `checked` (`eventsFromWebhook()`).
3. A Todoist task that stops repeating turns the routine into a task (`changed()`). If Todoist
   drops the repeat of a due sent with both `string` and `date`, the daily rollover in `pull.ts`
   would do this to every daily routine it moves.

The events table logs "paused" and "Done" with their time, which can be matched with Todoist's
activity log to tell which one it was.

### Before turning it back on

- Check on a real Todoist account what the build only assumed:
  - which webhooks a tick of a repeating task sends (`item:updated` with `update_intent`, maybe
    `item:completed` too), and whether `checked` is ever true in them;
  - that a due sent with both `string` and `date` keeps its repeat and takes the date (new
    routines, check-in moves, the rollover);
  - the activity log's `extra_data` for a completion: with `due_date` and no `last_due_date`,
    `occurrenceOf()` in `pull.ts` puts the check-in on the next due day;
  - "every 29th", "every 30th" and "every last day" in short months.
- Make Todoist unable to take a routine off Today: a routine's task deleted or finished there
  only lets go of the link, and a repeat lost there is sent again from Mandaala. Ticks, names and
  notes can still come in.
- Forget the connections from before the pause (`revokeTodoist()`, then `deleteTodoistData()`,
  for each one), so nothing that happened in Todoist meanwhile is replayed. Tasks already in
  Todoist are found again by their link when the person connects.
- Set `TODOIST_SYNC=on` in Vercel and deploy.
