import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_REMINDER_TIME } from "@/domain/reminders";
import { getDb } from "@/server/db";
import { runReminders, type PushMessage, type PushResult } from "@/server/push";
import {
  claimPushSend,
  deletePushDevice,
  deletePushDevices,
  getPushDevice,
  listReminders,
  savePushDevice,
  saveReminders,
  type PushDevice,
} from "@/server/repo";
import { deleteUser } from "@/server/users";
import { newAccount } from "../support/accounts";

const ZONE = "America/Sao_Paulo";
const SEVEN_PM = Date.parse("2026-03-02T22:00:00Z"); // 7 PM in Sao Paulo
const HOUR = 60 * 60 * 1000;

function device(zone = ZONE): PushDevice {
  return {
    endpoint: `https://web.push.apple.com/${crypto.randomUUID()}`,
    p256dh: "B".repeat(87),
    auth: "A".repeat(22),
    timeZone: zone,
  };
}

async function devicesOf(userId: string): Promise<number> {
  const db = await getDb();
  const result = await db.execute({ sql: "SELECT COUNT(*) AS n FROM push_devices WHERE user_id = ?", args: [userId] });
  return Number(result.rows[0].n);
}

/** A fake push service: records what each endpoint got and answers with `answer`. */
function fakeSender(answer: (endpoint: string) => PushResult = () => "sent") {
  const got = new Map<string, PushMessage[]>();
  const send = async (target: PushDevice, message: PushMessage) => {
    got.set(target.endpoint, [...(got.get(target.endpoint) ?? []), message]);
    return answer(target.endpoint);
  };
  return { got, send };
}

describe("reminders", () => {
  it("start with the daily one when the first device turns notifications on", async () => {
    const user = await newAccount();
    expect(await listReminders(user.id)).toEqual([]);
    const reminders = await savePushDevice(user.id, device());
    expect(reminders).toEqual([{ id: expect.any(String), time: DEFAULT_REMINDER_TIME, text: "" }]);
    // A second device, or the same one again, adds nothing.
    await savePushDevice(user.id, device());
    expect(await listReminders(user.id)).toHaveLength(1);
  });

  it("are replaced as a list, earliest first", async () => {
    const user = await newAccount();
    const [first] = await savePushDevice(user.id, device());
    const extra = { id: crypto.randomUUID(), time: "08:00", text: "Pick today's first action" };
    const saved = await saveReminders(user.id, [{ ...first, text: "Report" }, extra]);
    expect(saved).toEqual([extra, { ...first, text: "Report" }]);
    expect(await saveReminders(user.id, [extra])).toEqual([extra]);
    expect(await saveReminders(user.id, [])).toEqual([]);
  });

  it("keep their old start when only the text changes", async () => {
    const user = await newAccount();
    const id = crypto.randomUUID();
    const db = await getDb();
    const startOf = async () =>
      Number((await db.execute({ sql: "SELECT time_set_at FROM reminders WHERE id = ?", args: [id] })).rows[0].time_set_at);
    await saveReminders(user.id, [{ id, time: "19:00", text: "" }], 1000);
    await saveReminders(user.id, [{ id, time: "19:00", text: "New words" }], 2000);
    expect(await startOf()).toBe(1000);
    await saveReminders(user.id, [{ id, time: "19:30", text: "New words" }], 3000);
    expect(await startOf()).toBe(3000);
  });

  it("of one account are never changed by another", async () => {
    const alex = await newAccount("alex");
    const bea = await newAccount("bea");
    const [mine] = await savePushDevice(alex.id, device());
    await saveReminders(bea.id, [{ ...mine, time: "03:00", text: "Hijacked" }]);
    expect(await listReminders(alex.id)).toEqual([mine]);
    expect(await listReminders(bea.id)).toEqual([]);
  });
});

describe("devices", () => {
  it("can only be read or turned off by their account", async () => {
    const alex = await newAccount("alex");
    const bea = await newAccount("bea");
    const phone = device();
    await savePushDevice(alex.id, phone);
    expect(await getPushDevice(bea.id, phone.endpoint)).toBeNull();
    await deletePushDevice(bea.id, phone.endpoint);
    expect(await getPushDevice(alex.id, phone.endpoint)).toEqual(phone);
    await deletePushDevice(alex.id, phone.endpoint);
    expect(await getPushDevice(alex.id, phone.endpoint)).toBeNull();
  });

  it("move to the account that signs in on them", async () => {
    const alex = await newAccount("alex");
    const bea = await newAccount("bea");
    const phone = device();
    await savePushDevice(alex.id, phone);
    await savePushDevice(bea.id, { ...phone, timeZone: "Europe/London" });
    expect(await getPushDevice(alex.id, phone.endpoint)).toBeNull();
    expect(await getPushDevice(bea.id, phone.endpoint)).toEqual({ ...phone, timeZone: "Europe/London" });
  });

  it("are all forgotten on sign out everywhere, and with the account", async () => {
    const user = await newAccount();
    await savePushDevice(user.id, device());
    await savePushDevice(user.id, device());
    await deletePushDevices(user.id);
    expect(await devicesOf(user.id)).toBe(0);
    expect(await listReminders(user.id)).toHaveLength(1);

    await savePushDevice(user.id, device());
    await deleteUser(user.id);
    expect(await devicesOf(user.id)).toBe(0);
    expect(await listReminders(user.id)).toEqual([]);
  });

  it("are not added for an account that is gone", async () => {
    const user = await newAccount();
    await deleteUser(user.id);
    expect(await savePushDevice(user.id, device())).toEqual([]);
    expect(await devicesOf(user.id)).toBe(0);
  });
});

describe("the reminder job", () => {
  beforeAll(() => {
    // Any value turns sending on; the fake push service never checks the keys.
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = "test-public-key";
    process.env.VAPID_PRIVATE_KEY = "test-private-key";
  });

  async function phoneWithReminder(zone = ZONE) {
    const user = await newAccount();
    const phone = device(zone);
    await savePushDevice(user.id, phone, SEVEN_PM - 24 * HOUR);
    return { user, phone };
  }

  it("sends a due reminder once a day", async () => {
    const { phone } = await phoneWithReminder();
    const push = fakeSender();
    await runReminders("https://example.com", SEVEN_PM - 60_000, push.send);
    expect(push.got.get(phone.endpoint)).toBeUndefined();
    await runReminders("https://example.com", SEVEN_PM + 60_000, push.send);
    await runReminders("https://example.com", SEVEN_PM + 10 * 60_000, push.send);
    expect(push.got.get(phone.endpoint)).toEqual([
      { title: "How did today go? Write your report.", tag: expect.any(String), url: "/" },
    ]);
    await runReminders("https://example.com", SEVEN_PM + 24 * HOUR + 60_000, push.send);
    expect(push.got.get(phone.endpoint)).toHaveLength(2);
  });

  it("tries a failed send again on the next run", async () => {
    const { phone } = await phoneWithReminder();
    let fail = true;
    const push = fakeSender(() => (fail ? "failed" : "sent"));
    await runReminders("https://example.com", SEVEN_PM + 60_000, push.send);
    fail = false;
    await runReminders("https://example.com", SEVEN_PM + 6 * 60_000, push.send);
    await runReminders("https://example.com", SEVEN_PM + 11 * 60_000, push.send);
    expect(push.got.get(phone.endpoint)).toHaveLength(2);
  });

  it("forgets a device its push service says is gone", async () => {
    const { user, phone } = await phoneWithReminder();
    const push = fakeSender(() => "gone");
    await runReminders("https://example.com", SEVEN_PM + 60_000, push.send);
    expect(await getPushDevice(user.id, phone.endpoint)).toBeNull();
    expect(await listReminders(user.id)).toHaveLength(1);
  });

  it("does not send to the same device twice when two runs overlap", async () => {
    const { user, phone } = await phoneWithReminder();
    const [reminder] = await listReminders(user.id);
    expect(await claimPushSend(phone.endpoint, reminder.id, "2026-03-02")).toBe(true);
    expect(await claimPushSend(phone.endpoint, reminder.id, "2026-03-02")).toBe(false);
  });
});
