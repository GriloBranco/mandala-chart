import { cn } from "@/components/ui/cn";

export type MiniFill = "strong" | "mid" | "soft" | "line";

/**
 * A 3x3 block in miniature (row-major, 9 entries): where you are in the chart.
 * strong = here, mid = the block's center, soft = filled, line = empty.
 */
export function Mini3x3({ fills, size = 20, className }: { fills: MiniFill[]; size?: number; className?: string }) {
  const cell = size / 3.4;
  const gap = (size - cell * 3) / 2;
  const radius = cell * 0.22;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className={cn("shrink-0", className)}>
      {fills.map((fill, position) => {
        const x = (position % 3) * (cell + gap);
        const y = Math.floor(position / 3) * (cell + gap);
        if (fill === "line") {
          return (
            <rect
              key={position}
              x={x + 0.5}
              y={y + 0.5}
              width={cell - 1}
              height={cell - 1}
              rx={radius}
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
            rx={radius}
            fill={fill === "soft" ? "var(--line-strong)" : "var(--fg)"}
            opacity={fill === "mid" ? 0.35 : 1}
          />
        );
      })}
    </svg>
  );
}
