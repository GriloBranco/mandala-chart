"use client";

import { useMemo, useRef } from "react";
import { dayKey, gridCoord, isFilled, ringIndex } from "@/domain/mandala";
import { navigate } from "@/client/nav";
import { useAppState } from "@/client/store";
import type { GoalWithCells } from "@/domain/types";
import { Block3x3, Square } from "@/components/shared/Square";
import { useChangeFlash } from "./flash";
import { cellAt, glyphsFor, indexGoal, initialOf, leverPillar, pillarName, squareAt } from "./model";
import { GlyphLegend } from "./parts";

const MAP_SIZE = "min(480px, max(270px, calc(100dvh - 280px)))";

/** Phone: the whole 9x9 as glyphs. Tap a block to open it. */
export function MapView({ goal }: { goal: GoalWithCells }) {
  const { checkins } = useAppState();
  const today = dayKey();
  const index = useMemo(() => indexGoal(goal), [goal]);
  const glyphs = useMemo(() => glyphsFor(goal, checkins, today), [goal, checkins, today]);
  const lever = leverPillar(index);
  const rootRef = useRef<HTMLDivElement>(null);

  useChangeFlash(rootRef, goal, checkins, glyphs, today, null);

  const open = (block: number) =>
    navigate({ name: "goal", goalId: goal.id, pillar: block === 4 ? null : ringIndex(block), map: false });

  return (
    <div className="mx-auto w-full max-w-[560px] px-4 pt-5 pb-10">
      <div
        ref={rootRef}
        role="group"
        aria-label="Whole chart"
        className="mx-auto grid animate-fade-in grid-cols-3 gap-2.5"
        style={{ maxWidth: MAP_SIZE }}
      >
        {Array.from({ length: 9 }, (_, block) => {
          const pillar = block === 4 ? null : ringIndex(block);
          const named = pillar === null || isFilled(index.pillars[pillar]);
          const name = pillar === null ? "the goal and its pillars" : pillarName(index, pillar);
          return (
            <Block3x3 key={block} gap="map">
              {Array.from({ length: 9 }, (_, position) => {
                const ref = squareAt(gridCoord(block, position));
                const cell = cellAt(index, ref);
                const text = ref.role === "goal" ? goal.title : (cell?.text ?? "");
                const glyph =
                  ref.role === "pillar"
                    ? isFilled(cell)
                      ? initialOf(cell.text)
                      : undefined
                    : ref.role === "action" && cell
                      ? glyphs.get(cell.id)
                      : undefined;
                return (
                  <div key={position} data-cell={cell?.id}>
                    <Square
                      role={ref.role}
                      size="map"
                      text={text}
                      glyph={glyph}
                      lever={ref.role === "pillar" && ref.pillar === lever}
                      dim={ref.role === "action" && !named}
                      label={`Open ${name}`}
                      onClick={() => open(block)}
                    />
                  </div>
                );
              })}
            </Block3x3>
          );
        })}
      </div>
      <GlyphLegend className="mt-6 justify-center" />
      <p className="mt-2 text-center text-xs text-faint">Tap a block to open it.</p>
    </div>
  );
}
