// Reminders sent as push notifications: what they say and when one is due on a device. Pure, so
// the server's job and the tests use the same rules.

import { addDays } from "./days";

export interface Reminder {
  id: string;
  /** HH:MM, 24-hour, on the device's own clock. */
  time: string;
  /** Empty for the default line. */
  text: string;
}

/** What the first reminder is when notifications are turned on. */
export const DEFAULT_REMINDER_TIME = "19:00";
export const DEFAULT_REMINDER_TEXT = "How did today go? Write your report.";
export const REMINDER_TEXT_MAX = 120;
export const REMINDERS_MAX = 10;

/** A reminder still goes out this long after its time, when the job that sends it runs late. */
export const REMINDER_WINDOW_MS = 2 * 60 * 60 * 1000;

export function reminderText(text: string): string {
  return text.trim() || DEFAULT_REMINDER_TEXT;
}

/** True for a time zone this runtime knows ("America/Sao_Paulo", "UTC"). */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Push services the server may send to. Anything else could point the server at any address.
 * Chrome uses fcm.googleapis.com, plain Chromium builds a *.google.com host.
 */
const PUSH_HOSTS = ["googleapis.com", "google.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"];

export function isPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return url.protocol === "https:" && PUSH_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));
}

// ---------- time zones ----------

/** The wall clock in a time zone at an instant. */
function wallClock(at: number, zone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    second: part("second"),
  };
}

/** The calendar day (YYYY-MM-DD) in a time zone at an instant. */
export function zonedDay(at: number, zone: string): string {
  const { year, month, day } = wallClock(at, zone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** How far the time zone's clock is ahead of UTC at an instant, in ms. */
function offsetAt(at: number, zone: string): number {
  const c = wallClock(at, zone);
  return Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second) - Math.floor(at / 1000) * 1000;
}

/** The instant a day's HH:MM happens in a time zone. A time skipped by a clock change lands next to it. */
export function zonedInstant(day: string, time: string, zone: string): number {
  const [year, month, date] = day.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const wall = Date.UTC(year, month - 1, date, hour, minute);
  // The offset at the first guess can be wrong across a clock change; the second guess fixes it.
  const guess = wall - offsetAt(wall, zone);
  return wall - offsetAt(guess, zone);
}

// ---------- when one is due ----------

export interface DueReminder {
  reminderId: string;
  /** The device's local day the reminder is for: it goes out once for each. */
  day: string;
}

/**
 * The reminders a device should get now: their time came in the last REMINDER_WINDOW_MS, and
 * after `since` (when the time was set or the device joined), so turning one on at 8 PM for 7 PM
 * waits for tomorrow instead of firing at once.
 */
export function dueReminders(
  reminders: (Reminder & { timeSetAt: number })[],
  zone: string,
  now: number,
  deviceAddedAt: number,
): DueReminder[] {
  const today = zonedDay(now, zone);
  const due: DueReminder[] = [];
  for (const reminder of reminders) {
    const since = Math.max(reminder.timeSetAt, deviceAddedAt);
    // Yesterday too: 11:30 PM can still be due a little after midnight.
    for (const day of [today, addDays(today, -1)]) {
      const at = zonedInstant(day, reminder.time, zone);
      if (at <= now && now - at < REMINDER_WINDOW_MS && at > since) {
        due.push({ reminderId: reminder.id, day });
        break;
      }
    }
  }
  return due;
}
