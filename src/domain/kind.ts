// Habit or task, guessed from the wording. One rule for the new goal flow, the chart editor
// and the AI's answers, so a square never flips kind depending on where it was typed.

import type { CellKind, Repeat } from "./types";

// Recurring wording, in English and Portuguese, means a habit.
const HABIT_PATTERNS = [
  /\b(every|everyday|daily|each|nightly|weekly|weekdays|weeknights|weekends)\b/i,
  /\b(per|once a|twice a|once per|twice per) (day|week|night)\b/i,
  /(\d\s*x|\btimes)\s+(a|per)\s+(day|week)\b/i,
  /\bx a week\b/i,
  // "Drink 2L of water a day", "Sleep 8h a night". Not "Paint 3 rooms in a week": a deadline.
  /\d\S*\s+(?:(?!(?:with)?in\s)[\p{L}-]+\s+){0,3}(a|per)\s+(day|night|week)\b/iu,
  // "20 pages/day", "10 min/dia". The number keeps "the day/night mode bug" a task.
  /\d[^/]{0,20}\/\s*(day|d|week|wk|night|dia|semana|noite)\b/i,
  // "Gym 3x/wk", "3x week".
  /\d\s*x\s*\/?\s*(wk|week)\b/i,
  /\b(todos?|todas?)\s+(os\s+|as\s+)?(dias?|semanas?|manh|noites?)/i,
  /\b(diariamente|semanalmente)\b/i,
  /\bpor\s+(dia|semana)\b/i,
  /(\d\s*x|\bvezes)\s+(por|na|ao)\s+(dia|semana)\b/i,
  /\bcada\s+(dia|semana|manh|noite)/i,
];

// Once a month. "Read 2 books a month" counts too: one check when the month's books are read.
const MONTHLY = [
  /\b(monthly|every month|each month|(once|twice)? ?(a|per) month)\b/i,
  /\b(mensalmente|todo m[eê]s|todos os meses|cada m[eê]s|(por|ao) m[eê]s)(?![\p{L}])/iu,
];

// Once a week. "Gym 3x a week" stays daily: it is ticked on the days you go.
const WEEKLY = [
  /\b(weekly|every week|each week|once (a|per) week)\b/i,
  /\b(semanalmente|toda semana|todas as semanas|cada semana|uma vez (por|na) semana)(?![\p{L}])/iu,
];

// "Every Sunday", "on Sundays", "todo domingo", "aos sábados": weekly, on that day.
const WEEKDAYS: [number, RegExp][] = [
  [0, /\b(sundays?|sun)\b|\bdomingos?\b/i],
  [1, /\b(mondays?|mon)\b|\bsegundas?(-feiras?)?\b/i],
  [2, /\b(tuesdays?|tue|tues)\b|\bter[cç]as?(-feiras?)?(?![\p{L}])/iu],
  [3, /\b(wednesdays?|wed)\b|\bquartas?(-feiras?)?\b/i],
  [4, /\b(thursdays?|thu|thurs)\b|\bquintas?(-feiras?)?\b/i],
  [5, /\b(fridays?|fri)\b|\bsextas?(-feiras?)?\b/i],
  [6, /\b(saturdays?|sat)\b|(^|[^\p{L}])s[aá]bados?(?![\p{L}])/iu],
];
const ON_WEEKDAY =
  /\b(every|each|on)\s+(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b|\b(sun|mon|tues|wednes|thurs|fri|satur)days\b|\b(tod[oa]s?|cada|aos?|nas?)\s+(os\s+|as\s+)?(domingo|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado)/iu;

export interface RepeatGuess {
  repeat: Repeat;
  /** A weekday (0-6) or day of the month (1-31) the wording names; null lets the caller pick. */
  repeatOn: number | null;
}

/** How often a habit comes back, guessed from the wording. Daily unless it says week or month. */
export function guessRepeat(text: string): RepeatGuess {
  if (MONTHLY.some((pattern) => pattern.test(text))) {
    const date = /\b([1-9]|[12]\d|3[01])(st|nd|rd|th)\b|\bdia\s+([1-9]|[12]\d|3[01])\b/i.exec(text);
    return { repeat: "month", repeatOn: date ? Number(date[1] ?? date[3]) : null };
  }
  if (ON_WEEKDAY.test(text)) {
    const day = WEEKDAYS.find(([, pattern]) => pattern.test(text));
    return { repeat: "week", repeatOn: day ? day[0] : null };
  }
  if (WEEKLY.some((pattern) => pattern.test(text))) return { repeat: "week", repeatOn: null };
  return { repeat: "day", repeatOn: null };
}

export function guessKind(text: string): CellKind {
  if (HABIT_PATTERNS.some((pattern) => pattern.test(text))) return "habit";
  return guessRepeat(text).repeat === "day" ? "task" : "habit";
}
