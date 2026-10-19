// Pure helpers for the chart views: where each square sits in the 9x9, what it holds,
// and the small bits of copy the views share. No React, no store.

import { guessKind } from "@/domain/kind";
import {
  PILLAR_SLOT,
  RING,
  gridCoord,
  routineStrength,
  isFilled,
  pillarLever,
  ringIndex,
  statusGlyph,
  strengthGlyph,
} from "@/domain/mandala";
import type { Cell, Checkin, GoalWithCells } from "@/domain/types";

// ---------- geometry ----------

/** A square in the full 9x9: row and column 0-8. */
export interface Coord {
  row: number;
  col: number;
}

export const GOAL_COORD: Coord = { row: 4, col: 4 };

/** What a square shows. A pillar appears twice: in the center block and in the middle of its own block. */
export type SquareRef =
  { role: "goal" } | { role: "pillar"; pillar: number } | { role: "action"; pillar: number; slot: number };

export function blockOf(c: Coord): number {
  return Math.floor(c.row / 3) * 3 + Math.floor(c.col / 3);
}

export function positionOf(c: Coord): number {
  return (c.row % 3) * 3 + (c.col % 3);
}

export function sameCoord(a: Coord | null | undefined, b: Coord | null | undefined): boolean {
  return Boolean(a && b && a.row === b.row && a.col === b.col);
}

export function coordKey(c: Coord): string {
  return `${c.row}-${c.col}`;
}

export function clampCoord(row: number, col: number): Coord {
  return { row: Math.max(0, Math.min(8, row)), col: Math.max(0, Math.min(8, col)) };
}

export function squareAt(c: Coord): SquareRef {
  const block = blockOf(c);
  const position = positionOf(c);
  if (block === 4) return position === 4 ? { role: "goal" } : { role: "pillar", pillar: ringIndex(position) };
  const pillar = ringIndex(block);
  return position === 4 ? { role: "pillar", pillar } : { role: "action", pillar, slot: ringIndex(position) };
}

/** Pillar p in the center block, or (own = true) in the middle of its own block. */
export function pillarCoord(p: number, own = false): Coord {
  return own ? gridCoord(RING[p], 4) : gridCoord(4, RING[p]);
}

export function actionCoord(p: number, slot: number): Coord {
  return gridCoord(RING[p], RING[slot]);
}

// ---------- reading a goal ----------

export interface ChartIndex {
  /** Pillar cell by pillar index. */
  pillars: (Cell | undefined)[];
  /** Action cells by [pillar][slot]. */
  actions: (Cell | undefined)[][];
}

export function indexGoal(goal: GoalWithCells): ChartIndex {
  const pillars = Array.from({ length: 8 }, (): Cell | undefined => undefined);
  const actions = Array.from({ length: 8 }, () => Array.from({ length: 8 }, (): Cell | undefined => undefined));
  for (const cell of goal.cells) {
    if (cell.pillar < 0 || cell.pillar > 7) continue;
    if (cell.slot === PILLAR_SLOT) pillars[cell.pillar] = cell;
    else if (cell.slot >= 0 && cell.slot < 8) actions[cell.pillar][cell.slot] = cell;
  }
  return { pillars, actions };
}

export function cellAt(index: ChartIndex, ref: SquareRef): Cell | undefined {
  if (ref.role === "goal") return undefined;
  if (ref.role === "pillar") return index.pillars[ref.pillar];
  return index.actions[ref.pillar][ref.slot];
}

/** Squares of one 3x3 block in ring order (clockwise from 12 o'clock), without its center. */
export function ringCells(index: ChartIndex, block: number): (Cell | undefined)[] {
  if (block === 4) return index.pillars;
  return index.actions[ringIndex(block)];
}

/**
 * The next empty square clockwise in the same 3x3 block, after this one (wrapping).
 * Null when every other square in the block is filled, so the caller stays put.
 */
export function nextEmptyInBlock(index: ChartIndex, from: Coord): Coord | null {
  const block = blockOf(from);
  const position = positionOf(from);
  const start = position === 4 ? -1 : ringIndex(position);
  const ring = ringCells(index, block);
  for (let step = 1; step <= 8; step++) {
    const i = (start + step + 8) % 8;
    if (i === start) return null;
    if (ring[i] && !isFilled(ring[i])) return gridCoord(block, RING[i]);
  }
  return null;
}

export function namedPillars(index: ChartIndex): boolean[] {
  return index.pillars.map((cell) => isFilled(cell));
}

/** The pillar with the highest lever score, if any pillar is rated. Ties go to the first clockwise. */
export function leverPillar(index: ChartIndex): number | null {
  let best: number | null = null;
  let bestScore = 0;
  for (let p = 0; p < 8; p++) {
    const cell = index.pillars[p];
    if (!isFilled(cell)) continue;
    const score = pillarLever(cell);
    if (score !== null && score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

/** Corner glyph for an action: its status, or the habit strength ramp for an active habit. */
export function actionGlyph(cell: Cell | undefined, checkins: Checkin[], today: string): string | undefined {
  if (!isFilled(cell)) return undefined;
  if (cell.kind === "habit" && cell.active && cell.status !== "done") {
    return strengthGlyph(routineStrength(cell, checkins, today));
  }
  return statusGlyph(cell);
}

/** Glyph per action cell id, computed once per render of the chart. */
export function glyphsFor(goal: GoalWithCells, checkins: Checkin[], today: string): Map<string, string | undefined> {
  const habits = new Set(
    goal.cells.filter((c) => c.kind === "habit" && c.active && c.slot !== PILLAR_SLOT).map((c) => c.id),
  );
  // Only habit glyphs read check-ins; keep that list short.
  const relevant = habits.size ? checkins.filter((c) => habits.has(c.cellId)) : [];
  const glyphs = new Map<string, string | undefined>();
  for (const cell of goal.cells) {
    if (cell.slot === PILLAR_SLOT) continue;
    glyphs.set(cell.id, actionGlyph(cell, relevant, today));
  }
  return glyphs;
}

/** Picked for this week and not done yet: the accent dot. */
export function isMarked(cell: Cell | undefined): boolean {
  return Boolean(cell && isFilled(cell) && cell.active && cell.status !== "done");
}

export function weekCount(goal: GoalWithCells): { actions: number; pillars: number } {
  const pillars = new Set<number>();
  let actions = 0;
  for (const cell of goal.cells) {
    if (cell.slot === PILLAR_SLOT || !isMarked(cell)) continue;
    actions++;
    pillars.add(cell.pillar);
  }
  return { actions, pillars: pillars.size };
}

/** Changes in what a square shows. Used to notice updates that came from elsewhere (another device). */
export function squareSignature(cell: Cell, glyph: string | undefined, doneToday = false): string {
  return JSON.stringify([cell.text, cell.status, cell.active, cell.kind, glyph ?? "", doneToday]);
}

export function pillarName(index: ChartIndex, p: number): string {
  return index.pillars[p]?.text.trim() || `Pillar ${p + 1}`;
}

/** First letter of a pillar, for the glyph map. */
export function initialOf(text: string): string {
  const first = Array.from(text.trim())[0];
  return first ? first.toUpperCase() : "·";
}

export function squareLabel(goal: GoalWithCells, index: ChartIndex, ref: SquareRef): string {
  if (ref.role === "goal") return `Goal: ${goal.title || "untitled"}`;
  const cell = cellAt(index, ref);
  if (ref.role === "pillar") {
    return isFilled(cell) ? `Pillar ${ref.pillar + 1}: ${cell.text}` : `Empty pillar ${ref.pillar + 1}`;
  }
  if (!isFilled(cell)) return `Empty action in ${pillarName(index, ref.pillar)}`;
  const state =
    cell.status === "done" ? "done" : cell.status === "doing" ? "doing" : cell.active ? "this week" : "idea";
  return `${cell.text} (${cell.kind === "habit" ? "habit, " : ""}${state})`;
}

// ---------- copy ----------

export function formatDay(day: string, withYear = true): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  return new Date(y, m - 1, d).toLocaleDateString(
    "en-US",
    withYear ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" },
  );
}

export function goalSubtitle(
  goal: GoalWithCells,
  progress: number,
  counts: { pillars: number; actions: number },
): string {
  const parts: string[] = [];
  if (goal.deadline) parts.push(`By ${formatDay(goal.deadline)}`);
  if (counts.actions > 0) parts.push(`${Math.round(progress * 100)}%`);
  parts.push(`${counts.pillars}/8 pillars`);
  if (counts.pillars > 0 || counts.actions > 0) parts.push(`${counts.actions}/64 actions`);
  return parts.join(" · ");
}

/** One quiet line of guidance for where the chart is in the method, or null when it is all set. */
export function chartHint(
  counts: { pillars: number; actions: number },
  week: number,
  device: "phone" | "desktop",
): string | null {
  if (counts.pillars === 0) {
    return device === "phone"
      ? "Start with 8 pillars: the key drivers of your goal. Tap + to add one."
      : "Start with 8 pillars: the key drivers of your goal.";
  }
  if (counts.pillars < 8) return `${counts.pillars} of 8 pillars. Cover mind, skill, body and daily life.`;
  if (counts.actions === 0) {
    return device === "phone"
      ? "Tap a pillar to give it 8 actions you can tick off."
      : "Give each pillar 8 actions you can tick off.";
  }
  if (week === 0) return "Pick 5-8 actions for this week in Leverage.";
  return null;
}

export function pillarHints(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  if (t.split(/\s+/).length > 4 || t.length > 32) return ["Keep it short: 1-3 words, like Sleep or Focus."];
  return [];
}


/** Recurring wording ("every", "daily", "3x a week") reads as a habit. */
export function looksLikeHabit(text: string): boolean {
  return guessKind(text) === "habit";
}

export function strengthWord(strength: number): string {
  if (strength <= 0.02) return "Not started";
  if (strength < 0.3) return "Starting";
  if (strength < 0.55) return "Building";
  if (strength < 0.8) return "Steady";
  return "Strong";
}
