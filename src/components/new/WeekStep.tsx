"use client";

import { useEffect, useState } from "react";
import { AsciiSpinner } from "@/components/ascii/AsciiSpinner";
import { getLeverageRun, startLeverage, useLeverageRun } from "@/components/lever/leverage-run";
import { SectionLabel } from "@/components/lever/parts";
import { PickRow, PickSummary, WeekPicker } from "@/components/lever/WeekPicker";
import { filledActions, leverSig, ratingPatches, readAnalysis } from "@/components/lever/week";
import { Button } from "@/components/ui/Button";
import { actions, goalById, useAppState } from "@/lib/store";
import type { Cell, CellPatch, GoalWithCells } from "@/lib/types";
import { Dock, NavRow, StepBody, StepHeading } from "./StepParts";
import { readWeekPicks, writeWeekPicks } from "./text";

/**
 * Step 4: start small. With AI on it ranks the chart once and pre-picks 5-8 (one per
 * pillar, synergies first); you can swap any of them. Nothing goes to the chart until Finish.
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
  const { aiEnabled } = useAppState();
  const run = useLeverageRun(goal.id);
  const sig = leverSig(goal);
  const filled = filledActions(goal);
  const open = filled.filter((c) => c.status !== "done");
  const hasActions = open.length > 0;

  // Ask once per version of the chart; going back to edit actions asks again.
  useEffect(() => {
    if (!aiEnabled || !hasActions) return;
    const current = getLeverageRun(goal.id);
    if (current && current.sig === sig) return;
    startLeverage(goal.id, sig);
  }, [aiEnabled, hasActions, goal.id, sig]);

  // What was already picked when the step opened (coming back to it, or redoing week 1).
  const [initial] = useState(() => new Set(filled.filter((c) => c.active && c.status !== "done").map((c) => c.id)));
  // Your own choices, once you touch the list. Until then the AI picks (if any) are shown.
  // They are kept on this device until Finish, so Back, a step dot or closing keeps them,
  // unless the active actions changed somewhere else since (that change is newer).
  const [manual, setManual] = useState<Set<string> | null>(() => {
    const saved = readWeekPicks(goal.id);
    if (!saved || saved.active.length !== initial.size || !saved.active.every((id) => initial.has(id))) return null;
    const openIds = new Set(open.map((c) => c.id));
    return new Set(saved.picks.filter((id) => openIds.has(id)));
  });
  const [showAll, setShowAll] = useState(false);

  const fresh = run && run.sig === sig ? run : null;
  const read = fresh?.status === "ready" && fresh.data ? readAnalysis(goal, fresh.data) : null;
  const aiPicks = read?.picks ?? [];
  const preselect = initial.size === 0 && aiPicks.length > 0;
  const picked = manual ?? (preselect ? new Set(aiPicks) : initial);
  const suggested = new Set(aiPicks.filter((id) => !picked.has(id)));
  const loading = aiEnabled && hasActions && (!fresh || fresh.status === "loading");
  const failed = fresh?.status === "error";
  const listOpen = showAll || !aiEnabled || failed || (read !== null && aiPicks.length === 0);

  const byId = new Map(filled.map((c) => [c.id, c]));
  const pickedCells = [...picked].map((id) => byId.get(id)).filter((c): c is Cell => Boolean(c));
  const reasons = new Map([...(read?.actions ?? [])].map(([id, a]) => [id, a.reason]));
  const synergy = (cell: Cell) => read?.actions.get(cell.id)?.helps ?? cell.helps;

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
    const patches = new Map<string, CellPatch>();
    const add = (id: string, patch: CellPatch) => patches.set(id, { ...patches.get(id), ...patch });
    for (const cell of filledActions(current)) {
      if (cell.status === "done") continue;
      const want = picked.has(cell.id);
      if (want !== cell.active) add(cell.id, { active: want });
    }
    // Keep the AI ratings too (only where you have not rated), so the chart shows its lever.
    if (read) for (const { id, patch } of ratingPatches(current, read, "fill")) add(id, patch);
    if (patches.size) actions.updateCells([...patches].map(([id, patch]) => ({ id, patch })));
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
            <>
              {loading && (
                <div className="mt-7 flex items-center gap-3.5 rounded-2xl border border-line px-4 py-3.5 animate-fade-in">
                  <AsciiSpinner size="md" label="Ranking your actions" />
                  <div className="min-w-0">
                    <p className="text-sm">Finding your highest-leverage actions…</p>
                    <p className="text-xs text-muted">One per pillar, synergies first.</p>
                  </div>
                </div>
              )}

              {failed && (
                <div className="mt-7 rounded-2xl border border-line px-4 py-3.5 animate-fade-in">
                  <p className="text-sm text-muted">{fresh?.error} Pick by hand below.</p>
                  <Button size="sm" variant="secondary" className="mt-2.5" onClick={() => startLeverage(goal.id, sig)}>
                    Try again
                  </Button>
                </div>
              )}

              {read && aiPicks.length > 0 && (
                <section className="mt-7 animate-rise" aria-labelledby="week-suggested">
                  {read.insight && (
                    <div className="rounded-2xl bg-soft px-4 py-3.5">
                      <SectionLabel>THE LEVER</SectionLabel>
                      <p className="mt-1 text-[15px] leading-snug">{read.insight}</p>
                    </div>
                  )}
                  <div className="mt-6 flex items-center gap-2">
                    <SectionLabel id="week-suggested" className="flex-1">
                      SUGGESTED · {aiPicks.length}
                    </SectionLabel>
                    {suggested.size > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => choose(new Set([...picked, ...aiPicks]))}
                      >
                        Pick all
                      </Button>
                    )}
                  </div>
                  <ul className="mt-1 divide-y divide-line">
                    {aiPicks.map((id) => {
                      const cell = byId.get(id);
                      if (!cell) return null;
                      return (
                        <PickRow
                          key={id}
                          goal={goal}
                          cell={cell}
                          picked={picked.has(id)}
                          suggested={!picked.has(id)}
                          onToggle={(next) => toggle(cell, next)}
                          reason={reasons.get(id)}
                          synergy={synergy(cell)}
                          pillarTag
                        />
                      );
                    })}
                  </ul>
                </section>
              )}

              <section className="mt-8" aria-labelledby="week-all">
                {listOpen ? (
                  <>
                    <SectionLabel id="week-all">{read && aiPicks.length ? "ALL ACTIONS" : "YOUR ACTIONS"}</SectionLabel>
                    <WeekPicker
                      className="mt-3"
                      goal={goal}
                      picked={picked}
                      suggested={suggested}
                      onToggle={toggle}
                      reasons={reasons}
                      synergy={synergy}
                    />
                  </>
                ) : (
                  <Button variant="secondary" className="w-full" onClick={() => setShowAll(true)}>
                    {loading ? "Pick by hand" : `Show all ${open.length} actions`}
                  </Button>
                )}
              </section>
            </>
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
