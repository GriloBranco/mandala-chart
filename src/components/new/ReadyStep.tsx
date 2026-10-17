"use client";

import type { ReactNode } from "react";
import { Block3x3, Square } from "@/components/shared/Square";
import { filledActions, topLeverPillar } from "@/components/lever/week";
import { Button } from "@/components/ui/Button";
import { useReducedMotion } from "@/components/ui/hooks";
import { fillCounts, pillarCell, ringIndex, statusGlyph } from "@/lib/mandala";
import type { GoalWithCells } from "@/lib/types";
import { actionAt } from "./slots";
import { Dock, StepBody } from "./StepParts";

/** The end of the flow: your whole chart blooms in, center first, then clockwise. */
export function ReadyStep({ goal, onOpen }: { goal: GoalWithCells; onOpen: () => void }) {
  const reduced = useReducedMotion();
  const counts = fillCounts(goal);
  const week = filledActions(goal).filter((c) => c.active && c.status !== "done").length;
  const summary = [
    `${counts.pillars} ${counts.pillars === 1 ? "pillar" : "pillars"}`,
    `${counts.actions} ${counts.actions === 1 ? "action" : "actions"}`,
    week ? `${week} this week` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <StepBody>
        <div className="mx-auto flex w-full max-w-[560px] flex-col items-center px-6 pt-10 pb-10 text-center sm:pt-14">
          <div role="img" aria-label={`Your chart: ${summary}`} className="w-full max-w-[340px]">
            <ChartMap goal={goal} bloom={!reduced} />
          </div>
          <div className="animate-rise" style={reduced ? undefined : { animationDelay: "650ms" }}>
            <h1 className="mt-10 text-[26px] leading-tight font-semibold tracking-tight">Your chart is ready</h1>
            <p className="mt-2 font-mono text-xs text-muted">{summary}</p>
            <p className="mx-auto mt-6 max-w-[34ch] text-[15px] leading-relaxed text-muted">
              Report how it goes each day. Each week, add <span className="whitespace-nowrap">5-8</span> more in
              Leverage.
            </p>
          </div>
        </div>
      </StepBody>
      <Dock>
        <Button variant="primary" size="lg" className="w-full" onClick={onOpen}>
          Open chart
        </Button>
      </Dock>
    </>
  );
}

/** The 9x9 as glyphs. Decorative here (inert): the button below opens the real chart. */
function ChartMap({ goal, bloom }: { goal: GoalWithCells; bloom: boolean }) {
  const top = topLeverPillar(goal);
  return (
    <div className="grid grid-cols-3 gap-2" inert>
      {Array.from({ length: 9 }, (_, block) => {
        const pillar = block === 4 ? null : ringIndex(block);
        const order = pillar === null ? 0 : pillar + 1;
        return (
          <div
            key={block}
            className={bloom ? "animate-zoom" : undefined}
            style={bloom ? { animationDelay: `${order * 70}ms` } : undefined}
          >
            <Block3x3 gap="map">{blockSquares(goal, pillar, top)}</Block3x3>
          </div>
        );
      })}
    </div>
  );
}

function blockSquares(goal: GoalWithCells, pillar: number | null, top: number | null): ReactNode[] {
  return Array.from({ length: 9 }, (_, position) => {
    if (pillar === null) {
      if (position === 4) return <Square key={position} role="goal" text={goal.title} size="map" />;
      const p = ringIndex(position);
      return (
        <Square key={position} role="pillar" text={pillarCell(goal, p)?.text ?? ""} size="map" lever={p === top} />
      );
    }
    if (position === 4) {
      return (
        <Square
          key={position}
          role="pillar"
          text={pillarCell(goal, pillar)?.text ?? ""}
          size="map"
          lever={pillar === top}
        />
      );
    }
    const cell = actionAt(goal, pillar, ringIndex(position));
    return (
      <Square
        key={position}
        role="action"
        text={cell?.text ?? ""}
        size="map"
        glyph={cell ? statusGlyph(cell) : undefined}
      />
    );
  });
}
