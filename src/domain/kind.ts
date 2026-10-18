// Habit or task, guessed from the wording. One rule for the new goal flow, the chart editor
// and the AI's answers, so a square never flips kind depending on where it was typed.

import type { CellKind } from "./types";

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

export function guessKind(text: string): CellKind {
  return HABIT_PATTERNS.some((pattern) => pattern.test(text)) ? "habit" : "task";
}
