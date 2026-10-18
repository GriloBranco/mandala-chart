import path from "node:path";
import { expect, test } from "@playwright/test";

// Moving a chart from the personal app: sign up, import its "Download my data" file from the
// welcome screen, and everything is there. The fixture was exported from the personal app.

const backup = path.join(__dirname, "fixtures", "personal-backup.json");
const who = { email: `import-${crypto.randomUUID().slice(0, 8)}@example.com`, password: "import-password-1" };

test("a backup from the personal app moves into a new account", async ({ page }) => {
  await page.goto("/login?new=1");
  await page.getByPlaceholder(/email/i).fill(who.email);
  await page.getByPlaceholder(/password/i).fill(who.password);
  await page.getByRole("button", { name: /create account/i }).last().click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));

  // The button opens the hidden file input; setting the file on it directly avoids a native
  // dialog, which keeps headless Chrome from closing.
  await expect(page.getByRole("button", { name: "Have a backup? Import it" })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles(backup);
  await expect(page.getByText("By June 2027, I will run a half marathon").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Read 20 books").first()).toBeVisible();

  const state = await page.evaluate(async () => (await fetch("/api/state?since=2026-01-01")).json());
  const cells = state.goals.flatMap((g: { cells: { text: string; status: string }[] }) => g.cells);
  expect(state.goals).toHaveLength(2);
  expect(cells.find((c: { text: string }) => c.text === "Buy shoes")?.status).toBe("done");
  expect(state.checkins.length).toBe(2);

  // A second import into the same account is refused.
  const again = await page.evaluate(async (file) => {
    const response = await fetch("/api/me/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: file });
    return response.status;
  }, await (await import("node:fs/promises")).readFile(backup, "utf8"));
  expect(again).toBe(409);

  const removed = await page.evaluate(
    async (password) =>
      (await fetch("/api/me", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) }))
        .status,
    who.password,
  );
  expect(removed).toBe(200);
  // Leave the app before the browser closes: a page still showing a deleted account goes to
  // sign-in on its own, and a navigation during close can stall Chrome's teardown.
  await page.goto("/login");
});
