"use client";

import { Ellipsis } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconButton } from "@/components/ui/Button";
import { CheckCircle } from "@/components/ui/CheckCircle";
import { cn } from "@/components/ui/cn";
import { Sheet } from "@/components/ui/Sheet";
import { useLongPress } from "@/components/ui/useLongPress";
import { addDays, routineStrength, strengthGlyph, type TodayItem } from "@/domain/mandala";
import { nextPeriodStart, recentPeriods, repeatOf } from "@/domain/repeat";
import type { Checkin } from "@/domain/types";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  run: () => void;
}

// ---------- menus: a small popover with a mouse, a bottom sheet after a long press ----------

/** "..." button that opens a small menu. Shown on hover, for mouse and keyboard users. */
export function RowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <IconButton
        label={`More for ${label}`}
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(!open && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}
      >
        <Ellipsis size={16} className="text-muted" />
      </IconButton>
      {open && (
        <div
          role="menu"
          className="absolute top-full right-0 z-20 mt-1 min-w-52 animate-fade-in rounded-xl border border-line bg-bg p-1 shadow-[0_8px_24px_rgba(0,0,0,0.08)]"
        >
          {items.map((item, index) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              autoFocus={index === 0}
              onClick={() => {
                setOpen(false);
                item.run();
              }}
              className="flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-[13.5px] text-fg outline-offset-0 hover:bg-soft focus-visible:bg-soft"
            >
              {item.icon && <span className="text-muted">{item.icon}</span>}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The same choices as a bottom sheet, opened by a long press on a phone. */
export function MenuSheet({ title, items, onClose }: { title: string; items: MenuItem[]; onClose: () => void }) {
  return (
    <Sheet open onClose={onClose} title={<span className="line-clamp-2">{title}</span>} size="sm">
      <div className="-mx-2 pb-1">
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={() => {
              onClose();
              item.run();
            }}
            className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] text-fg transition-colors hover:bg-soft active:bg-soft"
          >
            {item.icon && <span className="text-muted">{item.icon}</span>}
            {item.label}
          </button>
        ))}
      </div>
    </Sheet>
  );
}

// ---------- rows ----------

/** The text part of a row: tap opens the chart at that pillar, a long press opens the menu. */
function RowBody({
  text,
  context,
  done,
  struck,
  onOpen,
  onLongPress,
}: {
  text: string;
  context: string;
  done: boolean;
  struck?: boolean;
  onOpen: () => void;
  onLongPress?: () => void;
}) {
  const press = useLongPress(onLongPress);
  return (
    <button
      type="button"
      {...press.handlers}
      onClick={() => {
        if (press.consumeClick()) return;
        onOpen();
      }}
      className="no-callout min-w-0 flex-1 py-3 text-left"
    >
      <span
        className={cn(
          "line-clamp-2 text-[15px] leading-snug transition-colors duration-300",
          done ? "text-muted" : "text-fg",
          struck && "line-through decoration-line-strong",
        )}
      >
        {text}
      </span>
      <span className="mt-0.5 block truncate text-[12.5px] text-faint">{context}</span>
    </button>
  );
}

function lastDays(today: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(today, i - count + 1));
}

export function HabitRow({
  item,
  context,
  done,
  checkins,
  today,
  onToggle,
  onOpen,
  menu,
  onLongPress,
}: {
  item: TodayItem;
  context: string;
  done: boolean;
  checkins: Checkin[];
  today: string;
  onToggle: (done: boolean) => void;
  onOpen: () => void;
  /** Hover menu (mouse); null on touch screens. */
  menu: ReactNode;
  onLongPress?: () => void;
}) {
  const { cell } = item;
  const schedule = repeatOf(cell);
  const daily = schedule.repeat === "day";
  // One dot per day for a daily routine, per week or month for the others.
  const periods = daily ? lastDays(today, 7) : recentPeriods(cell, today, 7);
  const doneDays = checkins.filter((c) => c.cellId === cell.id).map((c) => c.day);
  const hit = (start: string) => {
    const end = daily ? addDays(start, 1) : nextPeriodStart(schedule, start);
    return doneDays.some((day) => day >= start && day < end);
  };
  const count = periods.filter(hit).length;
  const unit = daily ? "days" : schedule.repeat === "week" ? "weeks" : "months";
  const strength = routineStrength(cell, checkins, today);
  const current = periods[periods.length - 1];

  return (
    <li className="group flex items-center gap-1">
      <CheckCircle checked={done} onChange={onToggle} label={`${cell.text}: done today`} className="-ml-2.5" />
      <RowBody text={cell.text} context={context} done={done} onOpen={onOpen} onLongPress={onLongPress} />
      <span className="flex shrink-0 items-center gap-2 pl-2" title={`${count} of the last 7 ${unit}`}>
        <span className="font-mono text-[12px] leading-none text-faint" aria-hidden>
          {strengthGlyph(strength)}
        </span>
        <span className="flex gap-[3px]" aria-hidden>
          {periods.map((day) => (
            <span
              key={day}
              className={cn(
                "size-[7px] rounded-[2px]",
                hit(day)
                  ? "bg-fg"
                  : day === current
                    ? "shadow-[inset_0_0_0_1px_var(--line-strong)]"
                    : "bg-line",
              )}
            />
          ))}
        </span>
        <span className="sr-only">{`${count} of the last 7 ${unit}`}</span>
      </span>
      {menu}
    </li>
  );
}

export function TaskRow({
  item,
  context,
  fading,
  onToggle,
  onOpen,
  menu,
  onLongPress,
}: {
  item: TodayItem;
  context: string;
  /** Just checked: shown done for a moment before it moves to "Done today". */
  fading: boolean;
  onToggle: (done: boolean) => void;
  onOpen: () => void;
  menu: ReactNode;
  onLongPress?: () => void;
}) {
  const { cell } = item;
  const done = cell.status === "done";
  const doing = cell.status === "doing";
  return (
    <li className={cn("group flex items-center gap-1 transition-opacity duration-700", fading && "opacity-50")}>
      <CheckCircle
        checked={done}
        partial={doing}
        onChange={onToggle}
        label={doing ? `${cell.text}: doing. Mark done` : `${cell.text}: done`}
        className="-ml-2.5"
      />
      <RowBody
        text={cell.text}
        context={doing ? `Doing · ${context}` : context}
        done={done}
        struck={done}
        onOpen={onOpen}
        onLongPress={onLongPress}
      />
      {!fading && menu}
    </li>
  );
}

export function DoneRow({
  item,
  context,
  onUndo,
  onOpen,
}: {
  item: TodayItem;
  context: string;
  onUndo: () => void;
  onOpen: () => void;
}) {
  return (
    <li className="flex items-center gap-1">
      <CheckCircle checked onChange={onUndo} label={`${item.cell.text}: done. Mark not done`} className="-ml-2.5" />
      <RowBody text={item.cell.text} context={context} done struck onOpen={onOpen} />
    </li>
  );
}
