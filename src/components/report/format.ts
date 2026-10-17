import { addDays } from "@/lib/mandala";
import type { ProgressEvent } from "@/lib/types";

// Dates in English to match the copy; times follow the device's 12 or 24 hour setting.

function parseDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / 86_400_000);
}

/** "Friday, October 16" */
export function longDate(day: string): string {
  return parseDay(day).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

/** "Oct 15" */
export function shortDate(day: string): string {
  return parseDay(day).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** "Today", "Yesterday", "Mon, Oct 12" (with the year when it is not this year). */
export function dayLabel(day: string, today: string): string {
  if (day === today) return "Today";
  if (day === addDays(today, -1)) return "Yesterday";
  return parseDay(day).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(day.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
  });
}

/** "today", "yesterday", "3 days ago", "Oct 2" */
export function sinceLabel(day: string, today: string): string {
  if (day === today) return "today";
  if (day === addDays(today, -1)) return "yesterday";
  const days = daysBetween(day, today);
  if (days > 1 && days < 7) return `${days} days ago`;
  return shortDate(day);
}

/** "8:12 PM" */
export function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Goals are written "By June 30, 2027, I will run a half marathon". In tight spots the
 * date lead-in is noise, so this keeps "Run a half marathon".
 */
export function shortGoalTitle(title: string): string {
  const full = title.trim();
  const rest = full.replace(/^by\s+.{2,40}?,?\s+i\s+(?:will|want to|am going to)\s+/i, "");
  if (!full) return "Untitled goal";
  if (!rest || rest === full) return full;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

// ---------- chart changes stored with a report ----------

const STATUS_GLYPHS: Record<string, string> = {
  Done: "●",
  "In progress": "◐",
  "To do": "○",
  "started this week": "◉",
  paused: "○",
};

export interface EventLine {
  glyph: string;
  /** The square's text when the change was made. */
  name: string;
  change: string;
}

/**
 * Splits a stored event ("Run 3x a week: Done") into a glyph, the square and what changed.
 * The square's text can hold ": " too. Status, check-in and progress endings never do, so they
 * split at the last one; a note splits after the square's current text while it still matches.
 */
export function eventLine(event: ProgressEvent, reportDay: string, cellText?: string): EventLine {
  const { detail } = event;
  let at: number;
  if (event.type !== "note") at = detail.lastIndexOf(": ");
  else if (cellText && detail.startsWith(`${cellText}: `)) at = cellText.length;
  else at = detail.indexOf(": ");
  const name = at > 0 ? detail.slice(0, at) : detail;
  const raw = at > 0 ? detail.slice(at + 2) : "";
  switch (event.type) {
    case "checkin": {
      const day = /(\d{4}-\d{2}-\d{2})$/.exec(raw)?.[1];
      return { glyph: "■", name, change: !day || day === reportDay ? "Done" : `Done ${shortDate(day)}` };
    }
    case "status":
      return { glyph: STATUS_GLYPHS[raw] ?? "○", name, change: raw.charAt(0).toUpperCase() + raw.slice(1) };
    case "progress":
      return { glyph: "◐", name, change: raw };
    case "note":
      return { glyph: "✎", name, change: raw };
    default:
      return { glyph: "·", name, change: raw };
  }
}
