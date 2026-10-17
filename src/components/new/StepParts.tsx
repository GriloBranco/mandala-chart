"use client";

import { ChevronLeft } from "lucide-react";
import type { PointerEvent, ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { useViewport } from "./viewport";

/** Stops a tap from taking focus away from the input, so the phone keyboard stays up. */
export function keepFocus(event: PointerEvent) {
  event.preventDefault();
}

/**
 * The scrolling middle of a step. While typing on a phone it stops scrolling and lets the
 * step lay out the grid and input to fit above the keyboard.
 */
export function StepBody({ typing = false, children }: { typing?: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        "min-h-0 flex-1",
        typing ? "flex flex-col overflow-hidden" : "overflow-y-auto overscroll-contain",
      )}
    >
      {children}
    </div>
  );
}

/** The thumb zone at the bottom: Back / Next and a line of status. */
export function Dock({ children }: { children: ReactNode }) {
  const { keyboard } = useViewport();
  return (
    <div
      className={cn(
        "flex-none border-t border-line bg-bg px-4 pt-3",
        keyboard ? "pb-3" : "pb-[max(12px,var(--safe-bottom))]",
      )}
    >
      <div className="mx-auto w-full max-w-[560px]">{children}</div>
    </div>
  );
}

export function NavRow({ onBack, children }: { onBack?: () => void; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      {onBack && (
        <Button variant="secondary" size="lg" icon={<ChevronLeft size={18} />} onClick={onBack} className="pr-5 pl-3.5">
          Back
        </Button>
      )}
      <div className="flex min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function StepHeading({ title, sub, className }: { title: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cn("animate-rise", className)}>
      <h1 className="text-[24px] leading-tight font-semibold tracking-tight text-balance sm:text-[28px]">{title}</h1>
      {sub && <p className="mt-2 text-[15px] leading-relaxed text-muted">{sub}</p>}
    </div>
  );
}

export const LABEL = "font-mono text-[10.5px] tracking-[0.14em] text-faint";
