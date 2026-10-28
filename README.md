# Mandala

A goal app built on the Mandala chart method, the 9x9 grid Shohei Ohtani filled in during high school:
one goal in the middle, 8 pillars around it, 8 actions for each pillar. You pick the highest-leverage
actions each week, check them off, and write a short report about your day.

Works in the browser on desktop and phone. On iPhone, open it in Safari and use Share, then
"Add to Home Screen" so it opens like an app.

## What it does

- Accounts with email and password. Each person sees only their own goals.
- Goals in a sidebar (a drawer on the phone). Each goal is a full 9x9 chart.
- New goal flow: the goal, then 8 pillars, then 8 actions per pillar, then pick week 1.
- Leverage view: rate impact and effort, mark which pillars an action also helps, and pick 5-8 actions a
  week (one per pillar where you can, actions that help two pillars first).
- Today: this week's actions and daily routines (habits) with one-tap check-offs, under your own line
  of motivation that you can edit.
- Reports: write a few lines about your day, for one goal or all of them. Each one is kept in a
  history you can read back.
- Works offline for edits: changes are saved on the device and sync when you are back online.
- Reminders as notifications, if you turn them on on the account page: one every day at 7 PM to
  write your report, and as many more as you like, each at its own time.
- Account page: change password, download all your data, sign out everywhere, delete your account.

## Run it locally

```bash
npm install
npm run dev
```

Open http://localhost:3000 and create an account. Local development always uses a SQLite file
(`local.db`).

## Put it online

```bash
./scripts/setup-and-deploy.sh
```

The script logs in to Vercel if needed, creates the project, adds a Turso database through the Vercel
Marketplace (the first time a browser tab asks you to accept Turso's terms), creates the session
secret, sets an invite code (it offers a random one; type `open` to let anyone sign up), and deploys. It is safe to run again; it only does what is missing.

Environment variables (see `.env.example`):

| Name | Needed | What it is |
| --- | --- | --- |
| `SESSION_SECRET` | yes, in production | Signs the login cookie (32+ random characters) |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | yes, in production | Set by the Turso integration |
| `SIGNUP_CODE` | optional | Invite-only: new accounts must enter this code. Use a random one, not a word |
| `SIGNUPS_CLOSED` | optional | Set to `1` to stop new accounts |
| `TODOIST_CLIENT_ID`, `TODOIST_CLIENT_SECRET` | optional | Turn on Todoist: your app's Client ID and Client secret (see Todoist) |
| `TODOIST_TOKEN_KEY` | optional | Encrypts the stored Todoist tokens (32 random bytes, base64). Without it the key comes from `SESSION_SECRET` |
| `TODOIST_SYNC` | optional | `on` turns the paused Todoist sync back on (see Todoist) |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | optional | Turn on notifications: the app's push keys (see Notifications) |
| `VAPID_SUBJECT` | optional | An `https:` or `mailto:` address push services can reach you at. Defaults to the site's address |
| `CRON_SECRET` | with Todoist or notifications | Lets the scheduled jobs in: Vercel Cron's daily Todoist job and the reminder job (any long random string) |

## Todoist

Paused since 2026-10-28, while a routine that dropped off Today is looked into (see `BACKLOG.md`).
The account page does not offer Todoist, and nothing goes to Todoist or comes back from it.
Connections made before stay in the database, untouched. Everything below is how it works when
`TODOIST_SYNC=on`.

Each person can connect their own Todoist account on the account page. The app keeps a project
named Mandaala there, with a section for each goal. When Todoist's free plan has no room for
another project, it uses the Inbox instead.

- Routines become repeating tasks. A missed daily routine moves to today instead of piling up.
- This week's actions become tasks due at the end of the week.
- Ticks, names, notes and repeats stay the same in both apps, whichever side you change them on.
- Removing an action from this week deletes its task, and deleting the task removes the action
  from this week.
- Achieving, archiving or deleting a goal deletes its open tasks. Restoring the goal brings them back.
- Priority follows the leverage ratings. It never uses p1, which stays yours.
- Tasks you add in Todoist, labels, reminders, times and repeats Mandaala cannot show (every other
  week, say) stay in Todoist only.

Todoist sends a notice for each change made there. The app also catches up when it opens, and once
a day for every account (`vercel.json`), since notices can arrive late or not at all.

To turn it on:

1. Open Todoist's [App Management Console](https://app.todoist.com/app/settings/integrations/app-management)
   and create an app.
2. Set its OAuth redirect URL to `https://<your domain>/api/todoist/callback`.
3. Set its webhook callback URL to `https://<your domain>/api/todoist/webhook`, pick the events
   `item:updated`, `item:completed`, `item:uncompleted`, `item:deleted`, `project:deleted` and
   `project:archived`, then activate the webhook.
4. Add the app's Client ID and Client secret to Vercel as `TODOIST_CLIENT_ID` and
   `TODOIST_CLIENT_SECRET`, add a `CRON_SECRET`, and deploy again.

Connect from that same domain: Todoist only sends people back to the redirect URL you set.

## Notifications

Each person can turn on reminders on the account page, on every phone or computer they want
them on. The first one is every day at 7 PM, to write the day's report; they can change its time
and words, and add more. A reminder goes out on each device's own clock, so it follows them when
they travel.

On iPhone and iPad, notifications only work in the app added to the Home Screen (Safari, Share,
Add to Home Screen), on iOS 16.4 or later. Chrome, Edge, Firefox and Safari on a Mac show them
from the website.

To turn them on:

1. Make the app's push keys with `npx web-push generate-vapid-keys`, and add them to Vercel as
   `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (the public key) and `VAPID_PRIVATE_KEY` (the private key). Add
   a `CRON_SECRET` if there is none yet, and deploy again. New keys mean everyone has to turn
   notifications on again.
2. Have a scheduler call `https://<your domain>/api/notifications/cron` every minute (or every
   few) with the header `Authorization: Bearer <CRON_SECRET>`. Vercel Cron runs at most once a
   day on the Hobby plan, so use an outside one, such as a free [cron-job.org](https://cron-job.org)
   job. A reminder still goes out up to two hours late if the scheduler misses its time, and never
   twice.

## Limits

These keep a public deployment from being guessed at or flooded. They are fixed in the code
(`src/server/throttle.ts`, `src/server/repo`). A network is one IP address,
or one IPv6 /64 block.

| What | Limit |
| --- | --- |
| Wrong sign-ins | 20 per network and 10 per account from one network, per 15 minutes. An account is never locked for everyone: after 10 wrong tries on it from anywhere, each further try waits 3 seconds. Correct sign-ins do not count |
| New accounts | 5 per network per hour |
| Invite code tries | 10 per network per hour |
| Password checks while signed in (change password, delete account) | 5 per account per 15 minutes |
| API requests | 600 per account per 10 minutes |
| Goals | 50 per account, archived ones included |
| Saved reports | 30 per account per day (UTC) |

Over a limit, the app says how long to wait. There is no limit shared by everyone for sign-in or
sign-up, since one person could use it up and lock everyone else out.

## Privacy and safety

- Passwords are stored only as salted scrypt hashes. Sign-in, sign-up and password checks are rate
  limited (see Limits).
- Every database query is scoped to the signed-in account. Each page also names the account it
  loaded for, and the server refuses its requests after the browser has signed in as someone else.
- The server refuses sign-in, sign-up, sign-out and every change sent from another site's page, so a
  page elsewhere cannot sign you in to its own account or act for you.
- Sign out everywhere (on the account page) ends every session on every device. Changing the password
  does the same for every device but the one you are on.
- Todoist tokens are stored encrypted. Disconnecting Todoist, or deleting the account, revokes them.
  Tasks already in Todoist stay there.
- Notifications go only to the push services of Apple, Google, Mozilla and Microsoft. Signing out
  turns them off on that device, and signing out everywhere turns them off on every device.

## How it is built

Next.js 16 (App Router) on Vercel, Turso (libSQL) for data, Tailwind for styles.

### Where code goes

```
src/
  app/          pages and API routes. Routes stay thin: check input, call src/server, answer.
  components/   the screens, one folder per feature, plus ui/ (buttons, sheets) and shared/
  domain/       the chart rules, types and input checks. No React, no I/O
  server/       server only: database, data access (repo/), accounts, limits, Todoist sync (todoist/)
  client/       browser only: the store with the offline queue, API calls, navigation
  proxy.ts      sends signed-out visitors to /login
```

- A rule about the chart (what "done" means, how picks or progress are counted) goes in
  `src/domain`, so the server and the screens use the same one.
- Database access goes in `src/server/repo`, one file per topic (goals, cells, reports, account).
  Every function takes the user's id first and touches only that user's rows.
- A screen goes in its feature folder under `src/components`. Logic used by more than one feature
  moves to `src/domain` (pure) or `src/client` (browser).
- `src/client/store.ts` is the single place that holds app state in the browser and syncs it. It
  stays one module on purpose: its sync state must not be split across files.

ESLint enforces the folder rules: `src/domain` imports nothing from the other folders, browser code
never imports `src/server`, and server code never imports browser code.

### Checks

```bash
npm run check      # types, lint and unit and server tests
npm run test:e2e   # browser tests: builds the app and runs it on port 3140 with a fresh database
BASE_URL=https://your-app.vercel.app npm run test:e2e   # the same against a live site
```

The browser tests create their own accounts and delete them at the end.
