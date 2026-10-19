"use client";

import { addDays, routineStrength, strengthGlyph } from "@/domain/mandala";
import { checkinsInPeriod, nextPeriodStart, periodWord, recentPeriods, repeatLabel, repeatOf } from "@/domain/repeat";
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
  if (repeatOf(cell).repeat !== "day") return <PeriodDays cell={cell} checkins={checkins} today={today} />;
  const done = new Set(checkins.filter((c) => c.cellId === cell.id).map((c) => c.day));
  const checkedToday = done.has(today);
  const strength = routineStrength(cell, checkins, today);
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
      <KeepGoing cell={cell} />
    </Field>
  );
}

/** Marks a whole week or month done (on today, or the period's due day) or not done. */
function setPeriod(cell: Cell, checkins: Checkin[], day: string, today: string, done: boolean) {
  if (done) {
    setCheckin(cell.id, day <= today ? day : today, true);
    return;
  }
  for (const checked of checkinsInPeriod(cell, checkins, day)) setCheckin(cell.id, checked, false);
}

/**
 * A weekly or monthly habit: "Done this week", its strength, and the last 8 weeks
 * (or 6 months) as squares. Tap any of them to fix it.
 */
function PeriodDays({ cell, checkins, today }: { cell: Cell; checkins: Checkin[]; today: string }) {
  const schedule = repeatOf(cell);
  const monthly = schedule.repeat === "month";
  const periods = recentPeriods(cell, today, monthly ? 6 : 8);
  const isDone = (start: string) => checkinsInPeriod(cell, checkins, start).length > 0;
  const current = periods[periods.length - 1];
  const doneNow = isDone(current);
  const count = periods.filter(isDone).length;
  const strength = routineStrength(cell, checkins, today);
  const word = periodWord(cell);
  const unit = monthly ? "months" : "weeks";

  return (
    <Field label="CHECK-INS" aside={`${count} of the last ${periods.length} ${unit}`}>
      <div className="flex items-center">
        <CheckCircle
          checked={doneNow}
          onChange={(next) => setPeriod(cell, checkins, today, today, next)}
          label={`Done ${word}`}
          className="-ml-2.5"
        />
        <span className="text-sm">{doneNow ? `Done ${word}` : `Not done yet ${word}`}</span>
        <span className="ml-auto font-mono text-[11px] text-muted" title="Habit strength">
          <span className="text-fg">{strengthGlyph(strength)}</span> {strengthWord(strength)}
        </span>
      </div>
      <p className="text-[12.5px] text-muted">
        {repeatLabel(cell)}. Next due {formatDay(nextPeriodStart(schedule, current))}.
      </p>
      <div
        className={cn("grid gap-1", monthly ? "grid-cols-6" : "grid-cols-8")}
        role="group"
        aria-label={`Last ${periods.length} ${unit}`}
      >
        {periods.map((start) => {
          const on = isDone(start);
          const name = monthly
            ? dateOf(start).toLocaleDateString("en-US", { month: "short" })
            : dateOf(start).toLocaleDateString("en-US", { month: "short", day: "numeric" });
          return (
            <button
              key={start}
              type="button"
              aria-pressed={on}
              aria-label={`${start === current ? (monthly ? "This month" : "This week") : name}: ${on ? "done" : "not done"}`}
              title={name}
              onClick={() => setPeriod(cell, checkins, start, today, !on)}
              className="group grid place-items-center gap-1 rounded-md py-1"
            >
              <span
                className={cn(
                  "size-[18px] rounded-[5px] transition-colors duration-150 group-active:scale-90",
                  on ? "bg-fg" : "border border-line-strong group-hover:border-fg",
                  start === current && !on && "border-fg",
                )}
              />
              <span className="font-mono text-[9.5px] text-faint">{name}</span>
            </button>
          );
        })}
      </div>
      <KeepGoing cell={cell} />
    </Field>
  );
}

function formatDay(day: string): string {
  return dateOf(day).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function KeepGoing({ cell }: { cell: Cell }) {
  if (cell.status !== "done") return null;
  return (
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
  );
}
