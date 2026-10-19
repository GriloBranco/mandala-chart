"use client";

import { Check, ChevronDown } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode, type TextareaHTMLAttributes } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { addDays } from "@/domain/mandala";
import type { GoalWithCells } from "@/domain/types";
import { shortDate, shortGoalTitle } from "./format";

// The text field shows focus with a darker border. The "!" is needed because the global
// :focus-visible outline sits outside Tailwind's layers and would otherwise win.
const FIELD =
  "rounded-[14px] border border-line bg-bg px-3.5 py-3 leading-relaxed text-fg outline-none! transition-colors placeholder:text-faint focus:border-muted";

// ---------- shared bits ----------

function fit(el: HTMLTextAreaElement, max: number) {
  el.style.height = "auto";
  const border = el.offsetHeight - el.clientHeight;
  const full = el.scrollHeight + border;
  el.style.height = `${Math.min(full, max)}px`;
  el.style.overflowY = full > max ? "auto" : "hidden";
}

/** Textarea that grows with its text (up to `maxHeight`), so the sheet scrolls instead of the field. */
function AutoTextarea({
  maxHeight = 420,
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { maxHeight?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (ref.current) fit(ref.current, maxHeight);
  });
  return <textarea ref={ref} className={cn("block w-full resize-none", className)} {...props} />;
}

export function ConfirmBar({ message, onKeep, onDiscard }: { message: string; onKeep: () => void; onDiscard: () => void }) {
  return (
    <div className="flex animate-fade-in items-center gap-2" role="group" aria-label={message}>
      <p className="min-w-0 flex-1 text-[14px] font-medium text-fg">{message}</p>
      <Button variant="ghost" onClick={onKeep}>
        Keep
      </Button>
      <Button variant="danger" className="bg-red-50" autoFocus onClick={onDiscard}>
        Discard
      </Button>
    </div>
  );
}

export function FooterRow({ error, children }: { error?: string | null; children: ReactNode }) {
  return (
    <div>
      {error && (
        <p role="alert" className="mb-2.5 text-[13px] leading-snug text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">{children}</div>
    </div>
  );
}

// ---------- scope and day ----------

function Chip({
  children,
  expanded,
  onClick,
  fixed = false,
}: {
  children: ReactNode;
  expanded?: boolean;
  onClick?: () => void;
  /** Never shrinks (the short day chip next to a long goal title). */
  fixed?: boolean;
}) {
  const size = fixed ? "shrink-0" : "min-w-0";
  if (!onClick) {
    return (
      <span className={cn("inline-flex h-9 max-w-full items-center rounded-full bg-soft px-3.5 text-[13px] text-muted", size)}>
        <span className="truncate">{children}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onClick}
      className={cn(
        "relative inline-flex h-9 max-w-full items-center gap-1 rounded-full border px-3.5 text-[13px] text-fg transition-colors",
        "before:absolute before:inset-x-0 before:-inset-y-1", // a taller tap target than it looks
        expanded ? "border-fg" : "border-line-strong hover:border-fg",
        size,
      )}
    >
      <span className="truncate">{children}</span>
      <ChevronDown size={14} className={cn("shrink-0 text-faint transition-transform", expanded && "rotate-180")} />
    </button>
  );
}

interface Option<T> {
  key: string;
  value: T;
  label: string;
  meta?: string;
}

function Options<T>({ options, value, onPick }: { options: Option<T>[]; value: T; onPick: (value: T) => void }) {
  return (
    <ul className="mt-2 animate-fade-in divide-y divide-line overflow-hidden rounded-[14px] border border-line">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <li key={option.key}>
            <button
              type="button"
              aria-pressed={selected}
              onClick={() => onPick(option.value)}
              className="flex min-h-11 w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] transition-colors hover:bg-softer"
            >
              <span className={cn("min-w-0 flex-1 truncate", selected ? "font-medium text-fg" : "text-fg/80")}>
                {option.label}
              </span>
              {option.meta && <span className="shrink-0 font-mono text-[11px] text-faint">{option.meta}</span>}
              <Check size={15} className={cn("shrink-0", selected ? "text-fg" : "text-transparent")} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** "All goals ▾  Today ▾" at the top of the sheet. Locked while the report is being saved. */
export function ContextRow({
  goals,
  scope,
  onScope,
  day,
  today,
  onDay,
  locked,
}: {
  /** Goals the report can be about; empty hides the scope chip. */
  goals: GoalWithCells[];
  scope: string | null;
  onScope: (goalId: string | null) => void;
  day: string;
  today: string;
  onDay: (day: string) => void;
  locked: boolean;
}) {
  const [open, setOpen] = useState<"scope" | "day" | null>(null);
  const shown = locked ? null : open;
  const yesterday = addDays(today, -1);
  const scopeGoal = goals.find((g) => g.id === scope);
  const scopeLabel = scopeGoal ? shortGoalTitle(scopeGoal.title) : "All goals";
  const canPickScope = !locked && goals.length > 1;
  const dayText = day === today ? "Today" : day === yesterday ? "Yesterday" : shortDate(day);
  const toggle = (panel: "scope" | "day") => setOpen((current) => (current === panel ? null : panel));

  return (
    <div>
      <div className="flex min-w-0 items-center gap-2">
        {goals.length > 0 && (
          <Chip expanded={shown === "scope"} onClick={canPickScope ? () => toggle("scope") : undefined}>
            {scopeLabel}
          </Chip>
        )}
        <Chip fixed expanded={shown === "day"} onClick={locked ? undefined : () => toggle("day")}>
          {dayText}
        </Chip>
      </div>
      {shown === "scope" && (
        <Options
          value={scope}
          onPick={(value) => {
            onScope(value);
            setOpen(null);
          }}
          options={[
            { key: "all", value: null, label: "All goals" },
            ...goals.map((goal) => ({ key: goal.id, value: goal.id, label: shortGoalTitle(goal.title) })),
          ]}
        />
      )}
      {shown === "day" && (
        <Options
          value={day}
          onPick={(value) => {
            onDay(value);
            setOpen(null);
          }}
          options={[
            { key: "today", value: today, label: "Today", meta: shortDate(today) },
            { key: "yesterday", value: yesterday, label: "Yesterday", meta: shortDate(yesterday) },
          ]}
        />
      )}
    </div>
  );
}

// ---------- the report ----------

export function ReportField({
  text,
  onText,
  onSubmit,
}: {
  text: string;
  onText: (text: string) => void;
  /** Cmd/Ctrl+Enter. */
  onSubmit: () => void;
}) {
  return (
    <div className="pt-4">
      <AutoTextarea
        autoFocus
        value={text}
        onChange={(event) => onText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSubmit();
          }
        }}
        aria-label="Your report"
        placeholder="What happened today?"
        maxLength={20000}
        rows={6}
        className={cn(FIELD, "min-h-28 text-[15px] [@media(min-height:740px)]:min-h-40")}
      />
      <p className="mt-2 flex min-h-8 items-center text-[13px] text-faint">
        What you did, what got in the way, what&apos;s next.
      </p>
    </div>
  );
}
