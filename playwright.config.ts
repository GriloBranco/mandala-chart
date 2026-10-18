import { defineConfig } from "@playwright/test";

// Runs against BASE_URL when set (for example the live site), otherwise builds the app and
// starts it on port 3140 with a fresh local database.
const baseURL = process.env.BASE_URL ?? "http://localhost:3140";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  workers: 1,
  reporter: "list",
  use: { baseURL, channel: "chrome", headless: true },
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: "rm -f e2e.db && npm run build && npx next start -p 3140",
        url: "http://localhost:3140/login",
        timeout: 600_000,
        reuseExistingServer: false,
        env: { MANDALA_DB_FILE: "e2e.db", SESSION_SECRET: "e2e-secret-not-for-production" },
      },
});
