"use client";

import { useEffect, useState } from "react";
import { cn } from "@/components/ui/cn";
import { useReducedMotion } from "@/components/ui/hooks";

// A 3x3 mandala in glyphs: a light runs clockwise around the 8 pillars, the center glows.
const RING = [1, 2, 5, 8, 7, 6, 3, 0];
const RAMP = ["·", ":", "+", "*", "#"];
const SIZES = { sm: "text-[6px] leading-[6px] tracking-[0.5px]", md: "text-[9px] leading-[9px] tracking-[1px]", lg: "text-[14px] leading-[14px] tracking-[2px]" };

export function AsciiSpinner({
  size = "md",
  label = "Working",
  className,
}: {
  size?: keyof typeof SIZES;
  label?: string;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (reduced) return;
    const id = setInterval(() => setTick((t) => (t + 1) % 8), 95);
    return () => clearInterval(id);
  }, [reduced]);

  const glyphs = Array.from({ length: 9 }, (_, position) => {
    if (position === 4) return reduced ? "*" : RAMP[2 + (tick % 2)];
    const index = RING.indexOf(position);
    const distance = (tick - index + 8) % 8; // 0 = head of the light
    return RAMP[Math.max(0, 4 - distance)];
  });

  return (
    <span role="status" aria-label={label} className={cn("inline-block font-mono select-none", SIZES[size], className)}>
      <span aria-hidden className="grid grid-cols-3 text-center">
        {glyphs.map((glyph, i) => (
          <span key={i}>{glyph}</span>
        ))}
      </span>
    </span>
  );
}
