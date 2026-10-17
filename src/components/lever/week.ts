// Pure rules for the weekly rollout and the leverage ratings. Shared by the Leverage view
// and the last step of the new goal flow, so both pick and count the same way.

import { actionLever, addDays, dayKey, isFilled, pillarCell, pillarLever, PILLAR_SLOT } from "@/lib/mandala";
import type { Cell, CellPatch, GoalWithCells, LeverageAnalysis } from "@/lib/types";

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

// ---------- AI ratings ----------

export interface AiPillar {
  impact: number;
  helps: number[];
  reason: string;
}

export interface AiAction {
  impact: number;
  effort: number;
  helps: number[];
  reason: string;
}

/** The AI answer checked against the chart as it is now. */
export interface AiRead {
  pillars: Map<number, AiPillar>;
  actions: Map<string, AiAction>;
  picks: string[];
  insight: string;
}

function rating(value: unknown): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(3, Math.max(1, n)) : 2;
}

/** Other named pillars only, no duplicates, sorted. */
export function cleanHelps(helps: unknown, own: number, named: Set<number>): number[] {
  if (!Array.isArray(helps)) return [];
  const valid = helps.filter((p): p is number => Number.isInteger(p) && p !== own && named.has(p));
  return [...new Set(valid)].sort((a, b) => a - b);
}

export function sameSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((n) => set.has(n));
}

/** Drops squares that no longer exist, clamps ratings, and keeps at most 8 picks. */
export function readAnalysis(goal: GoalWithCells, analysis: LeverageAnalysis): AiRead {
  const named = new Set(namedPillars(goal));
  const byId = new Map(filledActions(goal).map((c) => [c.id, c]));

  const pillars = new Map<number, AiPillar>();
  for (const item of analysis.pillars ?? []) {
    if (!named.has(item.pillar)) continue;
    pillars.set(item.pillar, {
      impact: rating(item.impact),
      helps: cleanHelps(item.helps, item.pillar, named),
      reason: (item.reason ?? "").trim(),
    });
  }

  const actions = new Map<string, AiAction>();
  for (const item of analysis.actions ?? []) {
    const cell = byId.get(item.cellId);
    if (!cell) continue;
    actions.set(cell.id, {
      impact: rating(item.impact),
      effort: rating(item.effort),
      helps: cleanHelps(item.helps, cell.pillar, named),
      reason: (item.reason ?? "").trim(),
    });
  }

  const read: AiRead = { pillars, actions, picks: [], insight: (analysis.insight ?? "").trim() };
  const picks = [...new Set(analysis.picks ?? [])].filter((id) => {
    const cell = byId.get(id);
    return cell && cell.status !== "done";
  });
  read.picks = picks.length ? picks.slice(0, 8) : suggestPicks(goal, read);
  return read;
}

/**
 * Picks like the video: the best action from each pillar (impact, ease and synergy all count
 * in the score), strongest first, 8 at most; topped up to 5 when there are fewer pillars.
 * Returns nothing when there are no ratings to go on.
 */
export function suggestPicks(goal: GoalWithCells, read?: AiRead | null, limit = 8): string[] {
  interface Rated {
    cell: Cell;
    score: number;
    helps: number;
  }
  const rated: Rated[] = [];
  for (const cell of filledActions(goal)) {
    if (cell.status === "done") continue;
    const ai = read?.actions.get(cell.id);
    const impact = ai?.impact ?? cell.impact;
    if (!impact) continue;
    const effort = ai?.effort ?? cell.effort;
    const helps = (ai?.helps ?? cell.helps).length;
    rated.push({ cell, helps, score: impact * (effort ? 4 - effort : 2) * (1 + helps) });
  }
  const better = (a: Rated, b: Rated) =>
    b.score - a.score || b.helps - a.helps || Number(a.cell.active) - Number(b.cell.active) || a.cell.pillar - b.cell.pillar;

  const best = new Map<number, Rated>();
  for (const item of rated) {
    const current = best.get(item.cell.pillar);
    if (!current || better(item, current) < 0) best.set(item.cell.pillar, item);
  }
  const picks = [...best.values()].sort(better).slice(0, limit);
  if (picks.length < 5) {
    const chosen = new Set(picks);
    picks.push(...rated.filter((item) => !chosen.has(item)).sort(better).slice(0, 5 - picks.length));
  }
  return picks.map((item) => item.cell.id);
}

/** Patches that write the AI ratings. "fill" only sets what has not been rated yet. */
export function ratingPatches(
  goal: GoalWithCells,
  read: AiRead,
  mode: "fill" | "all",
): { id: string; patch: CellPatch }[] {
  const out: { id: string; patch: CellPatch }[] = [];
  for (const [p, ai] of read.pillars) {
    const cell = pillarCell(goal, p);
    if (!cell) continue;
    const patch: CellPatch = {};
    if ((mode === "all" || cell.impact === null) && cell.impact !== ai.impact) patch.impact = ai.impact;
    if ((mode === "all" || !cell.helps.length) && !sameSet(cell.helps, ai.helps)) patch.helps = ai.helps;
    if (Object.keys(patch).length) out.push({ id: cell.id, patch });
  }
  const cells = new Map(goal.cells.map((c) => [c.id, c]));
  for (const [id, ai] of read.actions) {
    const cell = cells.get(id);
    // Finished tasks keep their ratings: a bulk write must not touch them.
    if (!cell || cell.status === "done") continue;
    const patch: CellPatch = {};
    if ((mode === "all" || cell.impact === null) && cell.impact !== ai.impact) patch.impact = ai.impact;
    if ((mode === "all" || cell.effort === null) && cell.effort !== ai.effort) patch.effort = ai.effort;
    if ((mode === "all" || !cell.helps.length) && !sameSet(cell.helps, ai.helps)) patch.helps = ai.helps;
    if (Object.keys(patch).length) out.push({ id, patch });
  }
  return out;
}

/** The values a patch is about to change, so an Undo can put them back. */
export function undoPatches(goal: GoalWithCells, updates: { id: string; patch: CellPatch }[]) {
  const cells = new Map(goal.cells.map((c) => [c.id, c]));
  return updates.flatMap(({ id, patch }) => {
    const cell = cells.get(id);
    if (!cell) return [];
    const before: CellPatch = {};
    for (const key of Object.keys(patch) as (keyof CellPatch)[]) {
      (before as Record<string, unknown>)[key] = cell[key];
    }
    return [{ id, patch: before }];
  });
}

/** Changes when the chart's words change, so an analysis is redone only when it would differ. */
export function leverSig(goal: GoalWithCells): string {
  let hash = 5381;
  for (const cell of goal.cells) {
    if (!isFilled(cell)) continue;
    const text = `${cell.id}:${cell.text.trim()}|`;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return `${goal.id}:${hash >>> 0}`;
}
