"use client";

import { Check } from "lucide-react";
import { cn } from "./cn";

/** Round 44px check target for Today lists and habit check-ins. */
export function CheckCircle({
  checked,
  onChange,
  label,
  partial = false,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  /** Half state, e.g. a task in progress. */
  partial?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked ? true : partial ? "mixed" : false}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn("group grid size-11 shrink-0 place-items-center rounded-full", className)}
    >
      <span
        className={cn(
          "grid size-6 place-items-center rounded-full border-[1.5px] transition-all duration-150 group-active:scale-90",
          checked ? "border-fg bg-fg text-white" : "border-line-strong text-transparent group-hover:border-fg",
          !checked && partial && "border-fg bg-[linear-gradient(90deg,var(--fg)_50%,transparent_50%)]",
        )}
      >
        <Check size={14} strokeWidth={3} />
      </span>
    </button>
  );
}
