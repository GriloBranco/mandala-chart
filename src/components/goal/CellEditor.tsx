"use client";

import { Eraser } from "lucide-react";
import { useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { actionHints, dayKey, EFFORT_LABELS, goalHints, IMPACT_LABELS, isFilled, NOTES_MAX, pillarProgress } from "@/lib/mandala";
import { actions as store, useAppState } from "@/lib/store";
import type { Cell, CellKind, CellPatch, CellStatus, Checkin, GoalWithCells, Suggestion } from "@/lib/types";
import { PillarChips } from "@/components/shared/PillarChips";
import { SuggestionTray } from "@/components/shared/SuggestionTray";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Segmented, type SegmentedOption } from "@/components/ui/Segmented";
import { AutoTextarea } from "./AutoTextarea";
import { clearSquare, editCell, fillSquares, hasContent, setKind, suggestionPatch } from "./edits";
import { HabitDays } from "./HabitDays";
import { looksLikeHabit, pillarHints, type ChartIndex } from "./model";
import { Field, Row, SwitchKnob } from "./parts";
import { SharpenButton, SharpenPanel, useSharpen } from "./Sharpen";

export type EditorTarget = { role: "goal" } | { role: "pillar"; cell: Cell } | { role: "action"; cell: Cell };

const PLACEHOLDER = {
  goal: "By [date], I will …",
  pillar: "A key driver, e.g. Sleep",
  action: "Something you can tick off, e.g. Run 3x a week",
};

const KIND_OPTIONS: SegmentedOption<CellKind>[] = [
  { value: "task", label: "Task" },
  { value: "habit", label: "Habit" },
];

const STATUS_OPTIONS: SegmentedOption<CellStatus>[] = [
  { value: "todo", label: "To do" },
  { value: "doing", label: "Doing" },
  { value: "done", label: "Done" },
];

const IMPACT_OPTIONS: SegmentedOption<number>[] = [1, 2, 3].map((value) => ({ value, label: IMPACT_LABELS[value] }));
const EFFORT_OPTIONS: SegmentedOption<number>[] = [1, 2, 3].map((value) => ({ value, label: EFFORT_LABELS[value] }));

// Fields show focus with a dark border; the global focus outline (unlayered, hence the !) would double it.
const FIELD =
  "rounded-xl border border-line-strong bg-bg px-3.5 text-fg placeholder:text-faint transition-colors duration-150 focus:border-fg focus-visible:outline-none!";
const TEXT_FIELD = `${FIELD} py-2.5 text-[15px] leading-[1.45]`;
const LONG_FIELD = `${FIELD} py-2.5 text-[14px] leading-relaxed`;

/**
 * Edits one square: the goal, a pillar or an action. The text field comes first and stays the
 * same element while you move between squares, so focus (and the phone keyboard) survives the
 * Enter-to-next chain.
 */
export function CellEditor({
  goal,
  index,
  target,
  enterHint,
  compact = false,
  autoFocus = false,
  textRef,
  refocusText = false,
  onAdvance,
  onEscape,
  onTypingChange,
  onOpenPillar,
  onFilled,
  className,
}: {
  goal: GoalWithCells;
  index: ChartIndex;
  target: EditorTarget;
  /** Label for the Enter key on phone keyboards. */
  enterHint: "next" | "done";
  /** Only the text and its hints (phone, while the keyboard is up). */
  compact?: boolean;
  autoFocus?: boolean;
  textRef?: Ref<HTMLTextAreaElement | null>;
  /**
   * After a Sharpen pick or "Make it one", put the cursor back in the text: the clicked button
   * goes away, so focus would drop to the page. Desktop only; on a phone it would bring the
   * keyboard back up.
   */
  refocusText?: boolean;
  /** Enter in the text field, or a suggestion put into this square: go to the next empty square. */
  onAdvance: (via: "enter" | "pick") => void;
  /** Esc in the text field. Without it, Esc is left to the sheet (which closes). */
  onEscape?: () => void;
  onTypingChange?: (typing: boolean) => void;
  /** Go to a pillar, e.g. to name it before writing its actions. */
  onOpenPillar?: (pillar: number) => void;
  /** Squares just filled from suggestions. */
  onFilled?: (ids: string[]) => void;
  className?: string;
}) {
  const { checkins, aiEnabled } = useAppState();
  const today = dayKey();
  const cell = target.role === "goal" ? null : target.cell;
  const squareKey = cell ? cell.id : `goal:${goal.id}`;

  // The server needs a goal title, so an emptied field stays local until it has text again.
  const [titleDraft, setTitleDraft] = useState<{ key: string; value: string } | null>(null);
  const draft = titleDraft && titleDraft.key === squareKey ? titleDraft.value : null;
  const text = cell ? cell.text : (draft ?? goal.title);

  // Hints wait for a pause in typing, so they never nag mid-word.
  const [quiet, setQuiet] = useState(true);
  const quietTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const timer = quietTimer;
    return () => clearTimeout(timer.current);
  }, []);

  // A square that starts empty follows its wording: "every day" makes it a habit, until you pick.
  const [guessKindFor, setGuessKindFor] = useState<string | null>(null);

  const sharpen = useSharpen(squareKey);
  const pillarIndex = cell ? cell.pillar : undefined;

  // Our own handle on the text field; the caller's textRef gets the same element.
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  useImperativeHandle(textRef, () => fieldRef.current as HTMLTextAreaElement, []);

  function backToText() {
    if (refocusText) fieldRef.current?.focus();
  }

  function noteTyping() {
    setQuiet(false);
    clearTimeout(quietTimer.current);
    quietTimer.current = setTimeout(() => setQuiet(true), 700);
  }

  function onTextChange(raw: string) {
    const value = raw.replace(/\s*\n+\s*/g, " ");
    noteTyping();
    if (!cell) {
      if (value.trim()) {
        setTitleDraft(null);
        store.updateGoal(goal.id, { title: value }, { debounce: true });
      } else {
        setTitleDraft({ key: squareKey, value });
      }
      return;
    }
    const patch: CellPatch = { text: value };
    if (target.role === "action") {
      const fresh = !cell.text.trim() && Boolean(value.trim());
      if (fresh && guessKindFor !== cell.id) setGuessKindFor(cell.id);
      if (fresh || guessKindFor === cell.id) {
        const kind: CellKind = looksLikeHabit(value) ? "habit" : "task";
        if (kind !== cell.kind) {
          patch.kind = kind;
          if (kind === "habit" && cell.status === "doing") patch.status = "todo";
        }
      }
    }
    editCell(cell.id, patch, { debounce: true });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      if (!text.trim() && !cell) return;
      onAdvance("enter");
    } else if (event.key === "Escape" && onEscape) {
      event.preventDefault();
      event.stopPropagation();
      onEscape();
    }
  }

  function replaceText(option: string) {
    const value = option.trim().slice(0, 200);
    if (!value) return;
    if (cell) editCell(cell.id, { text: value });
    else store.updateGoal(goal.id, { title: value });
    sharpen.reset();
    backToText();
  }

  function runSharpen() {
    if (!text.trim()) return;
    void sharpen.run({ goalId: goal.id, role: target.role, text: text.trim(), pillar: pillarIndex });
  }

  function pickHere(suggestion: Suggestion) {
    if (!cell) return;
    editCell(cell.id, suggestionPatch(suggestion));
    onFilled?.([cell.id]);
    onAdvance("pick");
  }

  const hints = !quiet
    ? []
    : target.role === "goal"
      ? draft !== null
        ? ["Your goal needs a title."]
        : goalHints(text, goal.deadline)
      : target.role === "pillar"
        ? pillarHints(text)
        : actionHints(text);
  const habitNudge =
    quiet &&
    target.role === "action" &&
    target.cell.kind === "task" &&
    guessKindFor !== target.cell.id &&
    looksLikeHabit(text);
  const unnamedPillar = target.role === "action" && !isFilled(index.pillars[target.cell.pillar]);

  return (
    <div className={cn("space-y-6", className)}>
      <div>
        <AutoTextarea
          ref={fieldRef}
          value={text}
          onChange={onTextChange}
          onKeyDown={onKeyDown}
          onFocus={() => onTypingChange?.(true)}
          onBlur={() => {
            onTypingChange?.(false);
            if (draft !== null) setTitleDraft(null);
          }}
          // Only when the square is empty: the point of opening it is to write.
          autoFocus={autoFocus}
          enterKeyHint={enterHint}
          maxLength={200}
          maxRows={target.role === "goal" ? 4 : 3}
          placeholder={PLACEHOLDER[target.role]}
          aria-label={target.role === "goal" ? "Goal" : target.role === "pillar" ? "Pillar" : "Action"}
          autoComplete="off"
          className={cn(TEXT_FIELD, target.role !== "action" && "font-semibold tracking-tight")}
        />

        {(hints.length > 0 || habitNudge || unnamedPillar || (aiEnabled && text.trim())) && (
          <div className="mt-2 flex items-start gap-3">
            <div className="min-w-0 flex-1 space-y-1 pt-1.5">
              {unnamedPillar && (
                <p className="text-[12.5px] leading-snug text-muted">
                  Name the pillar first.{" "}
                  {onOpenPillar && (
                    <button
                      type="button"
                      className="font-medium text-fg underline underline-offset-2"
                      onClick={() => onOpenPillar(target.cell.pillar)}
                    >
                      Name it
                    </button>
                  )}
                </p>
              )}
              {hints.map((hint) => (
                <p key={hint} className="animate-fade-in text-[12.5px] leading-snug text-muted">
                  {hint}
                </p>
              ))}
              {habitNudge && (
                <p className="animate-fade-in text-[12.5px] leading-snug text-muted">
                  Sounds like a habit.{" "}
                  <button
                    type="button"
                    className="font-medium text-fg underline underline-offset-2"
                    onClick={() => {
                      setKind(target.cell, "habit");
                      backToText();
                    }}
                  >
                    Make it one
                  </button>
                </p>
              )}
            </div>
            {aiEnabled && text.trim() && <SharpenButton state={sharpen.state} onRun={runSharpen} />}
          </div>
        )}
        {aiEnabled && (
          <SharpenPanel state={sharpen.state} onPick={replaceText} onRetry={runSharpen} onClose={sharpen.reset} />
        )}
      </div>

      {!compact && target.role === "goal" && <GoalDetails goal={goal} index={index} onFilled={onFilled} />}

      {!compact && target.role !== "goal" && !isFilled(target.cell) && (
        <EmptyGuide goal={goal} index={index} target={target} onPick={pickHere} onFilled={onFilled} />
      )}

      {!compact && target.role === "pillar" && isFilled(target.cell) && (
        <PillarDetails
          goal={goal}
          index={index}
          cell={target.cell}
          checkins={checkins}
          today={today}
          onFilled={onFilled}
        />
      )}

      {!compact && target.role === "action" && isFilled(target.cell) && (
        <ActionDetails
          goal={goal}
          cell={target.cell}
          checkins={checkins}
          today={today}
          onKindPicked={() => setGuessKindFor(null)}
        />
      )}

      {!compact && cell && hasContent(cell) && (
        <div className="border-t border-line pt-4">
          <Button
            variant="danger"
            size="sm"
            icon={<Eraser size={14} />}
            onClick={() => clearSquare(cell.id)}
            className="-ml-3"
          >
            Clear square
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------- goal ----------

function monthsFromNow(months: number): string {
  const now = new Date();
  return dayKey(new Date(now.getFullYear(), now.getMonth() + months, now.getDate()));
}

const QUICK_DEADLINES = [
  { label: "3 months", months: 3 },
  { label: "6 months", months: 6 },
  { label: "1 year", months: 12 },
];

function GoalDetails({
  goal,
  index,
  onFilled,
}: {
  goal: GoalWithCells;
  index: ChartIndex;
  onFilled?: (ids: string[]) => void;
}) {
  const emptyPillars = index.pillars.filter((c): c is Cell => Boolean(c) && !isFilled(c));
  const named = index.pillars.filter((c) => isFilled(c)).map((c) => c?.text ?? "");

  return (
    <>
      <Field label="DEADLINE">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={goal.deadline ?? ""}
            onChange={(event) => store.updateGoal(goal.id, { deadline: event.target.value || null })}
            aria-label="Deadline"
            className={cn(FIELD, "h-11 min-w-0 flex-1 text-[14px]")}
          />
          {goal.deadline ? (
            <Button variant="ghost" size="sm" onClick={() => store.updateGoal(goal.id, { deadline: null })}>
              Clear
            </Button>
          ) : (
            <div className="flex gap-1.5">
              {QUICK_DEADLINES.map((quick) => (
                <button
                  key={quick.label}
                  type="button"
                  onClick={() => store.updateGoal(goal.id, { deadline: monthsFromNow(quick.months) })}
                  className="h-8 rounded-full border border-line-strong px-3 text-[12.5px] text-muted transition-colors hover:border-fg hover:text-fg"
                >
                  {quick.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </Field>

      <Field label="WHY IT MATTERS">
        <AutoTextarea
          value={goal.why}
          onChange={(why) => store.updateGoal(goal.id, { why }, { debounce: true })}
          maxLength={2000}
          maxRows={8}
          placeholder="What reaching it will change for you. It helps on hard days."
          aria-label="Why it matters"
          className={LONG_FIELD}
        />
      </Field>

      {emptyPillars.length > 0 && (
        <Field label="PILLARS" aside={`${8 - emptyPillars.length} of 8 named`}>
          <SuggestionTray
            goalId={goal.id}
            target="pillars"
            existing={named}
            onPick={(suggestion) => onFilled?.(fillSquares(emptyPillars, [suggestion], "pillars"))}
            onPickAll={(list) => onFilled?.(fillSquares(emptyPillars, list, "pillars"))}
          />
        </Field>
      )}
    </>
  );
}

// ---------- pillar ----------

function PillarDetails({
  goal,
  index,
  cell,
  checkins,
  today,
  onFilled,
}: {
  goal: GoalWithCells;
  index: ChartIndex;
  cell: Cell;
  checkins: Checkin[];
  today: string;
  onFilled?: (ids: string[]) => void;
}) {
  const own = index.actions[cell.pillar];
  const filled = own.filter((c) => isFilled(c)).length;
  const empty = own.filter((c): c is Cell => Boolean(c) && !isFilled(c));
  const progress = pillarProgress(goal, cell.pillar, checkins, today);

  return (
    <>
      <Field label="IMPACT ON THE GOAL" aside="optional">
        <Segmented
          value={cell.impact}
          options={IMPACT_OPTIONS}
          allowClear
          onChange={(impact) => editCell(cell.id, { impact })}
          label="Impact on the goal"
        />
      </Field>

      <Field label="MAKES EASIER" aside="other pillars it helps">
        <PillarChips
          goal={goal}
          exclude={cell.pillar}
          value={cell.helps}
          onChange={(helps) => editCell(cell.id, { helps })}
        />
      </Field>

      <Field label="ACTIONS">
        <div className="space-y-1.5">
          <ProgressBar value={progress} />
          <div className="flex justify-between font-mono text-[11px] text-muted">
            <span>{filled}/8 actions</span>
            <span>{Math.round(progress * 100)}%</span>
          </div>
        </div>
        {empty.length > 0 && (
          <SuggestionTray
            key={`actions-${cell.pillar}`}
            goalId={goal.id}
            target="actions"
            pillar={cell.pillar}
            existing={actionTexts(goal)}
            onPick={(suggestion) => onFilled?.(fillSquares(empty, [suggestion], "actions"))}
            onPickAll={(list) => onFilled?.(fillSquares(empty, list, "actions"))}
            className="mt-2"
          />
        )}
      </Field>

      <NotesField cell={cell} />
    </>
  );
}

// ---------- action ----------

function ActionDetails({
  goal,
  cell,
  checkins,
  today,
  onKindPicked,
}: {
  goal: GoalWithCells;
  cell: Cell;
  checkins: Checkin[];
  today: string;
  onKindPicked: () => void;
}) {
  return (
    <>
      <Field label="KIND">
        <Segmented
          value={cell.kind}
          options={KIND_OPTIONS}
          onChange={(kind) => {
            if (!kind) return;
            onKindPicked();
            setKind(cell, kind);
          }}
          label="Kind"
        />
      </Field>

      {cell.kind === "task" ? (
        <Field label="STATUS">
          <Segmented
            value={cell.status}
            options={STATUS_OPTIONS}
            onChange={(status) => status && editCell(cell.id, { status })}
            label="Status"
          />
        </Field>
      ) : (
        <HabitDays cell={cell} checkins={checkins} today={today} />
      )}

      <button
        type="button"
        role="switch"
        aria-checked={cell.active}
        onClick={() => editCell(cell.id, { active: !cell.active })}
        className="flex w-full items-center gap-3 rounded-xl border border-line px-3.5 py-3 text-left transition-colors hover:bg-softer"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">This week</span>
          <span className="block text-xs text-muted">
            {cell.active && cell.status === "done" ? "Done, so it is off Today" : "Shows on Today"}
          </span>
        </span>
        <SwitchKnob on={cell.active} />
      </button>

      <Field label="LEVERAGE" aside="optional">
        <div className="space-y-2">
          <Row label="Impact">
            <Segmented
              size="sm"
              value={cell.impact}
              options={IMPACT_OPTIONS}
              allowClear
              onChange={(impact) => editCell(cell.id, { impact })}
              label="Impact"
            />
          </Row>
          <Row label="Effort">
            <Segmented
              size="sm"
              value={cell.effort}
              options={EFFORT_OPTIONS}
              allowClear
              onChange={(effort) => editCell(cell.id, { effort })}
              label="Effort"
            />
          </Row>
        </div>
      </Field>

      <Field label="ALSO HELPS">
        <PillarChips
          goal={goal}
          exclude={cell.pillar}
          value={cell.helps}
          onChange={(helps) => editCell(cell.id, { helps })}
        />
      </Field>

      <NotesField cell={cell} />
    </>
  );
}

// ---------- shared bits ----------

function NotesField({ cell }: { cell: Cell }) {
  return (
    <Field label="NOTES">
      <AutoTextarea
        value={cell.notes}
        onChange={(notes) => editCell(cell.id, { notes }, { debounce: true })}
        maxLength={NOTES_MAX}
        maxRows={10}
        placeholder="Details, numbers, links"
        aria-label="Notes"
        className={LONG_FIELD}
      />
    </Field>
  );
}

function actionTexts(goal: GoalWithCells): string[] {
  return goal.cells.filter((c) => c.slot >= 0 && isFilled(c)).map((c) => c.text);
}

/** An empty pillar or action: what makes a good one, and suggestions that drop straight in. */
function EmptyGuide({
  goal,
  index,
  target,
  onPick,
  onFilled,
}: {
  goal: GoalWithCells;
  index: ChartIndex;
  target: Extract<EditorTarget, { cell: Cell }>;
  onPick: (suggestion: Suggestion) => void;
  onFilled?: (ids: string[]) => void;
}) {
  const isPillar = target.role === "pillar";
  const pillar = target.cell.pillar;
  const named = isFilled(index.pillars[pillar]);
  // Add all fills the block's empty squares clockwise, starting with this one.
  const ring = isPillar ? index.pillars : index.actions[pillar];
  const start = isPillar ? pillar : target.cell.slot;
  const empty = Array.from({ length: 8 }, (_, step) => ring[(start + step) % 8]).filter(
    (c): c is Cell => Boolean(c) && !isFilled(c),
  );

  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-muted">
        {isPillar
          ? "A pillar is a key driver of the goal, in 1-3 words. Keep the 8 distinct, and cover mind, skill, body and daily life."
          : "Make it something you can tick off and that is in your control: an input, not an outcome."}
      </p>
      {(isPillar || named) && (
        <SuggestionTray
          key={isPillar ? "pillars" : `actions-${pillar}`}
          goalId={goal.id}
          target={isPillar ? "pillars" : "actions"}
          pillar={isPillar ? undefined : pillar}
          existing={isPillar ? index.pillars.filter((c) => isFilled(c)).map((c) => c?.text ?? "") : actionTexts(goal)}
          onPick={onPick}
          onPickAll={(list) => onFilled?.(fillSquares(empty, list, isPillar ? "pillars" : "actions"))}
        />
      )}
    </div>
  );
}
