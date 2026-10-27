import { describe, expect, it } from "vitest";
import {
  dueReminders,
  isPushEndpoint,
  isTimeZone,
  REMINDER_WINDOW_MS,
  reminderText,
  zonedDay,
  zonedInstant,
} from "@/domain/reminders";

const iso = (at: number) => new Date(at).toISOString();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

describe("time zones", () => {
  it("finds the instant of a local time", () => {
    expect(iso(zonedInstant("2026-03-02", "19:00", "America/Sao_Paulo"))).toBe("2026-03-02T22:00:00.000Z");
    expect(iso(zonedInstant("2026-03-02", "07:30", "Asia/Kolkata"))).toBe("2026-03-02T02:00:00.000Z");
    expect(iso(zonedInstant("2026-03-02", "19:00", "UTC"))).toBe("2026-03-02T19:00:00.000Z");
  });

  it("follows daylight saving time", () => {
    // New York moves its clocks forward on March 8, 2026, and back on November 1.
    expect(iso(zonedInstant("2026-03-07", "19:00", "America/New_York"))).toBe("2026-03-08T00:00:00.000Z");
    expect(iso(zonedInstant("2026-03-08", "19:00", "America/New_York"))).toBe("2026-03-08T23:00:00.000Z");
    expect(iso(zonedInstant("2026-11-01", "19:00", "America/New_York"))).toBe("2026-11-02T00:00:00.000Z");
  });

  it("puts a time skipped by the clock change next to it", () => {
    const at = zonedInstant("2026-03-08", "02:30", "America/New_York");
    expect(at).toBeGreaterThanOrEqual(Date.parse("2026-03-08T06:00:00Z"));
    expect(at).toBeLessThanOrEqual(Date.parse("2026-03-08T08:00:00Z"));
  });

  it("reads the local day", () => {
    const at = Date.parse("2026-03-02T01:00:00Z");
    expect(zonedDay(at, "UTC")).toBe("2026-03-02");
    expect(zonedDay(at, "America/Sao_Paulo")).toBe("2026-03-01");
    expect(zonedDay(at, "Asia/Tokyo")).toBe("2026-03-02");
  });

  it("knows real time zones only", () => {
    expect(isTimeZone("America/Sao_Paulo")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
  });
});

describe("when a reminder is due", () => {
  const zone = "America/Sao_Paulo";
  const seven = Date.parse("2026-03-02T22:00:00Z"); // 7 PM there
  const reminder = { id: "r1", time: "19:00", text: "", timeSetAt: 0 };

  it("is due from its time until the window ends", () => {
    expect(dueReminders([reminder], zone, seven - MIN, 0)).toEqual([]);
    expect(dueReminders([reminder], zone, seven, 0)).toEqual([{ reminderId: "r1", day: "2026-03-02" }]);
    expect(dueReminders([reminder], zone, seven + 20 * MIN, 0)).toEqual([{ reminderId: "r1", day: "2026-03-02" }]);
    expect(dueReminders([reminder], zone, seven + REMINDER_WINDOW_MS, 0)).toEqual([]);
  });

  it("waits for tomorrow when its time was set after it passed", () => {
    expect(dueReminders([{ ...reminder, timeSetAt: seven + MIN }], zone, seven + 5 * MIN, 0)).toEqual([]);
    expect(dueReminders([reminder], zone, seven + 5 * MIN, seven + MIN)).toEqual([]);
    const tomorrow = seven + 24 * HOUR;
    expect(dueReminders([{ ...reminder, timeSetAt: seven + MIN }], zone, tomorrow, seven + MIN)).toEqual([
      { reminderId: "r1", day: "2026-03-03" },
    ]);
  });

  it("is still due a little after midnight for the day before", () => {
    const late = { id: "r2", time: "23:30", text: "", timeSetAt: 0 };
    const afterMidnight = Date.parse("2026-03-03T03:10:00Z"); // 00:10 on March 3 there
    expect(dueReminders([late], zone, afterMidnight, 0)).toEqual([{ reminderId: "r2", day: "2026-03-02" }]);
  });

  it("goes by the device's own clock", () => {
    // 7 PM in Sao Paulo is 10 PM in London: past London's 7 PM window.
    expect(dueReminders([reminder], "Europe/London", seven, 0)).toEqual([]);
    expect(dueReminders([reminder], "Europe/London", Date.parse("2026-03-02T19:05:00Z"), 0)).toEqual([
      { reminderId: "r1", day: "2026-03-02" },
    ]);
  });
});

describe("reminder text and devices", () => {
  it("uses the default line when the text is empty", () => {
    expect(reminderText("  ")).toMatch(/report/);
    expect(reminderText(" Stretch ")).toBe("Stretch");
  });

  it("sends only to known push services over https", () => {
    expect(isPushEndpoint("https://web.push.apple.com/QGa3")).toBe(true);
    expect(isPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isPushEndpoint("https://jmt17.google.com/fcm/send/abc")).toBe(true);
    expect(isPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/abc")).toBe(true);
    expect(isPushEndpoint("https://wns2-par02p.notify.windows.com/w/?token=abc")).toBe(true);
    expect(isPushEndpoint("http://web.push.apple.com/QGa3")).toBe(false);
    expect(isPushEndpoint("https://evilpush.apple.com.example.com/x")).toBe(false);
    expect(isPushEndpoint("https://169.254.169.254/latest")).toBe(false);
    expect(isPushEndpoint("not a url")).toBe(false);
  });
});
