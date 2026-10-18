"use client";

import { useRef, type ReactNode } from "react";
import { Block3x3, Square } from "@/components/shared/Square";
import { cn } from "@/components/ui/cn";
import { ringIndex } from "@/domain/mandala";

export interface RingSquare {
  text: string;
  label: string;
  glyph?: string;
}

/**
 * One 3x3 block of the chart: a center and 8 squares around it (ring index 0-7 clockwise
 * from 12 o'clock). Tapping never takes focus from the input below it, so the keyboard
 * stays up while you move between squares. Optional horizontal swipe.
 */
export function FocusGrid({
  center,
  centerRole,
  centerLabel,
  ring,
  ringRole,
  selected,
  onSelect,
  onCenter,
  onSwipe,
  compact = false,
  className,
}: {
  center: string;
  centerRole: "goal" | "pillar";
  centerLabel: string;
  ring: RingSquare[];
  ringRole: "pillar" | "action";
  selected: number | null;
  onSelect: (index: number) => void;
  onCenter?: () => void;
  /** 1 = swiped left (next), -1 = swiped right (previous). */
  onSwipe?: (direction: 1 | -1) => void;
  /** Smaller text and gaps, for the small grid above the phone keyboard. */
  compact?: boolean;
  className?: string;
}) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const swiped = useRef(false);
  const size = compact ? "grid" : "focus";

  const squares: ReactNode[] = Array.from({ length: 9 }, (_, position) => {
    if (position === 4) {
      // The goal is a whole sentence: it gets its own text that shrinks to fit the square.
      return centerRole === "goal" ? (
        <Square key="center" role="goal" text="" size={size} label={centerLabel} onClick={onCenter}>
          <GoalText text={center} />
        </Square>
      ) : (
        <Square key="center" role={centerRole} text={center} size={size} label={centerLabel} onClick={onCenter} />
      );
    }
    const index = ringIndex(position);
    const square = ring[index];
    return (
      <Square
        key={index}
        role={ringRole}
        text={square?.text ?? ""}
        placeholder="+"
        size={size}
        glyph={square?.glyph}
        selected={selected === index}
        label={square?.label}
        onClick={() => onSelect(index)}
      />
    );
  });

  return (
    <div
      className={cn(onSwipe && "touch-pan-y", className)}
      onPointerDown={(event) => {
        event.preventDefault();
        start.current = { x: event.clientX, y: event.clientY };
        swiped.current = false;
      }}
      onPointerUp={(event) => {
        const from = start.current;
        start.current = null;
        if (!from || !onSwipe) return;
        const dx = event.clientX - from.x;
        const dy = event.clientY - from.y;
        if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          swiped.current = true;
          onSwipe(dx < 0 ? 1 : -1);
        }
      }}
      onPointerCancel={() => {
        start.current = null;
      }}
      onClickCapture={(event) => {
        // A swipe that ends on a square is not a tap on it.
        if (!swiped.current) return;
        swiped.current = false;
        event.stopPropagation();
        event.preventDefault();
      }}
    >
      <Block3x3 gap={size}>{squares}</Block3x3>
    </div>
  );
}

/** The goal sentence, sized to the square (container units) and clamped to 5 lines. */
function GoalText({ text }: { text: string }) {
  const length = text.trim().length;
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0 flex items-center justify-center p-2 [container-type:inline-size]"
    >
      <span
        className={cn(
          "line-clamp-5 min-w-0 text-center leading-[1.2] font-semibold break-words",
          length <= 24
            ? "text-[clamp(11px,16cqw,17px)]"
            : length <= 48
              ? "text-[clamp(10px,14cqw,16px)]"
              : "text-[clamp(10px,12.5cqw,15px)]",
        )}
      >
        {text}
      </span>
    </span>
  );
}
