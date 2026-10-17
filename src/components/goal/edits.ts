"use client";

// Every change the chart makes goes through here. It remembers which squares were edited on
// this screen, so the "updated from a report" flash only lights up changes that came from
// elsewhere, and it gives check-offs and clears an Undo.

import { ApiError } from "@/lib/api-client";
import { actions, cellById } from "@/lib/store";
import { toast } from "@/lib/toast";
import type { Cell, CellKind, CellPatch, Suggestion } from "@/lib/types";

const touched = new Map<string, number>();

function touch(id: string) {
  touched.set(id, Date.now());
}

/** True when this screen changed the square in the last few seconds. */
export function wasTouched(id: string, within = 4000): boolean {
  const at = touched.get(id);
  return at !== undefined && Date.now() - at < within;
}

export function editCell(id: string, patch: CellPatch, options: { debounce?: boolean } = {}) {
  touch(id);
  actions.updateCell(id, patch, options);
}

export function editCells(updates: { id: string; patch: CellPatch }[]) {
  if (!updates.length) return;
  for (const update of updates) touch(update.id);
  actions.updateCells(updates);
}

export function setCheckin(cellId: string, day: string, done: boolean) {
  touch(cellId);
  actions.toggleCheckin(cellId, day, done);
}

function snapshot(cell: Cell): CellPatch {
  return {
    text: cell.text,
    notes: cell.notes,
    kind: cell.kind,
    status: cell.status,
    progress: cell.progress,
    impact: cell.impact,
    effort: cell.effort,
    helps: [...cell.helps],
    active: cell.active,
    // Undo keeps the original start and finish times, so habit strength, the week count and
    // "Done today" survive.
    activatedAt: cell.active ? cell.activatedAt : null,
    doneAt: cell.status === "done" ? cell.doneAt : null,
  };
}

const CLEARED: CellPatch = {
  text: "",
  notes: "",
  kind: "task",
  status: "todo",
  progress: 0,
  impact: null,
  effort: null,
  helps: [],
  active: false,
};

/** Anything worth clearing: text, notes, ratings, links or a weekly pick. */
export function hasContent(cell: Cell | undefined): cell is Cell {
  if (!cell) return false;
  return Boolean(
    cell.text.trim() || cell.notes.trim() || cell.impact || cell.effort || cell.helps.length || cell.active,
  );
}

export function clearSquare(id: string) {
  const cell = cellById(id);
  if (!hasContent(cell)) return;
  const before = snapshot(cell);
  editCell(id, CLEARED);
  toast(cell.slot === -1 ? "Pillar cleared" : "Square cleared", {
    action: { label: "Undo", run: () => editCell(id, before) },
  });
}

export function toggleDone(cell: Cell) {
  const done = cell.status !== "done";
  const before: CellPatch = { status: cell.status, progress: cell.progress, doneAt: cell.doneAt };
  editCell(cell.id, { status: done ? "done" : "todo" });
  toast(done ? "Marked done" : "Marked not done", {
    action: { label: "Undo", run: () => editCell(cell.id, before) },
  });
}

export function toggleToday(cell: Cell, today: string, checked: boolean) {
  setCheckin(cell.id, today, !checked);
  toast(checked ? "Unchecked for today" : "Done for today", {
    action: { label: "Undo", run: () => setCheckin(cell.id, today, checked) },
  });
}

export function toggleWeek(cell: Cell, options: { quiet?: boolean } = {}) {
  const on = !cell.active;
  const before: CellPatch = {
    active: cell.active,
    activatedAt: cell.active ? cell.activatedAt : null,
    status: cell.status,
    progress: cell.progress,
  };
  editCell(cell.id, { active: on });
  if (options.quiet) return;
  toast(on ? "Added to this week" : "Removed from this week", {
    action: { label: "Undo", run: () => editCell(cell.id, before) },
  });
}

/** Habits have no "doing": switching one over starts it fresh. */
export function setKind(cell: Cell, kind: CellKind) {
  if (cell.kind === kind) return;
  editCell(cell.id, kind === "habit" && cell.status === "doing" ? { kind, status: "todo" } : { kind });
}

export function suggestionPatch(suggestion: Suggestion): CellPatch {
  const patch: CellPatch = { text: suggestion.text.trim().slice(0, 200) };
  if (suggestion.kind) patch.kind = suggestion.kind;
  return patch;
}

/**
 * Puts picked suggestions into empty squares, in the order given (clockwise).
 * Returns the ids it filled. Several at once get an Undo.
 */
export function fillSquares(empty: Cell[], picks: Suggestion[], plural: string): string[] {
  const count = Math.min(empty.length, picks.length);
  if (!count) return [];
  const targets = empty.slice(0, count);
  const before = targets.map((cell) => ({ id: cell.id, patch: snapshot(cell) }));
  editCells(targets.map((cell, i) => ({ id: cell.id, patch: suggestionPatch(picks[i]) })));
  if (count > 1) {
    toast(`Added ${count} ${plural}`, { action: { label: "Undo", run: () => editCells(before) } });
  }
  return targets.map((cell) => cell.id);
}

/** A short, plain message for a failed AI call. */
export function aiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.offline) return "You're offline. Try again when you're back.";
  return error instanceof Error && error.message ? error.message : fallback;
}
