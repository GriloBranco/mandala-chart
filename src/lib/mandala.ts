// Pure rules of the chart, shared by the server and the client.
//
// Geometry: the 9x9 chart is 9 blocks of 3x3. The center block holds the goal and its
// 8 pillars; each outer block repeats one pillar in its center, surrounded by 8 actions.
// Index 0-7 runs clockwise from 12 o'clock, as in the Harada method: T, TR, R, BR, B, BL, L, TL.

import type { Cell, CellPatch, Checkin, GoalWithCells } from "./types";

export const PILLAR_SLOT = -1;

/** Longest notes a square can hold (reports append dated lines to them). */
export const NOTES_MAX = 20000;

/** 3x3 position (row-major 0-8) for ring index 0-7, clockwise from 12 o'clock. */
export const RING = [1, 2, 5, 8, 7, 6, 3, 0] as const;

export function ringPosition(index: number): number {
  return RING[index];
}

/** Ring index for a 3x3 position, or -1 for the center (4). */
export function ringIndex(position: number): number {
  return RING.indexOf(position as (typeof RING)[number]);
}

/** Row and column (0-8) in the full 9x9 for a block (0-8) and a position inside it (0-8). */
export function gridCoord(block: number, position: number): { row: number; col: number } {
  return {
    row: Math.floor(block / 3) * 3 + Math.floor(position / 3),
    col: (block % 3) * 3 + (position % 3),
  };
}

// ---------- reading a goal ----------

export function pillarCell(goal: GoalWithCells, pillar: number): Cell | undefined {
  return goal.cells.find((c) => c.pillar === pillar && c.slot === PILLAR_SLOT);
}

export function actionCells(goal: GoalWithCells, pillar: number): Cell[] {
  return goal.cells
    .filter((c) => c.pillar === pillar && c.slot !== PILLAR_SLOT)
    .sort((a, b) => a.slot - b.slot);
}

export function isFilled(cell: Cell | undefined): cell is Cell {
  return Boolean(cell && cell.text.trim());
}

export function fillCounts(goal: GoalWithCells): { pillars: number; actions: number } {
  let pillars = 0;
  let actions = 0;
  for (const cell of goal.cells) {
    if (!isFilled(cell)) continue;
    if (cell.slot === PILLAR_SLOT) pillars++;
    else actions++;
  }
  return { pillars, actions };
}

// ---------- status rules ----------

/**
 * Keeps a change consistent with the square it applies to: done means 100%, a square put back
 * into this week or switched to a habit starts fresh. The client and the server both use this,
 * and the client queues the result, so the server never re-derives it from a different state.
 */
export function normalizePatch(before: Cell, patch: CellPatch): CellPatch {
  const next = { ...patch };
  // Back into this week after being finished: do it again.
  if (next.active === true && !before.active && next.status === undefined && before.status === "done") {
    next.status = "todo";
  }
  // A habit has no "doing" or "done": switching to habit starts it fresh.
  if (next.kind === "habit" && before.kind !== "habit" && next.status === undefined && before.status !== "todo") {
    next.status = "todo";
  }
  if (next.status !== undefined && next.progress === undefined) {
    if (next.status === "done") next.progress = 100;
    else if (next.status === "todo" && before.progress !== 0) next.progress = 0;
    else if (next.status === "doing" && before.status === "done") next.progress = 50;
  }
  if (next.progress !== undefined && next.status === undefined) {
    if (next.progress >= 100) next.status = "done";
    else if (next.progress > 0 && before.status === "todo") next.status = "doing";
    else if (next.progress === 0 && before.status === "done") next.status = "todo";
  }
  return next;
}

/**
 * The patch to send to the server for a change made on screen: normalized against what the
 * screen showed, with the same start and finish times the screen used.
 */
export function syncPatch(before: Cell, patch: CellPatch, now: string): CellPatch {
  const out: CellPatch = { ...normalizePatch(before, patch) };
  delete out.activatedAt;
  delete out.doneAt;
  if (out.active === true && !before.active) out.activatedAt = patch.activatedAt ?? now;
  if (out.status === "done" && before.status !== "done") out.doneAt = patch.doneAt ?? now;
  return out;
}

export function applyPatch(cell: Cell, patch: CellPatch, now: string): Cell {
  const normalized = normalizePatch(cell, patch);
  const next = { ...cell, ...normalized, updatedAt: now };
  // Start and finish times only change with the state they belong to (Undo may restore old ones).
  next.activatedAt = cell.activatedAt;
  next.doneAt = cell.doneAt;
  if (normalized.active === true && !cell.active) next.activatedAt = patch.activatedAt ?? now;
  if (normalized.active === false) next.activatedAt = null;
  if (normalized.status && normalized.status !== cell.status) {
    next.doneAt = normalized.status === "done" ? (patch.doneAt ?? now) : null;
  }
  return next;
}

// ---------- leverage (app add-on; the method itself ranks by judgment) ----------

/** Pillar lever: impact x (1 + pillars it makes easier). 1 to 24. Null until rated. */
export function pillarLever(cell: Cell): number | null {
  if (!cell.impact) return null;
  return cell.impact * (1 + cell.helps.length);
}

/** Action lever: impact x ease x (1 + other pillars it helps). Null until impact is rated. */
export function actionLever(cell: Cell): number | null {
  if (!cell.impact) return null;
  const ease = cell.effort ? 4 - cell.effort : 2;
  return cell.impact * ease * (1 + cell.helps.length);
}

export const IMPACT_LABELS = ["", "Low", "Medium", "High"] as const;
export const EFFORT_LABELS = ["", "Easy", "Medium", "Hard"] as const;

// ---------- days ----------

/** Local calendar day as YYYY-MM-DD. */
export function dayKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return dayKey(new Date(y, m - 1, d + delta));
}

// ---------- progress ----------

/**
 * Habit strength, 0-1. Forgiving like Loop Habit Tracker: every done day pulls it up,
 * a missed day only lets it decay a little, so one bad day never resets it to zero.
 */
export function habitStrength(cellId: string, checkins: Checkin[], today: string): number {
  // Every real check-in in the window counts, even from before the habit was (re)picked:
  // the curve starts at 0, so days with no ticks add nothing.
  const done = new Set(checkins.filter((c) => c.cellId === cellId).map((c) => c.day));
  let strength = 0;
  for (let i = 29; i >= 0; i--) {
    strength = strength * 0.85 + (done.has(addDays(today, -i)) ? 0.15 : 0);
  }
  return Math.min(1, strength / (1 - Math.pow(0.85, 14)));
}

/** Monochrome glyph for a strength value: empty, light, medium, dense, full. */
export function strengthGlyph(strength: number): string {
  if (strength <= 0.02) return "·";
  if (strength < 0.3) return "░";
  if (strength < 0.55) return "▒";
  if (strength < 0.8) return "▓";
  return "█";
}

export function cellProgress(cell: Cell, checkins: Checkin[], today: string): number {
  if (cell.status === "done") return 1;
  if (cell.kind === "habit") {
    return cell.active ? habitStrength(cell.id, checkins, today) : 0;
  }
  return cell.status === "doing" ? 0.5 : 0;
}

export function pillarProgress(goal: GoalWithCells, pillar: number, checkins: Checkin[], today: string): number {
  const filled = actionCells(goal, pillar).filter(isFilled);
  if (!filled.length) return 0;
  return filled.reduce((sum, c) => sum + cellProgress(c, checkins, today), 0) / filled.length;
}

export function goalProgress(goal: GoalWithCells, checkins: Checkin[], today: string): number {
  const values: number[] = [];
  for (let p = 0; p < 8; p++) {
    if (actionCells(goal, p).some(isFilled)) values.push(pillarProgress(goal, p, checkins, today));
  }
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Monochrome status glyph used on the map: empty, idea, active, in progress, done. */
export function statusGlyph(cell: Cell): string {
  if (!isFilled(cell)) return "·";
  if (cell.status === "done") return "●";
  if (cell.status === "doing") return "◐";
  if (cell.active) return "◉";
  return "○";
}

// ---------- today ----------

export interface TodayItem {
  goal: GoalWithCells;
  pillar: Cell | undefined;
  cell: Cell;
}

/** Active habits (checked daily) and active tasks that are not done yet, across active goals. */
export function todayItems(goals: GoalWithCells[]): { habits: TodayItem[]; tasks: TodayItem[] } {
  const habits: TodayItem[] = [];
  const tasks: TodayItem[] = [];
  for (const goal of goals) {
    if (goal.status !== "active") continue;
    for (const cell of goal.cells) {
      if (!cell.active || cell.slot === PILLAR_SLOT || !isFilled(cell)) continue;
      const item = { goal, pillar: pillarCell(goal, cell.pillar), cell };
      if (cell.kind === "habit") {
        if (cell.status !== "done") habits.push(item);
      } else if (cell.status !== "done") {
        tasks.push(item);
      }
    }
  }
  const order = (a: TodayItem, b: TodayItem) =>
    (actionLever(b.cell) ?? 0) - (actionLever(a.cell) ?? 0) || a.cell.pillar - b.cell.pillar;
  return { habits: habits.sort(order), tasks: tasks.sort(order) };
}

// ---------- light writing checks from the method (never block saving) ----------

const VAGUE = /\b(better|more|improve|try|work on|do my best|be (a )?(good|great)|someday|maybe)\b/i;
const NUMBER = /\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|once|twice|daily|every|each|weekly|monthly)\b/i;
const OUTCOME = /\b(views|followers|subscribers|likes|revenue|sales|grade|rank|ranking|win|get (picked|chosen|hired))\b/i;

/** Hints for an action, from the video's two tests: can you tick it off, and do you control it? */
export function actionHints(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  const hints: string[] = [];
  if (!NUMBER.test(t)) hints.push("Add a number or how often, so you can tick it off.");
  if (VAGUE.test(t) && !NUMBER.test(t)) hints.push("Vague word. Say exactly what you will do.");
  if (OUTCOME.test(t)) hints.push("Sounds like an outcome. Write the input you control.");
  if (t.length > 70) hints.push("Long. Keep the square short and put details in notes.");
  return hints;
}

export function goalHints(title: string, deadline: string | null): string[] {
  const t = title.trim();
  if (!t) return [];
  const hints: string[] = [];
  if (!deadline && !/\b(by|before|until)\b/i.test(t)) hints.push("Add a date. A dream becomes a goal once it has one.");
  if (!/\d/.test(t)) hints.push("Add a number or a clear finish line.");
  return hints;
}
