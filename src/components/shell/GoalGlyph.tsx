"use client";

import { RING } from "@/lib/mandala";
import { cn } from "@/components/ui/cn";

/**
 * The chart in miniature: the goal in the middle (solid) and 8 pillars around it,
 * each filled by its progress (0-1). Unfilled pillars are drawn as faint outlines.
 */
export function GoalGlyph({
  pillars,
  size = 18,
  className,
}: {
  /** Progress 0-1 per pillar, or null for an empty pillar. Index 0-7 clockwise from 12 o'clock. */
  pillars: (number | null)[];
  size?: number;
  className?: string;
}) {
  const cell = size / 3.4;
  const gap = (size - cell * 3) / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className={cn("shrink-0", className)}>
      {Array.from({ length: 9 }, (_, position) => {
        const x = (position % 3) * (cell + gap);
        const y = Math.floor(position / 3) * (cell + gap);
        if (position === 4) {
          return <rect key={position} x={x} y={y} width={cell} height={cell} rx={cell * 0.18} fill="var(--fg)" />;
        }
        const value = pillars[RING.indexOf(position as (typeof RING)[number])];
        if (value === null || value === undefined) {
          return (
            <rect
              key={position}
              x={x + 0.5}
              y={y + 0.5}
              width={cell - 1}
              height={cell - 1}
              rx={cell * 0.18}
              fill="none"
              stroke="var(--line-strong)"
            />
          );
        }
        return (
          <rect
            key={position}
            x={x}
            y={y}
            width={cell}
            height={cell}
            rx={cell * 0.18}
            fill="var(--fg)"
            opacity={0.14 + 0.86 * value}
          />
        );
      })}
    </svg>
  );
}
