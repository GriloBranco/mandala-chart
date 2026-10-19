"use client";

import { HOW_OFTEN_LABELS, howOften, repeatOf, type HowOften } from "@/domain/repeat";
import type { Cell } from "@/domain/types";
import { cn } from "@/components/ui/cn";
import { Segmented, type SegmentedOption } from "@/components/ui/Segmented";

export const HOW_OFTEN_OPTIONS: SegmentedOption<HowOften>[] = (["task", "day", "week", "month"] as const).map(
  (value) => ({ value, label: HOW_OFTEN_LABELS[value] }),
);

const WEEKDAY_OPTIONS: SegmentedOption<number>[] = ["S", "M", "T", "W", "T", "F", "S"].map((label, value) => ({
  value,
  label,
}));

/** Task, or a habit that comes back daily, weekly or monthly. */
export function HowOftenPicker({
  cell,
  onPick,
  size = "md",
}: {
  cell: Cell;
  onPick: (choice: HowOften) => void;
  size?: "sm" | "md";
}) {
  return (
    <Segmented
      size={size}
      label="How often"
      value={howOften(cell)}
      options={HOW_OFTEN_OPTIONS}
      onChange={(choice) => choice && onPick(choice)}
    />
  );
}

/** The weekday of a weekly habit, or the date of a monthly one. Nothing for the rest. */
export function RepeatDayPicker({
  cell,
  onPick,
  className,
}: {
  cell: Cell;
  onPick: (on: number) => void;
  className?: string;
}) {
  const choice = howOften(cell);
  if (choice === "week") {
    return (
      <Segmented
        size="sm"
        label="Day of the week"
        value={repeatOf(cell).on}
        options={WEEKDAY_OPTIONS}
        onChange={(on) => on !== null && onPick(on)}
        className={className}
      />
    );
  }
  if (choice === "month") {
    return (
      <label className={cn("inline-flex items-center gap-2 text-[13px] text-muted", className)}>
        On day
        <select
          value={repeatOf(cell).on}
          onChange={(event) => onPick(Number(event.target.value))}
          className="h-8 rounded-full border border-line-strong bg-bg px-2.5 text-[13px] text-fg"
        >
          {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
            <option key={day} value={day}>
              {day}
            </option>
          ))}
        </select>
        <span className="text-[12px] text-faint">of each month</span>
      </label>
    );
  }
  return null;
}
