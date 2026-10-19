"use client";

import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

/**
 * The round "this week" toggle. Picked is filled with the accent (the chart's this-week
 * marker).
 */
export function PickToggle({
  picked,
  done = false,
  label,
  onChange,
  className,
}: {
  picked: boolean;
  done?: boolean;
  label: string;
  onChange: (next: boolean) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done || picked}
      aria-label={done ? `${label} (done)` : label}
      title={done ? "Done" : picked ? "Picked for this week" : "Add to this week"}
      disabled={done}
      onClick={() => onChange(!picked)}
      className={cn("group grid size-11 shrink-0 place-items-center rounded-full disabled:cursor-default", className)}
    >
      <span
        aria-hidden
        className={cn(
          "grid size-6 place-items-center rounded-full border-[1.5px] transition-all duration-150 group-active:scale-90",
          done
            ? "border-line-strong bg-line-strong text-white"
            : picked
              ? "border-accent bg-accent text-white"
              : "border-line-strong text-transparent group-hover:border-fg",
        )}
      >
        <Check size={14} strokeWidth={3} />
      </span>
    </button>
  );
}

/** Thin lever score bar. Unrated shows an empty track. */
export function LeverBar({
  score,
  scale,
  accent = false,
  className,
}: {
  score: number | null;
  scale: number;
  accent?: boolean;
  className?: string;
}) {
  const pct = score === null ? 0 : Math.round(Math.min(1, score / scale) * 100);
  return (
    <span
      className={cn("flex w-14 shrink-0 items-center", className)}
      title={score === null ? "Not rated yet" : `Lever score ${score}`}
    >
      <span className="relative block h-[3px] w-full overflow-hidden rounded-full bg-line" aria-hidden>
        <span
          className={cn(
            "absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out",
            accent ? "bg-accent" : "bg-fg",
          )}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="sr-only">{score === null ? "Not rated yet" : `Lever score ${score}`}</span>
    </span>
  );
}

export function LeverTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border border-accent px-1.5 py-px font-mono text-[10px] leading-4 tracking-[0.12em] text-accent",
        className,
      )}
    >
      LEVER
    </span>
  );
}

export function SectionLabel({ id, children, className }: { id?: string; children: ReactNode; className?: string }) {
  return (
    <h2 id={id} className={cn("font-mono text-[10.5px] tracking-[0.14em] text-faint", className)}>
      {children}
    </h2>
  );
}

/** "Helps 2" / "Makes 3 easier": opens the pillar chips under a row. */
export function ChipsToggle({
  label,
  open,
  onClick,
  className,
}: {
  label: string;
  open: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium transition-colors",
        open ? "bg-fg text-white" : "bg-soft text-muted hover:text-fg",
        className,
      )}
    >
      {label}
      <ChevronDown size={12} className={cn("transition-transform", open && "rotate-180")} />
    </button>
  );
}
