import "server-only";
import webpush, { WebPushError } from "web-push";
import {
  allPushDevices,
  claimPushSend,
  dropPushDevice,
  releasePushSend,
  sweepPushSent,
  type PushDevice,
} from "@/server/repo";
import { dueReminders, REMINDER_WINDOW_MS, reminderText } from "@/domain/reminders";

// Push notifications: the keys the app signs them with, one send, and the reminder job.

/** The app's VAPID keys, or null when notifications are not set up. */
function pushKeys(): { publicKey: string; privateKey: string } | null {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  return publicKey && privateKey ? { publicKey, privateKey } : null;
}

export function pushAvailable(): boolean {
  return pushKeys() !== null;
}

/** What the service worker (public/sw.js) shows. */
export interface PushMessage {
  title: string;
  body?: string;
  /** A newer notification with the same tag replaces the older one. */
  tag?: string;
  /** Opened when the notification is tapped. */
  url?: string;
}

/** "gone": the device turned notifications off or removed the app, so it can be forgotten. */
export type PushResult = "sent" | "gone" | "failed";

/**
 * Sends one notification. `contact` is the app's address (VAPID_SUBJECT, or the site), which push
 * services use to reach whoever runs it.
 */
export async function sendPush(device: PushDevice, message: PushMessage, contact: string): Promise<PushResult> {
  const keys = pushKeys();
  if (!keys) return "failed";
  try {
    await webpush.sendNotification(
      { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
      JSON.stringify(message),
      {
        vapidDetails: { subject: process.env.VAPID_SUBJECT?.trim() || contact, ...keys },
        // A reminder that could not be delivered by the end of its window is no use later.
        TTL: REMINDER_WINDOW_MS / 1000,
        urgency: "high",
        timeout: 10_000,
      },
    );
    return "sent";
  } catch (error) {
    if (error instanceof WebPushError && (error.statusCode === 404 || error.statusCode === 410)) return "gone";
    console.error("Push failed", error instanceof WebPushError ? `${error.statusCode} ${error.body}` : error);
    return "failed";
  }
}

/**
 * Sends every reminder that is due, once per device and day. An outside scheduler runs it every
 * minute or few (see Notifications in README.md). A send that failed is tried again next run.
 */
export async function runReminders(
  contact: string,
  at = Date.now(),
  send: typeof sendPush = sendPush,
): Promise<Record<PushResult, number>> {
  const counts: Record<PushResult, number> = { sent: 0, gone: 0, failed: 0 };
  if (!pushAvailable()) return counts;
  const devices = await allPushDevices();
  await Promise.all(
    devices.map(async (device) => {
      try {
        for (const due of dueReminders(device.reminders, device.timeZone, at, device.addedAt)) {
          if (!(await claimPushSend(device.endpoint, due.reminderId, due.day, at))) continue;
          const reminder = device.reminders.find((r) => r.id === due.reminderId)!;
          const result = await send(device, { title: reminderText(reminder.text), tag: reminder.id, url: "/" }, contact);
          counts[result]++;
          if (result === "gone") {
            await dropPushDevice(device.endpoint);
            return;
          }
          if (result === "failed") await releasePushSend(device.endpoint, due.reminderId, due.day);
        }
      } catch (error) {
        counts.failed++;
        console.error("Reminders failed for a device", error);
      }
    }),
  );
  // After three days, no time zone can still be on that day or the next.
  await sweepPushSent(at - 3 * 24 * 60 * 60 * 1000);
  return counts;
}
