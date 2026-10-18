"use client";

import { addDays, habitStrength, strengthGlyph } from "@/domain/mandala";
import type { Cell, Checkin } from "@/domain/types";
import { CheckCircle } from "@/components/ui/CheckCircle";
import { cn } from "@/components/ui/cn";
import { editCell, setCheckin } from "./edits";
import { Field } from "./parts";
import { strengthWord } from "./model";

const WEEKDAY = ["S", "M", "T", "W", "T", "F", "S"];

function dateOf(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Habit check-ins: "Done today", its strength, and the last two weeks as a small calendar
 * (one column per weekday, today in the bottom-right). Tap any day to fix it.
 */
export function HabitDays({ cell, checkins, today }: { cell: Cell; checkins: Checkin[]; today: string }) {
  const done = new Set(checkins.filter((c) => c.cellId === cell.id).map((c) => c.day));
  const checkedToday = done.has(today);
  const strength = habitStrength(cell.id, checkins, today);
  const days = Array.from({ length: 14 }, (_, i) => addDays(today, i - 13));
  const count = days.filter((day) => done.has(day)).length;

  return (
    <Field label="CHECK-INS" aside={`${count} of the last 14 days`}>
      <div className="flex items-center">
        <CheckCircle
          checked={checkedToday}
          onChange={(next) => setCheckin(cell.id, today, next)}
          label="Done today"
          className="-ml-2.5"
        />
        <span className="text-sm">{checkedToday ? "Done today" : "Not done yet today"}</span>
        <span className="ml-auto font-mono text-[11px] text-muted" title="Habit strength">
          <span className="text-fg">{strengthGlyph(strength)}</span> {strengthWord(strength)}
        </span>
      </div>
      <div className="grid grid-cols-7 gap-1" role="group" aria-label="Last 14 days">
        {days.slice(0, 7).map((day) => (
          <span key={`label-${day}`} aria-hidden className="text-center font-mono text-[10px] text-faint">
            {WEEKDAY[dateOf(day).getDay()]}
          </span>
        ))}
        {days.map((day) => {
          const on = done.has(day);
          const isToday = day === today;
          const name = dateOf(day).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
          return (
            <button
              key={day}
              type="button"
              aria-pressed={on}
              aria-label={`${isToday ? "Today" : name}: ${on ? "done" : "not done"}`}
              title={isToday ? "Today" : name}
              onClick={() => setCheckin(cell.id, day, !on)}
              className="group grid h-9 place-items-center rounded-md"
            >
              <span
                className={cn(
                  "size-[18px] rounded-[5px] transition-colors duration-150 group-active:scale-90",
                  on ? "bg-fg" : "border border-line-strong group-hover:border-fg",
                  isToday && !on && "border-fg",
                )}
              />
            </button>
          );
        })}
      </div>
      {cell.status === "done" && (
        <p className="text-[12.5px] text-muted">
          Marked done, so it is off Today.{" "}
          <button
            type="button"
            className="font-medium text-fg underline underline-offset-2"
            onClick={() => editCell(cell.id, { status: "todo" })}
          >
            Keep it going
          </button>
        </p>
      )}
    </Field>
  );
}
