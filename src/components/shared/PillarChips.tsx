"use client";

import { isFilled, pillarCell } from "@/lib/mandala";
import type { GoalWithCells } from "@/lib/types";
import { cn } from "@/components/ui/cn";

/**
 * Pick other pillars this square also helps (an action's synergy, or which pillars
 * a pillar makes easier). Only named pillars are shown.
 */
export function PillarChips({
  goal,
  exclude,
  value,
  onChange,
  className,
}: {
  goal: GoalWithCells;
  /** The square's own pillar, which it cannot "also help". */
  exclude: number;
  value: number[];
  onChange: (next: number[]) => void;
  className?: string;
}) {
  const pillars = Array.from({ length: 8 }, (_, p) => ({ index: p, cell: pillarCell(goal, p) })).filter(
    (p) => p.index !== exclude && isFilled(p.cell),
  );
  if (!pillars.length) return <p className="text-xs text-faint">Name more pillars first.</p>;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {pillars.map(({ index, cell }) => {
        const on = value.includes(index);
        return (
          <button
            key={index}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((v) => v !== index) : [...value, index].sort())}
            className={cn(
              "max-w-full truncate rounded-full border px-3 py-1.5 text-[13px] transition-colors",
              on ? "border-fg bg-fg text-white" : "border-line-strong text-muted hover:border-fg hover:text-fg",
            )}
          >
            {cell?.text}
          </button>
        );
      })}
    </div>
  );
}
