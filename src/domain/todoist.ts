// How a square looks in Todoist, and how Todoist's side reads back into the chart. Pure, so the
// sync engine on the server and the tests use the same rules.

import { addDays, dayDate } from "./days";
import { actionLever, isFilled, PILLAR_SLOT } from "./mandala";
import { checkinsInPeriod, nextPeriodStart, periodStart, repeatOf, WEEKDAY_NAMES } from "./repeat";
import type { Cell, Checkin, GoalWithCells, Repeat } from "./types";
import { ACTION_SCALE, pillarName } from "./week";

// ---------- a square in Todoist ----------

/** What one square looks like in Todoist. */
export interface TodoistShape {
  content: string;
  description: string;
  /** Todoist API priority: 1 normal, 2 = p3, 3 = p2. Never 4 (p1 stays the person's). */
  priority: 1 | 2 | 3;
  /** Repeat string for a routine ("every day", "every sunday", "every 5th", "every last day"); null for a task. */
  repeat: string | null;
  /** A task that is done, or a routine marked done for good. */
  completed: boolean;
}

/** Null when the square does not belong in Todoist: only picked, named actions of active goals go there. */
export function todoistShape(goal: GoalWithCells, cell: Cell, appUrl: string): TodoistShape | null {
  if (goal.status !== "active" || cell.slot === PILLAR_SLOT || !isFilled(cell) || !cell.active) return null;
  const link = squareLink(appUrl, goal.id, cell.pillar, cell.id);
  return {
    content: cell.text.trim(),
    description: describe(cell.notes, { pillar: pillarName(goal, cell.pillar), goal: goal.title.trim(), link }),
    priority: taskPriority(cell),
    repeat: cell.kind === "habit" ? repeatString(cell) : null,
    completed: cell.status === "done",
  };
}

function ordinal(n: number): string {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th"}`;
}

/** Todoist's words for a routine's repeat. Always English: we send them with lang "en". */
export function repeatString(cell: Pick<Cell, "repeat" | "repeatOn">): string {
  const schedule = repeatOf(cell);
  if (schedule.repeat === "week") return `every ${WEEKDAY_NAMES[schedule.on].toLowerCase()}`;
  if (schedule.repeat === "month") {
    // Mandaala moves the 31st to a short month's last day, like "every last day".
    // To verify on a real account: "every 29th" and "every 30th" in short months, and that "every last day" parses.
    return schedule.on >= 31 ? "every last day" : `every ${ordinal(schedule.on)}`;
  }
  return "every day";
}

/** Todoist priority from leverage: p2 for the top third of the scale, p3 for the middle third. */
export function taskPriority(cell: Cell): 1 | 2 | 3 {
  const lever = actionLever(cell);
  if (lever === null) return 1;
  if (lever >= (ACTION_SCALE * 2) / 3) return 3;
  if (lever >= ACTION_SCALE / 3) return 2;
  return 1;
}

// ---------- text, notes and the footer ----------

/** Mandaala's limit for a square's text. */
export const TEXT_MAX = 200;
/** Todoist takes a little more than this in a description. */
const DESCRIPTION_MAX = 16000;
/** Between the notes and the footer line. */
const SEPARATOR = "\n\n---\n";

function oneLine(text: string): string {
  return text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ").trim();
}

/** The first `max` characters, without cutting an emoji in half. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = Math.max(0, max);
  const last = text.charCodeAt(end - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}

/** Todoist text as a Mandaala square holds it: one line, trimmed, at most TEXT_MAX characters. */
export function cleanText(content: string): string {
  return cut(oneLine(content), TEXT_MAX).trim();
}

/** Link that opens the square's pillar in the app. `c` lets a lost create be found again. */
export function squareLink(appUrl: string, goalId: string, pillar: number, cellId: string): string {
  return `${appUrl}/?g=${encodeURIComponent(goalId)}&p=${pillar}&c=${encodeURIComponent(cellId)}`;
}

/** Notes, then the footer line. */
export function describe(notes: string, context: { pillar: string; goal: string; link: string }): string {
  // One line, so notesFrom() can tell where it starts.
  const footer = oneLine(`${context.pillar} · ${context.goal} · [Open in Mandaala](${context.link})`);
  // Long notes are shortened, never the footer: its link leads back to the square.
  const text = cut(notes.trim(), DESCRIPTION_MAX - footer.length - SEPARATOR.length).trimEnd();
  return text ? `${text}${SEPARATOR}${footer}` : footer;
}

/** Where our footer's link starts. The last one is ours: notes may quote links to other squares. */
function footerMark(appUrl: string): string {
  return `](${appUrl}/?g=`;
}

/**
 * The notes part of a Todoist description: drops our footer line and the "---" line before it. Text the
 * person typed after the footer's link, on its line or below it, is kept after the notes above it.
 */
export function notesFrom(description: string, appUrl: string): string {
  const mark = footerMark(appUrl);
  const at = description.lastIndexOf(mark);
  if (at < 0) return description.trim();
  const above = description.slice(0, description.lastIndexOf("\n", at) + 1).trimEnd();
  // Also "***" or "___", in case Todoist's editor writes the rule another way.
  const notes = above.replace(/(^|\n)[ \t]*(-{3,}|\*{3,}|_{3,})$/, "").trim();
  // The end of a description is where people add a line, so what follows the link's ")" is notes too.
  const after = description.slice(at + mark.length).replace(/^[^)\s]*\)?/, "").trim();
  return [notes, after].filter(Boolean).join("\n\n");
}

/** The square id in our footer link, or null. */
export function cellIdFrom(description: string, appUrl: string): string | null {
  const mark = footerMark(appUrl);
  const at = description.lastIndexOf(mark);
  if (at < 0) return null;
  const query = "g=" + description.slice(at + mark.length).split(/[)\s]/, 1)[0];
  return new URLSearchParams(query).get("c") || null;
}

// ---------- days ----------

function dayFormat(timeZone: string): Intl.DateTimeFormat {
  const options: Intl.DateTimeFormatOptions = { year: "numeric", month: "2-digit", day: "2-digit" };
  try {
    return new Intl.DateTimeFormat("en-CA", { ...options, timeZone });
  } catch {
    return new Intl.DateTimeFormat("en-CA", { ...options, timeZone: "UTC" });
  }
}

/** YYYY-MM-DD of an instant in an IANA time zone (falls back to UTC for an unknown zone). */
export function localDay(instant: string | Date, timeZone: string): string {
  // Built from the parts, so it never depends on how a runtime orders an en-CA date.
  const parts = dayFormat(timeZone).formatToParts(new Date(instant));
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** True for a time zone this runtime knows, like "America/Sao_Paulo". */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Last day of the week holding `today`, for a week starting on `weekStart` (Todoist: 1 = Monday ... 7 = Sunday). */
export function weekEnd(today: string, weekStart: number): string {
  const lastWeekday = ((weekStart % 7) + 6) % 7;
  return addDays(today, (lastWeekday - dayDate(today).getDay() + 7) % 7);
}

/**
 * Day part of a Todoist due date ("2026-10-25" or "2026-10-25T10:00:00[.000000][Z]").
 * A time fixed to a zone ends in "Z" and is in UTC, so near midnight its day can differ from the person's.
 */
export function dueDay(date: string): string {
  return date.slice(0, 10);
}

/** Time part to keep when moving a dated occurrence, e.g. "T10:00:00" (or "" for a full-day date). */
export function dueTime(date: string): string {
  return date.slice(10);
}

// ---------- routines ----------

/**
 * The day a routine's Todoist occurrence belongs on now. Daily: today, or tomorrow once checked today.
 * Weekly/monthly: the open period's due day (can be before today: late), or the next due day once the
 * period has a check-in or the routine was picked after this period's due day.
 */
export function routineDueDay(cell: Cell, checkins: Checkin[], today: string, pickedDay: string | null): string {
  const schedule = repeatOf(cell);
  const start = periodStart(schedule, today);
  const next = nextPeriodStart(schedule, start);
  // Picked after this period's due day: the first one is the next due day, as on Today.
  if (schedule.repeat !== "day" && pickedDay && pickedDay > start) return next;
  return checkinsInPeriod(cell, checkins, today).length ? next : start;
}

/**
 * What a Mandaala check-in change means for the Todoist occurrence, or null for nothing. Only check-ins in
 * the period that was current on `madeOn`, the day the person made the change, move Todoist; fixing older
 * days does not. Not the day it is sent: a change sent late, after a failed try, still counts.
 * `checkins` is the state now (after the change and any later one) and `todoistDue` the occurrence's day.
 * - done: when the period still has a check-in and the occurrence is before the next period's due day, it
 *   moves forward to that day. A tick removed since moves nothing, even when its undo was sent first.
 * - not done: when the period has no check-in left and Todoist sits on the next due day, it moves back
 *   to the period's due day.
 */
export function checkinMove(
  cell: Cell,
  checkins: Checkin[],
  day: string,
  done: boolean,
  todoistDue: string,
  madeOn: string,
): { forward: boolean; to: string } | null {
  const schedule = repeatOf(cell);
  const start = periodStart(schedule, day);
  if (start !== periodStart(schedule, madeOn)) return null;
  const next = nextPeriodStart(schedule, start);
  const checked = checkinsInPeriod(cell, checkins, day).length > 0;
  if (done) return checked && todoistDue < next ? { forward: true, to: next } : null;
  return !checked && todoistDue === next ? { forward: false, to: start } : null;
}

/** Check-in day for a Todoist completion of a repeating task: the completion's local day, or the
 *  occurrence's day when it was completed early. */
export function completionDay(completedOn: string, occurrence: string | null): string {
  return occurrence && occurrence > completedOn ? occurrence : completedOn;
}

// ---------- Todoist repeats read back ----------

// The repeats Mandaala can show, as Todoist writes them in English and Portuguese (accents removed).
const DAILY =
  /^(?:(?:every|ev|each) (?:day|morning|afternoon|evening|night)|daily|everyday|todo dia|todos os dias|diariamente|cada dia|toda (?:manha|tarde|noite))$/;
const WEEKLY = /^(?:(?:every|ev|each) week|weekly|toda semana|todas as semanas|semanal|semanalmente|cada semana)$/;
const MONTHLY = /^(?:(?:every|ev|each) month|monthly|todo mes|todos os meses|mensal|mensalmente|cada mes)$/;
const LAST_DAY = /^(?:(?:every|ev|each) last day(?: of the month)?|todo ultimo dia(?: do mes)?)$/;
const MONTH_DAY = /^(?:(?:every|ev|each) (\d{1,2})(?:st|nd|rd|th)?|todo (?:dia )?(\d{1,2}))$/;
const ON_WEEKDAY = /^(?:every|ev|each|todo|toda|todos os|todas as|aos|as|nos|nas|cada) (.+)$/;
/** Weekday names and short names, Sunday first. */
const WEEKDAYS = [
  /^(?:sun|sunday|domingos?|dom)$/,
  /^(?:mon|monday|segundas?(?:[- ]feiras?)?|seg)$/,
  /^(?:tue|tues|tuesday|tercas?(?:[- ]feiras?)?|ter)$/,
  /^(?:wed|weds|wednesday|quartas?(?:[- ]feiras?)?|qua)$/,
  /^(?:thu|thur|thurs|thursday|quintas?(?:[- ]feiras?)?|qui)$/,
  /^(?:fri|friday|sextas?(?:[- ]feiras?)?|sex)$/,
  /^(?:sat|saturday|sabados?|sab)$/,
];
// An end ("until aug 3", "for 3 weeks", "até 3 de ago", "por 3 semanas"): Mandaala's repeats never end.
const ENDS = /\b(?:until|ending|for|ate|terminando|por)\b/;
// A start date ("starting aug 3", "from aug 3", "a partir de 3 de ago", "começando em 3 de ago") runs to the end.
const STARTS = / (?:starting|from|a partir de|comecando)\b.*$/;
// A time of day: "at 10am", "at 9:30 am", "@ 20:00", "at noon", "7pm", "20:00", "às 22h", "ao meio-dia",
// "de manhã", "à noite".
const TIME =
  / (?:(?:at|@|as|a|ao|de) ?(?:\d{1,2}(?:[:.h]\d{2})?(?: ?(?:am|pm|h))?|noon|midnight|meio-dia|meia-noite|manha|tarde|noite)|\d{1,2}(?:[:.]\d{2})? ?(?:am|pm)|\d{1,2}(?::\d{2}|h\d{0,2}))(?= |$)/g;

/** Lower case, plain letters ("às" reads "as") and single spaces. */
function plainWords(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Mandaala's schedule for a Todoist due. null: not repeating (a task). "custom": a repeat Mandaala cannot
 * show (every other week, every 2 days, several weekdays...). Understands our English strings, Todoist's
 * English wording and Portuguese ("todo dia", "toda segunda", "todo dia 5", "todo mês"...). Drops a time
 * ("at 10am", "às 10h") and a "starting ..." / "a partir de ..." part before reading it.
 */
export function scheduleFromDue(
  due: { string: string; date: string; is_recurring: boolean } | null,
): { repeat: Repeat; repeatOn: number | null } | "custom" | null {
  if (!due || !due.is_recurring) return null;
  const words = plainWords(due.string);
  if (ENDS.test(words)) return "custom";
  const text = words.replace(STARTS, "").replace(TIME, "").trim();
  // "every week" and "every month" repeat on the day of the current occurrence.
  const occurrence = dayDate(dueDay(due.date));
  if (DAILY.test(text)) return { repeat: "day", repeatOn: null };
  if (WEEKLY.test(text)) return { repeat: "week", repeatOn: occurrence.getDay() };
  if (MONTHLY.test(text)) return { repeat: "month", repeatOn: occurrence.getDate() };
  if (LAST_DAY.test(text)) return { repeat: "month", repeatOn: 31 };
  const date = MONTH_DAY.exec(text);
  if (date) {
    const on = Number(date[1] ?? date[2]);
    return on >= 1 && on <= 31 ? { repeat: "month", repeatOn: on } : "custom";
  }
  const named = ON_WEEKDAY.exec(text);
  const weekday = named ? WEEKDAYS.findIndex((pattern) => pattern.test(named[1])) : -1;
  return weekday >= 0 ? { repeat: "week", repeatOn: weekday } : "custom";
}
