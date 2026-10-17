"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/components/ui/cn";

const ROWS = 5;
const GLYPHS = [" ", "·", ":", "+", "#"];

/**
 * Live microphone level as a scrolling ASCII waveform, mirrored around the middle row.
 * Writes straight to the DOM each frame, so React never re-renders while recording.
 */
export function AsciiLevelMeter({
  analyser,
  columns = 32,
  className,
}: {
  analyser: AnalyserNode | null;
  columns?: number;
  className?: string;
}) {
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const history = new Array<number>(columns).fill(0);
    const render = () => {
      const half = (ROWS - 1) / 2;
      let out = "";
      for (let row = 0; row < ROWS; row++) {
        const distance = Math.abs(row - half);
        for (const level of history) {
          const amount = level * (half + 1) - distance; // how far the bar reaches past this row
          out += amount <= 0 ? (row === half ? "·" : " ") : GLYPHS[Math.min(GLYPHS.length - 1, 1 + Math.floor(amount * 3))];
        }
        if (row < ROWS - 1) out += "\n";
      }
      node.textContent = out;
    };
    render();
    if (!analyser) return;

    const data = new Uint8Array(analyser.fftSize);
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 60) return;
      last = now;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const value of data) {
        const x = (value - 128) / 128;
        sum += x * x;
      }
      const rms = Math.sqrt(sum / data.length);
      history.shift();
      history.push(Math.min(1, rms * 5));
      render();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [analyser, columns]);

  return (
    <pre
      ref={ref}
      aria-hidden
      className={cn("font-mono text-[13px] leading-[13px] tracking-[1px] text-fg select-none", className)}
    />
  );
}
