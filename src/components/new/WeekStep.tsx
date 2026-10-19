"use client";

import { useState } from "react";
import { SectionLabel } from "@/components/lever/parts";
import { PickSummary, WeekPicker } from "@/components/lever/WeekPicker";
import { filledActions } from "@/domain/week";
import { Button } from "@/components/ui/Button";
import { actions, goalById } from "@/client/store";
import type { Cell, CellPatch, GoalWithCells } from "@/domain/types";
import { Dock, NavRow, StepBody, StepHeading } from "./StepParts";
import { readWeekPicks, writeWeekPicks } from "./text";

/**
 * Step 4: start small. Pick 5-8 actions for this week (one per pillar if you can).
 * Nothing goes to the chart until Finish.
 */
export function WeekStep({
  goal,
  onBack,
  onFinish,
}: {
  goal: GoalWithCells;
  onBack: () => void;
  onFinish: () => void;
}) {
  const filled = filledActions(goal);
  const open = filled.filter((c) => c.status !== "done");
  const hasActions = open.length > 0;

  // What was already picked when the step opened (coming back to it, or redoing week 1).
  const [initial] = useState(() => new Set(filled.filter((c) => c.active && c.status !== "done").map((c) => c.id)));
  // Your own choices, once you touch the list. They are kept on this device until Finish, so
  // Back, a step dot or closing keeps them, unless the active actions changed somewhere else
  // since (that change is newer).
  const [manual, setManual] = useState<Set<string> | null>(() => {
    const saved = readWeekPicks(goal.id);
    if (!saved || saved.active.length !== initial.size || !saved.active.every((id) => initial.has(id))) return null;
    const openIds = new Set(open.map((c) => c.id));
    return new Set(saved.picks.filter((id) => openIds.has(id)));
  });

  const picked = manual ?? initial;
  const byId = new Map(filled.map((c) => [c.id, c]));
  const pickedCells = [...picked].map((id) => byId.get(id)).filter((c): c is Cell => Boolean(c));

  const choose = (next: Set<string>) => {
    setManual(next);
    writeWeekPicks(goal.id, { active: [...initial], picks: [...next] });
  };

  const toggle = (cell: Cell, next: boolean) => {
    const base = new Set(picked);
    if (next) base.add(cell.id);
    else base.delete(cell.id);
    choose(base);
  };

  const finish = () => {
    const current = goalById(goal.id) ?? goal;
    const patches: { id: string; patch: CellPatch }[] = [];
    for (const cell of filledActions(current)) {
      if (cell.status === "done") continue;
      const want = picked.has(cell.id);
      if (want !== cell.active) patches.push({ id: cell.id, patch: { active: want } });
    }
    if (patches.length) actions.updateCells(patches);
    writeWeekPicks(goal.id, null);
    onFinish();
  };

  return (
    <>
      <StepBody>
        <div className="mx-auto w-full max-w-[560px] px-4 pt-6 pb-10">
          <StepHeading
            title={
              <>
                Start small: pick <span className="whitespace-nowrap">5-8</span> for this week
              </>
            }
            sub="Take one from each pillar if you can. Actions that help two pillars at once are the strongest."
          />

          {!hasActions ? (
            <div className="mt-8 rounded-2xl border border-dashed border-line-strong px-5 py-7 text-center">
              <p className="text-[15px] font-semibold tracking-tight">No actions yet</p>
              <p className="mt-1 text-sm text-muted">Write a few, or finish now and fill the chart later.</p>
              <Button variant="secondary" className="mt-4" onClick={onBack}>
                Add actions
              </Button>
            </div>
          ) : (
            <section className="mt-8" aria-labelledby="week-all">
              <SectionLabel id="week-all">YOUR ACTIONS</SectionLabel>
              <WeekPicker className="mt-3" goal={goal} picked={picked} onToggle={toggle} />
            </section>
          )}
        </div>
      </StepBody>

      <Dock>
        {hasActions && <PickSummary goal={goal} picks={pickedCells} className="mb-3" />}
        <NavRow onBack={onBack}>
          <Button variant="primary" size="lg" className="w-full" onClick={finish}>
            Finish
          </Button>
        </NavRow>
      </Dock>
    </>
  );
}
