import "server-only";
import { createClient, type Client } from "@libsql/client";

// Turso in production, a local SQLite file in development. Same client, same SQL.

let client: Client | undefined;
let ready: Promise<void> | undefined;

/** The local SQLite file: local.db, or MANDALA_DB_FILE (the tests use a fresh one per run). */
const localFile = () => `file:${process.env.MANDALA_DB_FILE || "local.db"}`;

function databaseUrl(): string {
  // Local development never touches the real database by accident (for example after
  // `vercel env pull`), unless asked to with MANDALA_REMOTE_DB=1.
  if (process.env.NODE_ENV !== "production" && !process.env.MANDALA_REMOTE_DB) return localFile();
  const candidates = [
    process.env.TURSO_DATABASE_URL,
    process.env.LIBSQL_URL,
    process.env.DATABASE_URL,
  ];
  const url = candidates.find((u) => u && /^(libsql|https?|wss?|file):/.test(u));
  if (url) return url;
  if (process.env.VERCEL) throw new Error("TURSO_DATABASE_URL is not set");
  return localFile();
}

function databaseToken(): string | undefined {
  return process.env.TURSO_AUTH_TOKEN || process.env.LIBSQL_AUTH_TOKEN || undefined;
}

// Each entry is one schema version. Only ever append; never edit a shipped version.
// Every row belongs to one user: goals, reports, events and check-ins carry user_id, and
// squares belong to their goal. Every query in src/server/repo filters by it.
const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      headline TEXT NOT NULL DEFAULT '',
      session_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      why TEXT NOT NULL DEFAULT '',
      deadline TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      position REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS goals_user ON goals (user_id, position)`,
    // slot -1 is the pillar itself; slots 0-7 are its actions.
    `CREATE TABLE IF NOT EXISTS cells (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      pillar INTEGER NOT NULL,
      slot INTEGER NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'task',
      status TEXT NOT NULL DEFAULT 'todo',
      progress INTEGER NOT NULL DEFAULT 0,
      impact INTEGER,
      effort INTEGER,
      helps TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 0,
      activated_at TEXT,
      done_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE (goal_id, pillar, slot)
    )`,
    `CREATE INDEX IF NOT EXISTS cells_goal ON cells (goal_id)`,
    `CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      goal_id TEXT,
      source TEXT NOT NULL,
      transcript TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      day TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS reports_user ON reports (user_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      goal_id TEXT NOT NULL,
      cell_id TEXT,
      report_id TEXT,
      type TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS events_user ON events (user_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS events_goal ON events (goal_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS events_report ON events (report_id)`,
    `CREATE TABLE IF NOT EXISTS checkins (
      cell_id TEXT NOT NULL,
      goal_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      day TEXT NOT NULL,
      PRIMARY KEY (cell_id, day)
    )`,
    `CREATE INDEX IF NOT EXISTS checkins_user ON checkins (user_id, day)`,
  ],
  // Habits that come back weekly or monthly. repeat_on is the weekday (0-6) or the date (1-31).
  [
    `ALTER TABLE cells ADD COLUMN repeat TEXT NOT NULL DEFAULT 'day'`,
    `ALTER TABLE cells ADD COLUMN repeat_on INTEGER`,
  ],
];

async function migrate(db: Client): Promise<void> {
  await db.execute(
    "CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
  );
  const result = await db.execute("SELECT version FROM schema_version WHERE id = 1");
  const current = result.rows.length ? Number(result.rows[0].version) : 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    try {
      await db.batch(
        [
          ...MIGRATIONS[v],
          {
            sql: "INSERT INTO schema_version (id, version) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET version = excluded.version",
            args: [v + 1],
          },
        ],
        "write",
      );
    } catch (error) {
      // Two server instances can start at once: if the other one already applied this
      // version (ALTER TABLE fails with "duplicate column"), carry on from where it got to.
      const again = await db.execute("SELECT version FROM schema_version WHERE id = 1");
      const now = again.rows.length ? Number(again.rows[0].version) : 0;
      if (now > v) {
        v = now - 1;
        continue;
      }
      throw error;
    }
  }
}

export async function getDb(): Promise<Client> {
  if (!client) client = createClient({ url: databaseUrl(), authToken: databaseToken() });
  if (!ready) {
    ready = migrate(client).catch((error) => {
      ready = undefined; // let the next request try again
      throw error;
    });
  }
  await ready;
  return client;
}
