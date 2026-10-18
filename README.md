# Mandala

A goal app built on the Mandala chart method, the 9x9 grid Shohei Ohtani filled in during high school:
one goal in the middle, 8 pillars around it, 8 actions for each pillar. You pick the highest-leverage
actions each week, check them off, and report your day by voice or text.

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
- Voice reports: record a few minutes about your day. Gemini transcribes it and proposes updates to the
  chart. You confirm each one before anything changes.
- AI help (optional): suggest pillars and actions, sharpen vague items, and estimate leverage.
- Works offline for edits: changes are saved on the device and sync when you are back online.
- Account page: change password, download all your data, import a backup into a new account, sign out
  everywhere, delete your account.

## Run it locally

```bash
npm install
npm run dev
```

Open http://localhost:3000 and create an account. Local development always uses a SQLite file
(`local.db`). Without `GEMINI_API_KEY` the AI features are hidden.

## Put it online

```bash
./scripts/setup-and-deploy.sh
```

The script logs in to Vercel if needed, creates the project, adds a Turso database through the Vercel
Marketplace (the first time a browser tab asks you to accept Turso's terms), creates the session
secret, sets an invite code (it offers a random one; type `open` to let anyone sign up), optionally
adds a Gemini key, and deploys. It is safe to run again; it only does what is missing.

Environment variables (see `.env.example`):

| Name | Needed | What it is |
| --- | --- | --- |
| `SESSION_SECRET` | yes, in production | Signs the login cookie (32+ random characters) |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | yes, in production | Set by the Turso integration |
| `GEMINI_API_KEY` | optional | Turns on AI and voice reports |
| `GEMINI_MODEL` | optional | Overrides the default model |
| `SIGNUP_CODE` | optional | Invite-only: new accounts must enter this code. Use a random one, not a word |
| `SIGNUPS_CLOSED` | optional | Set to `1` to stop new accounts |
| `AI_DAILY_LIMIT` | optional | Suggestions, Sharpen and Leverage calls per person per day (default 60, `0` turns them off) |
| `REPORT_DAILY_LIMIT` | optional | Report analyses per person per day (default 15, `0` turns them off) |
| `AI_GLOBAL_DAILY_LIMIT` | optional | AI calls per day for everyone together (default 1500, `0` turns AI off for everyone) |

## Limits

These keep a public deployment from being guessed at, flooded or run up. They are fixed in the code
(`src/server/throttle.ts`, `src/server/repo`), except the AI limits above. A network is one IP address,
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
| Backup imports | 5 per network per day, only into an empty account, files up to 4 MB |

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
- The Gemini key stays on the server. Voice recordings are sent to Gemini inside the request and are
  never stored, by this app or as files on Google's side. Only the transcript and the changes you
  confirm are saved.
- Daily AI limits per person and in total keep a public deployment from running up the Gemini bill.
- Use a Gemini key from a Google Cloud project with billing turned on. On the paid tier Google does not
  use prompts or answers to improve its products; on the free tier it may.

## How it is built

Next.js 16 (App Router) on Vercel, Turso (libSQL) for data, Gemini for AI, Tailwind for styles.

### Where code goes

```
src/
  app/          pages and API routes. Routes stay thin: check input, call src/server, answer.
  components/   the screens, one folder per feature, plus ui/ (buttons, sheets) and shared/
  domain/       the chart rules, types, input checks and the backup format. No React, no I/O
  server/       server only: database, data access (repo/), accounts, limits, AI (ai/)
  client/       browser only: the store with the offline queue, API calls, navigation
  proxy.ts      sends signed-out visitors to /login
```

- A rule about the chart (what "done" means, how picks or progress are counted) goes in
  `src/domain`, so the server and the screens use the same one.
- Database access goes in `src/server/repo`, one file per topic (goals, cells, reports, account).
  Every function takes the user's id first and touches only that user's rows.
- AI features live in `src/server/ai`, one file per feature, with the shared coach prompt in
  `coach.ts`. Prompt builders are pure, so they are tested without a key.
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

## Backups

"Download my data" saves everything in an account as one JSON file. "Import a backup" (on the
account page, and on the welcome screen of a new account) loads such a file into an account that
is still empty. Every goal, square and report gets a new id, so a file can go into a new account
on any deployment. The format is in `src/domain/backup.ts`.
