// How often a habit (a "routine" on Today) comes back: every day, once a week on a weekday,
// or once a month on a date. Each repeat splits time into periods; one check-in per period is enough.

import { addDays, dayDate, dayKey } from "./days";
import { guessKind, guessRepeat } from "./kind";
import type { Cell, CellPatch, Checkin, Repeat } from "./types";

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface Schedule {
  repeat: Repeat;
  /** Weekday 0-6 (Sunday first) for "week", day of the month 1-31 for "month", 0 for "day". */
  on: number;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/** The cell's schedule, with a sane day when none was picked (a copy saved before repeats existed has none). */
export function repeatOf(cell: Pick<Cell, "repeat" | "repeatOn">): Schedule {
  if (cell.repeat === "week") {
    const on = cell.repeatOn;
    return { repeat: "week", on: on !== null && on !== undefined && on >= 0 && on <= 6 ? on : 0 };
  }
  if (cell.repeat === "month") {
    const on = cell.repeatOn;
    return { repeat: "month", on: on !== null && on !== undefined && on >= 1 && on <= 31 ? on : 1 };
  }
  return { repeat: "day", on: 0 };
}

/** The day a new weekly or monthly routine starts on when nothing says otherwise: today's. */
export function defaultRepeatOn(repeat: Repeat, today: string): number | null {
  if (repeat === "week") return dayDate(today).getDay();
  if (repeat === "month") return dayDate(today).getDate();
  return null;
}

/** The due day in a given month: the 31st falls back to the month's last day. */
function dueInMonth(year: number, month: number, on: number): string {
  return dayKey(new Date(year, month, Math.min(on, lastDayOfMonth(year, month))));
}

/** First day of the period holding `day`: the latest due day on or before it. */
export function periodStart(schedule: Schedule, day: string): string {
  if (schedule.repeat === "day") return day;
  const date = dayDate(day);
  if (schedule.repeat === "week") return addDays(day, -((date.getDay() - schedule.on + 7) % 7));
  const due = dueInMonth(date.getFullYear(), date.getMonth(), schedule.on);
  return due <= day ? due : dueInMonth(date.getFullYear(), date.getMonth() - 1, schedule.on);
}

/** First day of the period after the one starting on `start`. */
export function nextPeriodStart(schedule: Schedule, start: string): string {
  if (schedule.repeat === "day") return addDays(start, 1);
  if (schedule.repeat === "week") return addDays(start, 7);
  const date = dayDate(start);
  return dueInMonth(date.getFullYear(), date.getMonth() + 1, schedule.on);
}

function doneDays(cellId: string, checkins: Checkin[]): string[] {
  return checkins.filter((c) => c.cellId === cellId).map((c) => c.day);
}

/** Check-ins of this routine within the period that holds `day`. */
export function checkinsInPeriod(cell: Cell, checkins: Checkin[], day: string): string[] {
  const schedule = repeatOf(cell);
  const start = periodStart(schedule, day);
  const end = nextPeriodStart(schedule, start);
  return doneDays(cell.id, checkins).filter((d) => d >= start && d < end);
}

export interface RoutineToday {
  /** Shows on Today: due (or late) and not done yet this period, or checked today. */
  show: boolean;
  /** The day it was due, when that was before today: shown as "late". */
  lateSince: string | null;
  /** When it comes back, while it is hidden. */
  next: string | null;
}

/**
 * Where a routine stands today. A weekly or monthly one shows from its due day until it is
 * checked, stays (checked) for the rest of that day, then waits for the next due day.
 */
export function routineToday(cell: Cell, checkins: Checkin[], today: string): RoutineToday {
  const schedule = repeatOf(cell);
  if (schedule.repeat === "day") return { show: true, lateSince: null, next: null };
  const start = periodStart(schedule, today);
  const next = nextPeriodStart(schedule, start);
  // Picked after this period's due day: the first one is the next due day.
  const picked = cell.activatedAt ? dayKey(new Date(cell.activatedAt)) : null;
  if (picked && picked > start) return { show: false, lateSince: null, next };
  const days = doneDays(cell.id, checkins).filter((d) => d >= start && d < next);
  if (days.some((d) => d < today)) return { show: false, lateSince: null, next };
  return { show: true, lateSince: start < today && !days.includes(today) ? start : null, next: null };
}

/**
 * Strength of a weekly or monthly routine, 0-1: recent periods done pull it up, a missed one
 * lets it decay. The current period only counts once it is done, so it never drops early.
 */
export function periodStrength(cell: Cell, checkins: Checkin[], today: string): number {
  const schedule = repeatOf(cell);
  const done = doneDays(cell.id, checkins);
  const starts = recentPeriods(cell, today, schedule.repeat === "month" ? 6 : 8);
  let strength = 0;
  starts.forEach((start, i) => {
    const end = nextPeriodStart(schedule, start);
    const hit = done.some((d) => d >= start && d < end);
    if (i === starts.length - 1 && !hit) return;
    strength = strength * 0.6 + (hit ? 0.4 : 0);
  });
  return Math.min(1, strength / (1 - Math.pow(0.6, 4)));
}

/** The last `count` period starts, oldest first, ending with the current one. */
export function recentPeriods(cell: Cell, today: string, count: number): string[] {
  const schedule = repeatOf(cell);
  const starts = [periodStart(schedule, today)];
  for (let i = 1; i < count; i++) starts.unshift(periodStart(schedule, addDays(starts[0], -1)));
  return starts;
}

function ordinal(n: number): string {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th"}`;
}

/** "Daily", "Every Sunday", "Monthly on the 5th". */
export function repeatLabel(cell: Pick<Cell, "repeat" | "repeatOn">): string {
  const schedule = repeatOf(cell);
  if (schedule.repeat === "week") return `Every ${WEEKDAY_NAMES[schedule.on]}`;
  if (schedule.repeat === "month") return `Monthly on the ${ordinal(schedule.on)}`;
  return "Daily";
}

/** "Sun", "Mon 3" style short date for a coming or late due day. */
export function shortDay(day: string, today: string): string {
  if (day === today) return "today";
  if (day === addDays(today, 1)) return "tomorrow";
  if (day === addDays(today, -1)) return "yesterday";
  const date = dayDate(day);
  const within = Math.abs(date.getTime() - dayDate(today).getTime()) < 6.5 * 86_400_000;
  return within
    ? date.toLocaleDateString("en-US", { weekday: "short" })
    : date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** "this week", "this month", "today": the period a check-in counts for. */
export function periodWord(cell: Pick<Cell, "repeat" | "repeatOn">): string {
  const { repeat } = repeatOf(cell);
  return repeat === "week" ? "this week" : repeat === "month" ? "this month" : "today";
}

// ---------- one choice for kind and repeat ----------

/** What the editors offer in one row: a task, or a habit with its repeat. */
export type HowOften = "task" | Repeat;

export const HOW_OFTEN_LABELS: Record<HowOften, string> = {
  task: "Task",
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
};

export function howOften(cell: Pick<Cell, "kind" | "repeat" | "repeatOn">): HowOften {
  return cell.kind === "task" ? "task" : repeatOf(cell).repeat;
}

/** The change for picking a choice. A new weekly or monthly repeat starts on today's day. */
export function howOftenPatch(cell: Cell, choice: HowOften, today: string, on?: number | null): CellPatch {
  if (choice === "task") return cell.kind === "task" ? {} : { kind: "task" };
  const patch: CellPatch = {};
  if (cell.kind !== "habit") patch.kind = "habit";
  const sameRepeat = repeatOf(cell).repeat === choice && cell.repeat === choice;
  if (!sameRepeat) {
    patch.repeat = choice;
    patch.repeatOn = on ?? defaultRepeatOn(choice, today);
  } else if (on !== undefined && on !== null && on !== cell.repeatOn) {
    patch.repeatOn = on;
  }
  return patch;
}

/** What the wording suggests: "every week" makes a weekly habit, "every Sunday" one on Sundays. */
export function guessHowOften(text: string): { choice: HowOften; on: number | null } {
  if (guessKind(text) === "task") return { choice: "task", on: null };
  const { repeat, repeatOn } = guessRepeat(text);
  return { choice: repeat, on: repeatOn };
}
