// Pure rules for the weekly rollout and the leverage ratings. Shared by the Leverage view
// and the last step of the new goal flow, so both pick and count the same way.

import { actionLever, addDays, dayKey, isFilled, pillarCell, pillarLever, PILLAR_SLOT } from "@/domain/mandala";
import type { Cell, GoalWithCells } from "@/domain/types";

/** Score bars are drawn against these, so "High, Easy, helps 2" fills the bar. */
export const PILLAR_SCALE = 12;
export const ACTION_SCALE = 27;

// ---------- reading the chart ----------

/** Pillars (0-7) that have a name. */
export function namedPillars(goal: GoalWithCells): number[] {
  return Array.from({ length: 8 }, (_, p) => p).filter((p) => isFilled(pillarCell(goal, p)));
}

export function pillarName(goal: GoalWithCells, pillar: number): string {
  const cell = pillarCell(goal, pillar);
  return isFilled(cell) ? cell.text.trim() : `Pillar ${pillar + 1}`;
}

/** Every filled action, by pillar then slot. */
export function filledActions(goal: GoalWithCells): Cell[] {
  return goal.cells
    .filter((c) => c.slot !== PILLAR_SLOT && isFilled(c))
    .sort((a, b) => a.pillar - b.pillar || a.slot - b.slot);
}

/** Pillars with at least one open (not done) action: the most a week's picks can cover. */
export function pickablePillars(goal: GoalWithCells): number[] {
  const open = filledActions(goal).filter((c) => c.status !== "done");
  return [...new Set(open.map((c) => c.pillar))].sort((a, b) => a - b);
}

export function isUnrated(cell: Cell): boolean {
  return cell.impact === null || (cell.slot !== PILLAR_SLOT && cell.effort === null);
}

/** The highest-leverage pillar, once at least one is rated. */
export function topLeverPillar(goal: GoalWithCells): number | null {
  let best: number | null = null;
  let bestScore = 0;
  for (const p of namedPillars(goal)) {
    const cell = pillarCell(goal, p);
    const score = cell ? (pillarLever(cell) ?? 0) : 0;
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

// ---------- stable ordering ----------

/** Named pillars, highest lever first, unrated last. */
export function pillarsByLever(goal: GoalWithCells): number[] {
  const score = (p: number) => {
    const cell = pillarCell(goal, p);
    return cell ? pillarLever(cell) : null;
  };
  return namedPillars(goal).sort((a, b) => (score(b) ?? -1) - (score(a) ?? -1) || a - b);
}

/** Filled actions, highest lever first, unrated after rated, done at the end. */
export function actionsByLever(goal: GoalWithCells): string[] {
  return filledActions(goal)
    .sort(
      (a, b) =>
        Number(a.status === "done") - Number(b.status === "done") ||
        (actionLever(b) ?? -1) - (actionLever(a) ?? -1) ||
        a.pillar - b.pillar ||
        a.slot - b.slot,
    )
    .map((c) => c.id);
}

/** Keeps a saved order, drops what is gone and appends what is new, so rows never jump. */
export function keepOrder<T>(order: T[], present: T[]): T[] {
  const live = new Set(present);
  const kept = order.filter((item) => live.has(item));
  const seen = new Set(kept);
  return [...kept, ...present.filter((item) => !seen.has(item))];
}

// ---------- weeks ----------

function activatedDay(cell: Cell): string | null {
  if (!cell.activatedAt) return null;
  const date = new Date(cell.activatedAt);
  return Number.isNaN(date.getTime()) ? null : dayKey(date);
}

function dayNumber(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

export interface WeekInfo {
  /** 1 until the first pick is a week old, then counts up. */
  week: number;
  /** Picks made this week: the batch the "5-8 a week" guidance is about. */
  batch: Cell[];
  /** Picks from earlier weeks that are still open. */
  carried: number;
  /** A new week started, nothing was added yet, and there are actions left to add. */
  due: boolean;
}

export function weekInfo(goal: GoalWithCells, today = dayKey()): WeekInfo {
  const all = filledActions(goal);
  const active = all.filter((c) => c.active);
  const days = active.map(activatedDay).filter((d): d is string => d !== null).sort();
  if (!days.length) return { week: 1, batch: active, carried: 0, due: false };

  const elapsed = Math.max(0, dayNumber(today) - dayNumber(days[0]));
  const week = Math.floor(elapsed / 7) + 1;
  const start = addDays(days[0], (week - 1) * 7);
  const batch = active.filter((c) => (activatedDay(c) ?? today) >= start);
  const carried = active.filter((c) => c.status !== "done" && (activatedDay(c) ?? today) < start).length;
  const left = all.some((c) => !c.active && c.status !== "done");
  return { week, batch, carried, due: week >= 2 && batch.length === 0 && left };
}

/** Which pickable pillars the given actions cover. */
export function coverage(goal: GoalWithCells, cells: Cell[]): { covered: number[]; total: number[] } {
  const picked = new Set(cells.map((c) => c.pillar));
  // A pillar stays covered when this week's pick in it is already done.
  const total = [...new Set([...pickablePillars(goal), ...picked])].sort((a, b) => a - b);
  return { covered: total.filter((p) => picked.has(p)), total };
}
