// Where the next typed square goes. Ring index 0-7 runs clockwise from 12 o'clock, so
// "next" always moves clockwise, the way the chart is read.

import { actionCells, isFilled, pillarCell } from "@/domain/mandala";
import type { Cell, CellPatch, GoalWithCells } from "@/domain/types";
import { namedPillars } from "@/domain/week";

/** Ring indexes after `from`, clockwise and wrapping, without `from` itself. */
function after(from: number): number[] {
  return Array.from({ length: 7 }, (_, i) => (from + 1 + i) % 8);
}

export function pillarAt(goal: GoalWithCells, index: number): Cell | undefined {
  return pillarCell(goal, index);
}

export function actionAt(goal: GoalWithCells, pillar: number, slot: number): Cell | undefined {
  return actionCells(goal, pillar).find((c) => c.slot === slot);
}

export function firstEmptyPillar(goal: GoalWithCells): number | null {
  for (let p = 0; p < 8; p++) if (!isFilled(pillarCell(goal, p))) return p;
  return null;
}

export function nextEmptyPillar(goal: GoalWithCells, from: number): number | null {
  return after(from).find((p) => !isFilled(pillarCell(goal, p))) ?? null;
}

export function firstEmptyAction(goal: GoalWithCells, pillar: number): number | null {
  for (let s = 0; s < 8; s++) if (!isFilled(actionAt(goal, pillar, s))) return s;
  return null;
}

export function nextEmptyAction(goal: GoalWithCells, pillar: number, from: number): number | null {
  return after(from).find((s) => !isFilled(actionAt(goal, pillar, s))) ?? null;
}

/** Empty slots clockwise, starting at `from` itself. */
export function emptyActionSlots(goal: GoalWithCells, pillar: number, from: number): number[] {
  return [from, ...after(from)].filter((s) => !isFilled(actionAt(goal, pillar, s)));
}

export function emptyPillarSlots(goal: GoalWithCells, from: number): number[] {
  return [from, ...after(from)].filter((p) => !isFilled(pillarCell(goal, p)));
}

export function filledActionCount(goal: GoalWithCells, pillar: number): number {
  return actionCells(goal, pillar).filter(isFilled).length;
}

/** The first named pillar that still has room, else the first named one. */
export function firstPillarToFill(goal: GoalWithCells): number | null {
  const named = namedPillars(goal);
  return named.find((p) => firstEmptyAction(goal, p) !== null) ?? named[0] ?? null;
}

/** The next named pillar after `from` that still has room. No wrap: the chain ends at the last one. */
export function nextPillarToFill(goal: GoalWithCells, from: number): number | null {
  return namedPillars(goal).find((p) => p > from && firstEmptyAction(goal, p) !== null) ?? null;
}

/** The next or previous named pillar around the ring. */
export function stepPillar(goal: GoalWithCells, from: number, direction: 1 | -1): number {
  const named = namedPillars(goal);
  if (!named.length) return from;
  const index = named.indexOf(from);
  if (index === -1) return named[0];
  return named[(index + direction + named.length) % named.length];
}

/** Clearing a square resets everything about it, like the chart editor does. */
export const CLEAR_PATCH: CellPatch = {
  text: "",
  notes: "",
  kind: "task",
  status: "todo",
  active: false,
  impact: null,
  effort: null,
  helps: [],
};

export function restorePatch(cell: Cell): CellPatch {
  return {
    text: cell.text,
    notes: cell.notes,
    kind: cell.kind,
    status: cell.status,
    active: cell.active,
    // Undo keeps the original start, so habit strength and the week count survive.
    activatedAt: cell.active ? cell.activatedAt : null,
    impact: cell.impact,
    effort: cell.effort,
    helps: cell.helps,
  };
}
