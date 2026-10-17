"use client";

import { cn } from "./cn";

export interface SegmentedOption<T> {
  value: T;
  label: string;
}

/**
 * A row of small exclusive choices (Task | Habit, Low | Medium | High).
 * With `allowClear`, tapping the selected option clears it (onChange(null)).
 */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  allowClear = false,
  size = "md",
  className,
}: {
  value: T | null;
  options: SegmentedOption<T>[];
  onChange: (value: T | null) => void;
  label: string;
  allowClear?: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex rounded-full bg-soft p-0.5", className)}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(selected && allowClear ? null : option.value)}
            className={cn(
              "rounded-full font-medium transition-colors duration-150",
              size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3.5 text-[13px]",
              selected ? "bg-bg text-fg shadow-[0_0_0_1px_var(--line-strong)]" : "text-muted hover:text-fg",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
