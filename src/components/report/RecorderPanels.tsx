"use client";

import { Check, ChevronDown, Keyboard, Mic, RotateCcw } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type TextareaHTMLAttributes } from "react";
import { AsciiLevelMeter } from "@/components/ascii/AsciiLevelMeter";
import { AsciiSpinner } from "@/components/ascii/AsciiSpinner";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { addDays } from "@/domain/mandala";
import type { GoalWithCells, ReportSource } from "@/domain/types";
import { shortDate, shortGoalTitle } from "./format";
import { changeLabel, clock, micMessage, type CellInfo, type ReviewItem } from "./review";
import { MAX_RECORDING_MS, type MicProblem, type VoicePhase } from "./useVoiceRecorder";

const LABEL = "font-mono text-[10.5px] tracking-[0.14em] text-faint";
const MAX_SECONDS = MAX_RECORDING_MS / 1000;

// Text fields show focus with a darker border. The "!" is needed because the global
// :focus-visible outline sits outside Tailwind's layers and would otherwise win.
const FIELD =
  "rounded-[14px] border border-line bg-bg px-3.5 py-3 leading-relaxed text-fg outline-none! transition-colors placeholder:text-faint focus:border-muted";
const LINE_FIELD =
  "border-0 border-b border-line bg-transparent px-0 py-2 text-[16px] leading-snug font-medium text-fg outline-none! transition-colors placeholder:font-normal placeholder:text-faint focus:border-fg";

// ---------- shared bits ----------

function fit(el: HTMLTextAreaElement, max: number) {
  el.style.height = "auto";
  const border = el.offsetHeight - el.clientHeight;
  const full = el.scrollHeight + border;
  el.style.height = `${Math.min(full, max)}px`;
  el.style.overflowY = full > max ? "auto" : "hidden";
}

/** Textarea that grows with its text (up to `maxHeight`), so the sheet scrolls instead of the field. */
export function AutoTextarea({
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

export function AudioNote() {
  return (
    <p className="pt-6 text-center text-[11.5px] leading-snug text-faint">
      Audio is sent to Gemini to transcribe and is not stored. Only the text is saved.
    </p>
  );
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

/** "All goals ▾  Today ▾" at the top of the sheet. Locked once the report is being read. */
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

// ---------- voice ----------

export function VoicePanel({
  phase,
  seconds,
  analyser,
  problem,
  notice,
  onStart,
  onStop,
  onCancel,
  onType,
}: {
  phase: VoicePhase;
  seconds: number;
  analyser: AnalyserNode | null;
  problem: MicProblem | null;
  notice: string | null;
  onStart: () => void;
  onStop: () => void;
  onCancel: () => void;
  onType: () => void;
}) {
  const recording = phase === "recording";
  const starting = phase === "starting";
  const left = MAX_SECONDS - seconds;
  const ending = recording && left <= 10;
  const issue = phase === "idle" && problem ? micMessage(problem) : null;

  let hint: ReactNode;
  if (issue) {
    hint = (
      <>
        <span className="block font-medium text-fg">{issue.message}</span>
        {issue.hint && <span className="block text-muted">{issue.hint}</span>}
      </>
    );
  } else if (recording) {
    hint = <span className={ending ? "text-accent" : "text-muted"}>{ending ? `${left} s left` : "Tap to finish"}</span>;
  } else if (starting) {
    hint = <span className="text-muted">Waiting for the microphone…</span>;
  } else {
    hint = <span className="text-muted">{notice ?? "Tap to start"}</span>;
  }

  return (
    <div className="flex flex-col items-center pt-6 text-center">
      <div
        role="timer"
        aria-label={`Recorded ${clock(seconds)}`}
        className={cn(
          "font-mono text-[40px] leading-none font-light tracking-tight tabular-nums transition-colors duration-300",
          recording ? "text-fg" : "text-line-strong",
        )}
      >
        {clock(seconds)}
      </div>
      <AsciiLevelMeter
        analyser={recording ? analyser : null}
        columns={28}
        className={cn("mt-4 transition-opacity duration-300", !recording && "opacity-25")}
      />
      <ul className="mt-6 text-[15px] leading-7 text-muted">
        <li>What did you do?</li>
        <li>What got in the way?</li>
        <li>What&apos;s next?</li>
      </ul>
      {/* One button for start and stop keeps focus on it, so Space starts and stops on desktop. */}
      <button
        type="button"
        autoFocus
        onClick={recording ? onStop : starting ? onCancel : onStart}
        aria-label={recording ? "Stop recording" : starting ? "Cancel" : "Start recording"}
        className={cn(
          "mt-7 grid size-[72px] place-items-center rounded-full text-white transition-[background-color,box-shadow,transform] duration-200 active:scale-95",
          recording ? "bg-accent shadow-[0_0_0_8px_var(--accent-soft)]" : "bg-fg hover:bg-black/80",
        )}
      >
        {starting ? (
          <AsciiSpinner size="sm" label="Starting the microphone" />
        ) : recording ? (
          <span className="size-[22px] rounded-[5px] bg-white" aria-hidden />
        ) : (
          <Mic size={28} strokeWidth={1.75} aria-hidden />
        )}
      </button>
      <p className="mt-3 min-h-10 max-w-xs text-[13px] leading-snug" aria-live="polite">
        {hint}
      </p>
      <div className="flex h-10 items-center">
        {recording ? (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        ) : (
          <Button variant="ghost" size="sm" icon={<Keyboard size={15} />} onClick={onType} disabled={starting}>
            Type instead
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------- typed ----------

export function TypedPanel({
  text,
  onText,
  onSubmit,
  reason,
  onVoice,
}: {
  text: string;
  onText: (text: string) => void;
  /** Cmd/Ctrl+Enter. */
  onSubmit: () => void;
  /** Why voice is off, if it is. */
  reason: string | null;
  /** Switch back to voice; absent when voice is not available. */
  onVoice?: () => void;
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
      <div className="mt-2 flex min-h-8 items-center justify-between gap-3">
        <p className="text-[13px] text-faint">What you did, what got in the way, what&apos;s next.</p>
        {onVoice && (
          <Button variant="ghost" size="sm" icon={<Mic size={14} />} onClick={onVoice} className="-mr-2">
            Voice
          </Button>
        )}
      </div>
      {reason && <p className="mt-3 text-[12.5px] text-faint">{reason}</p>}
    </div>
  );
}

// ---------- waiting and errors ----------

export function ProcessingPanel({ source }: { source: ReportSource }) {
  const voice = source === "voice";
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 12_000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="flex flex-col items-center py-14 text-center" aria-live="polite">
      <AsciiSpinner size="lg" label={voice ? "Listening" : "Reading"} />
      <p className="mt-6 text-[15px] font-medium text-fg">{voice ? "Listening…" : "Reading…"}</p>
      <p className="mt-1 text-[13px] text-muted">
        {slow ? "Long reports take a little longer." : `Matching what you ${voice ? "said" : "wrote"} to your chart.`}
      </p>
    </div>
  );
}

export function FailedPanel({
  source,
  message,
  retry,
  saving,
  saveError,
  onRetry,
  onRecordAgain,
  onType,
  onEdit,
  onSaveAsIs,
}: {
  source: ReportSource;
  message: string;
  retry: boolean;
  /** "Save without changes" is on its way. */
  saving: boolean;
  /** Why "Save without changes" did not save. */
  saveError: string | null;
  onRetry: () => void;
  onRecordAgain: () => void;
  onType: () => void;
  onEdit: () => void;
  onSaveAsIs: () => void;
}) {
  return (
    <div className="flex flex-col items-center py-12 text-center">
      <p role="alert" className="max-w-sm text-[15px] leading-snug text-fg">
        {message}
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {retry && (
          <Button variant="primary" icon={<RotateCcw size={15} />} disabled={saving} onClick={onRetry}>
            Try again
          </Button>
        )}
        {source === "voice" ? (
          <>
            {!retry && (
              <Button variant="primary" icon={<Mic size={15} />} onClick={onRecordAgain}>
                Record again
              </Button>
            )}
            <Button variant="secondary" icon={<Keyboard size={15} />} onClick={onType}>
              Type instead
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" disabled={saving} onClick={onEdit}>
              Edit text
            </Button>
            <Button variant="ghost" loading={saving} onClick={onSaveAsIs}>
              Save without changes
            </Button>
          </>
        )}
      </div>
      {saveError && (
        <p role="alert" className="mt-4 max-w-sm text-[13px] leading-snug text-danger">
          {saveError}
        </p>
      )}
    </div>
  );
}

// ---------- review ----------

function ReviewRow({
  item,
  info,
  showGoal,
  label,
  onToggle,
}: {
  item: ReviewItem;
  info: CellInfo;
  showGoal: boolean;
  label: string;
  onToggle: () => void;
}) {
  const { update, checked } = item;
  const strong = Boolean(update.checkin || update.status === "done");
  const path = [showGoal ? shortGoalTitle(info.goal.title) : null, info.pillar?.text || `Pillar ${info.cell.pillar + 1}`]
    .filter(Boolean)
    .join(" › ");
  return (
    <li>
      <label className="flex cursor-pointer gap-3 py-3.5">
        <input type="checkbox" checked={checked} onChange={onToggle} className="peer sr-only" />
        <span
          aria-hidden
          className={cn(
            "mt-[19px] grid size-[18px] shrink-0 place-items-center rounded-[5px] border-[1.5px] transition-colors",
            "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-fg",
            checked ? "border-fg bg-fg text-white" : "border-line-strong text-transparent",
          )}
        >
          <Check size={12} strokeWidth={3.5} />
        </span>
        <span className={cn("min-w-0 flex-1 transition-opacity", !checked && "opacity-60")}>
          <span className="block truncate text-[12px] text-faint">{path}</span>
          <span className="mt-0.5 flex items-start gap-2">
            <span className="min-w-0 flex-1 text-[15px] leading-snug text-fg">{info.cell.text}</span>
            <span
              className={cn(
                "mt-px shrink-0 rounded-full px-2 py-0.5 font-mono text-[11px] leading-4",
                strong ? "bg-fg text-white" : update.status ? "border border-line-strong text-fg" : "bg-soft text-muted",
              )}
            >
              {label}
            </span>
          </span>
          {update.note && <span className="mt-1 block text-[13.5px] leading-snug text-muted">{update.note}</span>}
          {update.quote && (
            <span className="mt-1 block text-[13px] leading-snug text-faint italic">&ldquo;{update.quote}&rdquo;</span>
          )}
        </span>
      </label>
    </li>
  );
}

export function ReviewPanel({
  summary,
  onSummary,
  transcript,
  onTranscript,
  items,
  onToggle,
  cells,
  showGoal,
  day,
  today,
}: {
  summary: string;
  onSummary: (summary: string) => void;
  transcript: string;
  onTranscript: (transcript: string) => void;
  items: ReviewItem[];
  onToggle: (index: number) => void;
  cells: Map<string, CellInfo>;
  showGoal: boolean;
  day: string;
  today: string;
}) {
  const [showTranscript, setShowTranscript] = useState(false);
  const summaryId = useId();
  const selected = items.filter((item) => item.checked).length;

  return (
    <div className="space-y-7 pt-5">
      <div>
        <label htmlFor={summaryId} className={LABEL}>
          SUMMARY
        </label>
        {/* One line of meaning, but it wraps so the whole sentence stays visible on a phone. */}
        <AutoTextarea
          id={summaryId}
          value={summary}
          onChange={(event) => onSummary(event.target.value.replace(/\s*\n\s*/g, " "))}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.metaKey || event.ctrlKey) return;
            event.preventDefault();
            event.currentTarget.blur();
          }}
          rows={1}
          maxLength={1000}
          maxHeight={160}
          enterKeyHint="done"
          placeholder="One line about the day"
          className={cn(LINE_FIELD, "mt-1")}
        />
      </div>

      <div>
        <button
          type="button"
          aria-expanded={showTranscript}
          onClick={() => setShowTranscript((value) => !value)}
          className={cn(LABEL, "flex items-center gap-1 transition-colors hover:text-muted")}
        >
          TRANSCRIPT
          <ChevronDown size={12} className={cn("transition-transform", showTranscript && "rotate-180")} />
        </button>
        {showTranscript ? (
          <AutoTextarea
            value={transcript}
            onChange={(event) => onTranscript(event.target.value)}
            aria-label="Transcript"
            maxLength={20000}
            rows={4}
            maxHeight={320}
            className={cn(FIELD, "mt-2 text-[14px]")}
          />
        ) : (
          <button type="button" onClick={() => setShowTranscript(true)} className="mt-1.5 w-full text-left">
            <span className="line-clamp-2 text-[13.5px] leading-relaxed text-muted">{transcript}</span>
          </button>
        )}
      </div>

      <section>
        <h3 className={LABEL}>{items.length ? `PROPOSED UPDATES · ${selected}/${items.length}` : "PROPOSED UPDATES"}</h3>
        {items.length === 0 ? (
          <p className="mt-2 text-[14px] text-muted">No chart changes found. The report is still saved.</p>
        ) : (
          <ul className="mt-1 divide-y divide-line">
            {items.map((item, index) => {
              const info = cells.get(item.update.cellId);
              if (!info) return null;
              return (
                <ReviewRow
                  key={item.update.cellId}
                  item={item}
                  info={info}
                  showGoal={showGoal}
                  label={changeLabel(item.update, day, today)}
                  onToggle={() => onToggle(index)}
                />
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
