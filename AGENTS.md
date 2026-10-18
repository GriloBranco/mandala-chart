<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## This project

- Follow "Where code goes" in README.md. ESLint enforces the folder rules; do not turn them off.
- Data access stays in `src/server/repo` and is scoped to the signed-in user's id. Add a test in
  `tests/server` for any new query that reads or writes user data.
- Run `npm run check` before every commit, and `npm run test:e2e` after changes to sign-in, sync or
  the main flows.
- A change to the database schema is a new entry at the end of `MIGRATIONS` in `src/server/db.ts`.
  Never edit a shipped entry.
