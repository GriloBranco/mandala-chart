import { describe, expect, it } from "vitest";
import {
  actionLever,
  addDays,
  gridCoord,
  habitStrength,
  normalizePatch,
  pillarLever,
  ringIndex,
  ringPosition,
} from "@/domain/mandala";
import type { Cell } from "@/domain/types";

function cell(overrides: Partial<Cell> = {}): Cell {
  return {
    id: "c1",
    goalId: "g1",
    pillar: 0,
    slot: 0,
    text: "Run 5 km",
    notes: "",
    kind: "task",
    repeat: "day",
    repeatOn: null,
    status: "todo",
    progress: 0,
    impact: null,
    effort: null,
    helps: [],
    active: false,
    activatedAt: null,
    doneAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("chart geometry", () => {
  it("places pillars clockwise from 12 o'clock around the center", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(ringPosition)).toEqual([1, 2, 5, 8, 7, 6, 3, 0]);
    expect(ringIndex(4)).toBe(-1);
    expect(ringIndex(ringPosition(5))).toBe(5);
  });

  it("maps a block and a position to the 9x9 grid", () => {
    expect(gridCoord(4, 4)).toEqual({ row: 4, col: 4 });
    expect(gridCoord(0, 0)).toEqual({ row: 0, col: 0 });
    expect(gridCoord(8, 8)).toEqual({ row: 8, col: 8 });
  });
});

describe("status rules", () => {
  it("makes done mean 100%", () => {
    expect(normalizePatch(cell(), { status: "done" })).toEqual({ status: "done", progress: 100 });
  });

  it("moves a task to doing when progress starts", () => {
    expect(normalizePatch(cell(), { progress: 40 })).toEqual({ progress: 40, status: "doing" });
  });

  it("starts a finished task again when it is picked for a new week", () => {
    const before = cell({ status: "done", progress: 100 });
    expect(normalizePatch(before, { active: true })).toMatchObject({ active: true, status: "todo", progress: 0 });
  });

  it("starts a habit fresh", () => {
    expect(normalizePatch(cell({ status: "doing", progress: 50 }), { kind: "habit" })).toMatchObject({
      status: "todo",
      progress: 0,
    });
  });
});

describe("leverage", () => {
  it("is empty until impact is rated", () => {
    expect(pillarLever(cell())).toBeNull();
    expect(actionLever(cell())).toBeNull();
  });

  it("rewards impact, ease and helping other pillars", () => {
    expect(actionLever(cell({ impact: 3, effort: 1, helps: [2] }))).toBe(3 * 3 * 2);
    expect(pillarLever(cell({ slot: -1, impact: 2, helps: [1, 2] }))).toBe(6);
  });
});

describe("habit strength", () => {
  it("grows with check-ins and forgives a missed day", () => {
    const today = "2026-03-30";
    const days = Array.from({ length: 14 }, (_, i) => addDays(today, -i));
    const all = days.map((day) => ({ cellId: "h", goalId: "g", day }));
    const missedOne = all.filter((c) => c.day !== addDays(today, -1));
    expect(habitStrength("h", [], today)).toBe(0);
    expect(habitStrength("h", all, today)).toBeCloseTo(1, 5);
    expect(habitStrength("h", missedOne, today)).toBeGreaterThan(0.8);
  });
});
