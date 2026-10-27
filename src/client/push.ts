// Push notifications on this device: whether the browser can show them, and turning them on and
// off. The reminders themselves belong to the account and are kept on the server.

import type { Reminder } from "@/domain/reminders";
import { api } from "./api";
import { readJson, removeItem, writeJson } from "./device-storage";

/** The app's public VAPID key. Empty when the server has no keys, so notifications are not offered. */
const PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

/** What this device last told the server. No account in the key: sign-out clears it. */
const SEEN_KEY = "mandala:push:v1";

export function pushOffered(): boolean {
  return PUBLIC_KEY !== "";
}

/**
 * "ok": this browser can show notifications. "home-screen": an iPhone or iPad outside the app on
 * the Home Screen, where Safari offers none. "no": a browser without them.
 */
export type PushSupport = "ok" | "home-screen" | "no";

export function pushSupport(): PushSupport {
  if ("serviceWorker" in navigator && "PushManager" in window && "Notification" in window) return "ok";
  // iPads ask for the desktop site, so they say Macintosh; a Mac has no touch screen.
  const apple = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  return apple ? "home-screen" : "no";
}

/** True when notifications are blocked for the app in the browser's or phone's settings. */
export function pushBlocked(): boolean {
  return pushSupport() === "ok" && Notification.permission === "denied";
}

/** Thrown by turnOnPush when the person said no. */
export class PushDenied extends Error {}

/** This device's push subscription, when notifications are on here. */
export async function deviceSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== "ok" || Notification.permission !== "granted") return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/**
 * Asks for permission and turns notifications on for this device. Call it straight from a tap:
 * iPhone only asks then. Returns the account's reminders.
 */
export async function turnOnPush(): Promise<Reminder[]> {
  // Before anything else is awaited, so the browser still counts it as part of the tap.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new PushDenied(permission);
  await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
  const { pushManager } = await navigator.serviceWorker.ready;
  const key = keyBytes(PUBLIC_KEY);
  let subscription = await pushManager.getSubscription();
  // Made with an older key: the server could no longer send to it.
  if (subscription && !sameBytes(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  return sendDevice(subscription);
}

/** Turns notifications off for this device. */
export async function turnOffPush(): Promise<void> {
  removeItem(SEEN_KEY);
  const subscription = await deviceSubscription();
  if (!subscription) return;
  // Offline, the server still forgets it later: its push service answers that it is gone.
  await api.delete("/api/notifications/device", { endpoint: subscription.endpoint }).catch(() => undefined);
  await subscription.unsubscribe();
}

/**
 * Tells the server about this device again, so its reminders follow its time zone when it
 * travels, and come back after a sign-out everywhere. On opening the app it always does; when the
 * app comes back to the front, only if the time zone changed. Quiet: it tries again next time.
 */
export async function refreshPush(opening: boolean): Promise<void> {
  try {
    const subscription = await deviceSubscription();
    if (!subscription) return;
    const seen = readJson<{ endpoint: string; timeZone: string }>(SEEN_KEY);
    if (!opening && seen?.endpoint === subscription.endpoint && seen.timeZone === timeZone()) return;
    await sendDevice(subscription);
  } catch {
    // Offline or signed out: next time.
  }
}

async function sendDevice(subscription: PushSubscription): Promise<Reminder[]> {
  const { endpoint, keys } = subscription.toJSON();
  const zone = timeZone();
  const answer = await api.post<{ reminders: Reminder[] }>("/api/notifications/device", {
    endpoint,
    keys,
    timeZone: zone,
  });
  writeJson(SEEN_KEY, { endpoint, timeZone: zone });
  return answer.reminders;
}

function timeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The VAPID key as bytes, from base64url. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function sameBytes(buffer: ArrayBuffer | null, bytes: Uint8Array): boolean {
  if (!buffer || buffer.byteLength !== bytes.length) return false;
  const other = new Uint8Array(buffer);
  return bytes.every((byte, index) => byte === other[index]);
}
