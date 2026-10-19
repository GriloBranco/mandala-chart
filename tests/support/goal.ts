import { PILLAR_SLOT } from "@/domain/mandala";
import type { Cell, GoalWithCells } from "@/domain/types";

/** A goal with all 72 squares, some pillars and actions named, for tests that need no database. */
export function sampleGoal(): GoalWithCells {
  const cells: Cell[] = [];
  const pillars = ["Reading habit", "Book list", "Focus", "Time", "", "", "", ""];
  for (let pillar = 0; pillar < 8; pillar++) {
    for (let slot = PILLAR_SLOT; slot < 8; slot++) {
      const named = slot === PILLAR_SLOT ? pillars[pillar] : pillar < 2 && slot < 3 ? `Action ${pillar + 1}.${slot + 1}` : "";
      cells.push({
        id: `cell-${pillar}-${slot}`,
        goalId: "goal-1",
        pillar,
        slot,
        text: named,
        notes: "",
        kind: slot === 0 ? "habit" : "task",
        repeat: "day",
        repeatOn: null,
        status: "todo",
        progress: 0,
        impact: slot === 1 ? 3 : null,
        effort: slot === 1 ? 1 : null,
        helps: [],
        active: slot === 0,
        activatedAt: slot === 0 ? "2026-03-01T08:00:00.000Z" : null,
        doneAt: null,
        updatedAt: "2026-03-01T08:00:00.000Z",
      });
    }
  }
  return {
    id: "goal-1",
    title: "By June 2027, I will read 20 books",
    why: "To think better",
    deadline: "2027-06-30",
    status: "active",
    position: 0,
    createdAt: "2026-03-01T08:00:00.000Z",
    updatedAt: "2026-03-01T08:00:00.000Z",
    cells,
  };
}
