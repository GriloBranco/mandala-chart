import "server-only";
import type { InStatement, Row } from "@libsql/client";
import { getDb } from "@/server/db";
import { DEFAULT_REMINDER_TIME, type Reminder } from "@/domain/reminders";
import { newId, now, placeholders } from "./shared";

// Reminders and the devices they go to. Every function takes the user's id first, except the
// few the reminder job needs across accounts, which say so.

const USER_EXISTS = "EXISTS (SELECT 1 FROM users WHERE id = ?)";

function toReminder(row: Row): Reminder {
  return { id: String(row.id), time: String(row.time), text: String(row.text) };
}

/** The account's reminders, earliest in the day first. */
export async function listReminders(userId: string): Promise<Reminder[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: "SELECT id, time, text FROM reminders WHERE user_id = ? ORDER BY time, created_at",
    args: [userId],
  });
  return result.rows.map(toReminder);
}

/** Replaces the account's reminders with this list. An id that belongs to another account is skipped. */
export async function saveReminders(userId: string, reminders: Reminder[], at = Date.now()): Promise<Reminder[]> {
  const db = await getDb();
  const ids = reminders.map((reminder) => reminder.id);
  const statements: InStatement[] = [
    ids.length
      ? {
          sql: `DELETE FROM reminders WHERE user_id = ? AND id NOT IN (${placeholders(ids.length)})`,
          args: [userId, ...ids],
        }
      : { sql: "DELETE FROM reminders WHERE user_id = ?", args: [userId] },
    ...reminders.map((reminder) => ({
      // A new time counts from now; the same time keeps its old start, so it is not skipped today.
      sql: `INSERT INTO reminders (id, user_id, time, text, time_set_at, created_at)
        SELECT ?, ?, ?, ?, ?, ? WHERE ${USER_EXISTS}
        ON CONFLICT (id) DO UPDATE SET
          text = excluded.text,
          time_set_at = CASE WHEN reminders.time = excluded.time THEN reminders.time_set_at ELSE excluded.time_set_at END,
          time = excluded.time
        WHERE reminders.user_id = excluded.user_id`,
      args: [reminder.id, userId, reminder.time, reminder.text, at, now(), userId],
    })),
  ];
  await db.batch(statements, "write");
  return listReminders(userId);
}

export interface PushDevice {
  endpoint: string;
  p256dh: string;
  auth: string;
  timeZone: string;
}

/**
 * Turns notifications on for a device, or brings its time zone up to date. A device that was
 * signed in to another account moves to this one. The first device of an account with no
 * reminders gets the daily one.
 */
export async function savePushDevice(userId: string, device: PushDevice, at = Date.now()): Promise<Reminder[]> {
  const db = await getDb();
  await db.batch(
    [
      {
        sql: `INSERT INTO reminders (id, user_id, time, text, time_set_at, created_at)
          SELECT ?, ?, ?, '', ?, ? WHERE ${USER_EXISTS}
            AND NOT EXISTS (SELECT 1 FROM reminders WHERE user_id = ?)
            AND NOT EXISTS (SELECT 1 FROM push_devices WHERE user_id = ?)`,
        args: [newId(), userId, DEFAULT_REMINDER_TIME, at, now(), userId, userId, userId],
      },
      {
        sql: `INSERT INTO push_devices (endpoint, user_id, p256dh, auth, time_zone, added_at, seen_at)
          SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${USER_EXISTS}
          ON CONFLICT (endpoint) DO UPDATE SET
            added_at = CASE WHEN push_devices.user_id = excluded.user_id THEN push_devices.added_at ELSE excluded.added_at END,
            user_id = excluded.user_id,
            p256dh = excluded.p256dh,
            auth = excluded.auth,
            time_zone = excluded.time_zone,
            seen_at = excluded.seen_at`,
        args: [device.endpoint, userId, device.p256dh, device.auth, device.timeZone, at, at, userId],
      },
    ],
    "write",
  );
  return listReminders(userId);
}

export async function getPushDevice(userId: string, endpoint: string): Promise<PushDevice | null> {
  const db = await getDb();
  const result = await db.execute({
    sql: "SELECT * FROM push_devices WHERE endpoint = ? AND user_id = ?",
    args: [endpoint, userId],
  });
  return result.rows.length ? toDevice(result.rows[0]) : null;
}

function toDevice(row: Row): PushDevice {
  return {
    endpoint: String(row.endpoint),
    p256dh: String(row.p256dh),
    auth: String(row.auth),
    timeZone: String(row.time_zone),
  };
}

/** Turns notifications off for one device. */
export async function deletePushDevice(userId: string, endpoint: string): Promise<void> {
  const db = await getDb();
  await db.batch(
    [
      {
        sql: "DELETE FROM push_sent WHERE endpoint IN (SELECT endpoint FROM push_devices WHERE endpoint = ? AND user_id = ?)",
        args: [endpoint, userId],
      },
      { sql: "DELETE FROM push_devices WHERE endpoint = ? AND user_id = ?", args: [endpoint, userId] },
    ],
    "write",
  );
}

/** Turns notifications off on every device of the account (sign out everywhere). The reminders stay. */
export async function deletePushDevices(userId: string): Promise<void> {
  const db = await getDb();
  await db.batch(
    [
      {
        sql: "DELETE FROM push_sent WHERE endpoint IN (SELECT endpoint FROM push_devices WHERE user_id = ?)",
        args: [userId],
      },
      { sql: "DELETE FROM push_devices WHERE user_id = ?", args: [userId] },
    ],
    "write",
  );
}

// ---------- the reminder job (across accounts) ----------

export interface DeviceReminders extends PushDevice {
  addedAt: number;
  reminders: (Reminder & { timeSetAt: number })[];
}

/** Every device with the reminders of its account. Not user-scoped by design: the job serves everyone. */
export async function allPushDevices(): Promise<DeviceReminders[]> {
  const db = await getDb();
  const [devices, reminders] = await db.batch(
    [
      "SELECT * FROM push_devices",
      "SELECT * FROM reminders WHERE user_id IN (SELECT user_id FROM push_devices)",
    ],
    "read",
  );
  const byUser = new Map<string, DeviceReminders["reminders"]>();
  for (const row of reminders.rows) {
    const list = byUser.get(String(row.user_id)) ?? [];
    list.push({ ...toReminder(row), timeSetAt: Number(row.time_set_at) });
    byUser.set(String(row.user_id), list);
  }
  return devices.rows.map((row) => ({
    ...toDevice(row),
    addedAt: Number(row.added_at),
    reminders: byUser.get(String(row.user_id)) ?? [],
  }));
}

/** Marks a reminder as sent to a device for a day. False when it already was (by this run or another). */
export async function claimPushSend(endpoint: string, reminderId: string, day: string, at = Date.now()): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({
    sql: `INSERT INTO push_sent (endpoint, reminder_id, day, sent_at)
      SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM push_devices WHERE endpoint = ?)
      ON CONFLICT DO NOTHING`,
    args: [endpoint, reminderId, day, at, endpoint],
  });
  return result.rowsAffected === 1;
}

/** Lets the next run try a send that failed. */
export async function releasePushSend(endpoint: string, reminderId: string, day: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: "DELETE FROM push_sent WHERE endpoint = ? AND reminder_id = ? AND day = ?",
    args: [endpoint, reminderId, day],
  });
}

/** Forgets a device its push service says is gone. Not user-scoped: the endpoint is the key. */
export async function dropPushDevice(endpoint: string): Promise<void> {
  const db = await getDb();
  await db.batch(
    [
      { sql: "DELETE FROM push_sent WHERE endpoint = ?", args: [endpoint] },
      { sql: "DELETE FROM push_devices WHERE endpoint = ?", args: [endpoint] },
    ],
    "write",
  );
}

/** Forgets sends older than `before` (ms epoch): by then their day is long over everywhere. */
export async function sweepPushSent(before: number): Promise<void> {
  const db = await getDb();
  await db.execute({ sql: "DELETE FROM push_sent WHERE sent_at < ?", args: [before] });
}
