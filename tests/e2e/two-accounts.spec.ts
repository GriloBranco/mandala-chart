import { expect, test, type Page } from "@playwright/test";

// Two people on a phone and a laptop: each sees only their own goals, signing out leaves
// nothing behind on the device, and a tab left open as one person never writes into the other.
// Creates two accounts and deletes them at the end, so it can run against the live site.

const stamp = crypto.randomUUID().slice(0, 8);
const alex = { email: `alex-${stamp}@example.com`, password: "alex-password-1" };
const bea = { email: `bea-${stamp}@example.com`, password: "bea-password-22" };
const GOAL = "By June 2027, I will read 20 books";
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const laptop = { viewport: { width: 1440, height: 900 } };

async function signUp(page: Page, who: typeof alex) {
  await page.goto("/login?new=1");
  await page.getByPlaceholder(/email/i).fill(who.email);
  await page.getByPlaceholder(/password/i).fill(who.password);
  await page.getByRole("button", { name: /create account/i }).last().click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

async function signIn(page: Page, who: typeof alex) {
  await page.goto("/login");
  await page.getByPlaceholder(/email/i).fill(who.email);
  await page.getByPlaceholder(/password/i).fill(who.password);
  await page.getByRole("button", { name: /^sign in$/i }).last().click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.getByRole("button", { name: /^sign out$/i }).click();
  await page.waitForURL(/\/login/);
}

interface State {
  user: { id: string; email: string };
  goals: { id: string; title: string }[];
}

const state = (page: Page): Promise<State> => page.evaluate(async () => (await fetch("/api/state")).json());

async function deleteAccount(page: Page, password: string) {
  const status = await page.evaluate(
    async (password) =>
      (
        await fetch("/api/me", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
        })
      ).status,
    password,
  );
  expect(status).toBe(200);
}

test("two accounts stay apart", async ({ browser }) => {
  const alexPhone = await browser.newContext(phone);
  const phonePage = await alexPhone.newPage();
  const errors: string[] = [];
  phonePage.on("pageerror", (error) => errors.push(error.message));
  let alexState!: State;

  await test.step("Alex signs up on a phone and starts a goal", async () => {
    await signUp(phonePage, alex);
    await phonePage.goto("/?v=new");
    await phonePage.getByRole("textbox").first().fill(GOAL);
    await phonePage.getByRole("button", { name: /^next$/i }).click();
    await expect.poll(async () => (await state(phonePage)).goals.length).toBe(1);
    alexState = await state(phonePage);
    expect(alexState.user.email).toBe(alex.email);
  });

  const beaLaptop = await browser.newContext(laptop);
  const laptopPage = await beaLaptop.newPage();

  await test.step("Bea signs up on a laptop and sees nothing of Alex", async () => {
    await signUp(laptopPage, bea);
    const beaState = await state(laptopPage);
    expect(beaState.user.email).toBe(bea.email);
    expect(beaState.goals).toEqual([]);
    await expect(laptopPage.getByText(GOAL)).toHaveCount(0);
    const rename = await laptopPage.evaluate(
      async (id) =>
        (
          await fetch(`/api/goals/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: "stolen" }),
          })
        ).status,
      alexState.goals[0].id,
    );
    expect(rename).toBe(404);
  });

  await test.step("Alex signs out on the phone, Bea signs in there: nothing of Alex is left", async () => {
    await phonePage.goto("/");
    await phonePage.getByRole("navigation", { name: "Main" }).getByRole("button", { name: /goals/i }).click();
    await signOut(phonePage);
    const keys = await phonePage.evaluate(() => Object.keys(localStorage));
    expect(keys.filter((key) => key.includes(alexState.user.id))).toEqual([]);
    await signIn(phonePage, bea);
    expect((await state(phonePage)).goals).toEqual([]);
    await expect(phonePage.getByText(GOAL)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  await test.step("A tab left open as Alex never writes into Bea's account", async () => {
    const shared = await browser.newContext(laptop);
    const alexTab = await shared.newPage();
    await signIn(alexTab, alex);
    await alexTab.goto(`/?g=${alexState.goals[0].id}`);
    await expect(alexTab.getByText(GOAL).first()).toBeVisible();
    const otherTab = await shared.newPage();
    await otherTab.goto("/");
    await signOut(otherTab);
    await signIn(otherTab, bea);
    const refused = await otherTab.evaluate(async (id) => {
      const response = await fetch("/api/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mandala-Account": id },
        body: JSON.stringify({ title: "from Alex's tab" }),
      });
      return response.status;
    }, alexState.user.id);
    expect(refused).toBe(401);
    await alexTab.bringToFront();
    await alexTab.evaluate(() => window.dispatchEvent(new Event("focus"))).catch(() => {});
    await expect(alexTab.getByText(GOAL)).toHaveCount(0);
    expect((await state(otherTab)).goals).toEqual([]);
    const cookie = (await shared.cookies()).find((c) => c.name === "mandala_session");
    expect(cookie?.httpOnly).toBe(true);
    await shared.close();
  });

  await test.step("Both test accounts are deleted", async () => {
    await deleteAccount(laptopPage, bea.password);
    const cleanup = await browser.newContext(laptop);
    const page = await cleanup.newPage();
    await signIn(page, alex);
    await deleteAccount(page, alex.password);
    expect((await cleanup.request.get("/api/state")).status()).toBe(401);
    await cleanup.close();
  });
});
