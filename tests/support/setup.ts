import os from "node:os";
import path from "node:path";

// Every test file gets its own empty SQLite database, so tests never touch local.db or each other.
process.env.MANDALA_DB_FILE = path.join(os.tmpdir(), `mandala-test-${process.pid}-${crypto.randomUUID()}.db`);
process.env.SESSION_SECRET ??= "test-secret-not-for-production";
