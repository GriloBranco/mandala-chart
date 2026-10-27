"use client";

import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { AsciiSpinner } from "@/components/ascii/AsciiSpinner";
import { Button, IconButton } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { api, ApiError } from "@/client/api";
import { deviceSubscription, pushBlocked, PushDenied, pushSupport, turnOffPush, turnOnPush } from "@/client/push";
import { toast } from "@/client/toast";
import { newUuid } from "@/client/uuid";
import { DEFAULT_REMINDER_TIME, DEFAULT_REMINDER_TEXT, REMINDER_TEXT_MAX, REMINDERS_MAX, type Reminder } from "@/domain/reminders";
import { errorText, FormError } from "./fields";

const NOTE = "text-[13.5px] leading-relaxed text-muted";
// Like fieldClass("box"), narrower inside, and with no width of its own: two share a line.
const FIELD =
  "h-12 rounded-xl border border-line-strong bg-bg px-3 text-[15px] text-fg outline-none! transition-colors placeholder:text-faint focus:border-fg";
const BLOCKED = "Notifications are blocked for Mandala. Allow them in Settings, then try again.";

/**
 * Below the Notifications row: turn them on for this device, then change the reminders. The
 * reminders belong to the account, so every device with notifications on gets them.
 */
export function NotificationsPanel({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const [reminders, setReminders] = useState<Reminder[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const support = pushSupport();

  if (support === "home-screen") {
    return (
      <p className={cn(NOTE, "px-3 pt-1 pb-4")}>
        On iPhone, notifications only work in the app on your Home Screen. In Safari, tap Share, then Add to Home
        Screen, and open Mandala from there.
      </p>
    );
  }
  if (support === "no") {
    return <p className={cn(NOTE, "px-3 pt-1 pb-4")}>This browser can&apos;t show notifications.</p>;
  }

  if (on) {
    return (
      <ReminderList
        reminders={reminders}
        onLoaded={setReminders}
        onOff={() => {
          setReminders(null);
          onChange(false);
        }}
      />
    );
  }

  const turnOn = async () => {
    setBusy(true);
    setError(null);
    try {
      setReminders(await turnOnPush());
      onChange(true);
      toast("Notifications are on");
    } catch (err) {
      if (err instanceof PushDenied) setError(err.message === "denied" ? BLOCKED : "Tap Allow to get reminders.");
      else setError(errorText(err, "Could not turn on notifications."));
    } finally {
      setBusy(false);
    }
  };

  const blocked = pushBlocked();
  return (
    <div className="px-3 pt-1 pb-4">
      <p className={NOTE}>
        {blocked
          ? BLOCKED
          : `Get a reminder on this device every day at ${timeLabel(DEFAULT_REMINDER_TIME)}. You can change the time and add more.`}
      </p>
      <FormError message={blocked ? null : error} />
      {!blocked && (
        <div className="mt-3 flex justify-end">
          <Button variant="primary" loading={busy} onClick={() => void turnOn()}>
            Turn on
          </Button>
        </div>
      )}
    </div>
  );
}

function ReminderList({
  reminders,
  onLoaded,
  onOff,
}: {
  reminders: Reminder[] | null;
  onLoaded: (reminders: Reminder[]) => void;
  onOff: () => void;
}) {
  // Null until they change something, so the list always shows what is saved otherwise.
  const [draft, setDraft] = useState<Reminder[] | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | "off" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loaded = reminders !== null;

  useEffect(() => {
    if (loaded) return;
    let live = true;
    api
      .get<{ reminders: Reminder[] }>("/api/notifications")
      .then((answer) => live && onLoaded(answer.reminders))
      .catch((err) => live && setError(errorText(err, "Could not load your reminders.")));
    return () => {
      live = false;
    };
  }, [loaded, onLoaded]);

  if (!reminders) {
    return (
      <div className="px-3 pt-1 pb-4">
        {error ? <FormError message={error} /> : <AsciiSpinner size="sm" label="Loading" />}
      </div>
    );
  }

  const list = draft ?? reminders;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(reminders);
  const edit = (id: string, patch: Partial<Reminder>) =>
    setDraft(list.map((reminder) => (reminder.id === id ? { ...reminder, ...patch } : reminder)));

  const save = async () => {
    if (list.some((reminder) => !reminder.time)) {
      setError("Pick a time for each reminder.");
      return;
    }
    setBusy("save");
    setError(null);
    try {
      const answer = await api.put<{ reminders: Reminder[] }>("/api/notifications", { reminders: list });
      onLoaded(answer.reminders);
      setDraft(null);
      toast("Reminders saved");
    } catch (err) {
      setError(errorText(err, "Could not save the reminders."));
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setError(null);
    try {
      const subscription = await deviceSubscription();
      if (!subscription) {
        onOff();
        return;
      }
      await api.post("/api/notifications/test", { endpoint: subscription.endpoint });
      toast("Test sent");
    } catch (err) {
      // The server no longer sends to this device: show the way to turn it on again.
      if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
        toast(err.message, { tone: "error" });
        onOff();
        return;
      }
      setError(errorText(err, "Could not send a test."));
    } finally {
      setBusy(null);
    }
  };

  const turnOff = async () => {
    setBusy("off");
    setError(null);
    await turnOffPush().catch(() => undefined);
    toast("Notifications are off on this device");
    onOff();
  };

  return (
    <div className="px-3 pt-1 pb-4">
      {list.length ? (
        <ul className="space-y-2">
          {list.map((reminder) => (
            <li key={reminder.id} className="flex items-center gap-2">
              <input
                type="time"
                aria-label="Time"
                value={reminder.time}
                onChange={(event) => edit(reminder.id, { time: event.target.value })}
                className={cn(FIELD, "w-[6.75rem] shrink-0")}
              />
              <input
                type="text"
                aria-label="Message"
                value={reminder.text}
                onChange={(event) => edit(reminder.id, { text: event.target.value })}
                maxLength={REMINDER_TEXT_MAX}
                enterKeyHint="done"
                placeholder={DEFAULT_REMINDER_TEXT}
                className={cn(FIELD, "min-w-0 flex-1")}
              />
              <IconButton
                label="Remove reminder"
                size="sm"
                onClick={() => setDraft(list.filter((other) => other.id !== reminder.id))}
                className="text-muted"
              >
                <X size={16} />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className={NOTE}>No reminders.</p>
      )}
      <p className="mt-2 text-[12.5px] leading-snug text-muted">
        Every day, on each device where notifications are on.
      </p>
      <FormError message={error} />
      <div className="mt-3 flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          icon={<Plus size={15} />}
          disabled={list.length >= REMINDERS_MAX || busy !== null}
          onClick={() => setDraft([...list, { id: newUuid(), time: DEFAULT_REMINDER_TIME, text: "" }])}
          className="-ml-3"
        >
          Add
        </Button>
        {dirty ? (
          <div className="flex gap-2">
            <Button variant="ghost" disabled={busy !== null} onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy === "save"} disabled={busy !== null} onClick={() => void save()}>
              Save
            </Button>
          </div>
        ) : (
          <div className="flex gap-2">
            <Button variant="ghost" loading={busy === "off"} disabled={busy !== null} onClick={() => void turnOff()}>
              Turn off
            </Button>
            <Button variant="secondary" loading={busy === "test"} disabled={busy !== null} onClick={() => void test()}>
              Send a test
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** "7:00 PM" in the person's own format. */
function timeLabel(time: string): string {
  const [hour, minute] = time.split(":").map(Number);
  return new Date(2000, 0, 1, hour, minute).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
