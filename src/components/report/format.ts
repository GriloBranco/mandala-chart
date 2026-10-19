import { addDays } from "@/domain/mandala";

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
