"use client";

import { CalendarDays } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { useMediaQuery } from "@/components/ui/hooks";
import { ApiError } from "@/client/api";
import { dayKey, goalHints } from "@/domain/mandala";
import { navigate } from "@/client/nav";
import { newUuid } from "@/client/uuid";
import { actions, useAppState } from "@/client/store";
import { toast } from "@/client/toast";
import type { GoalPatch, GoalWithCells } from "@/domain/types";
import { Dock, LABEL, NavRow, StepBody, StepHeading } from "./StepParts";
import { addMonths, deadlineFromText, formatDay, readDraft, writeDraft, type GoalDraft } from "./text";

/**
 * Step 1: the goal in the middle. Before the goal exists the text is kept as a draft on
 * this device, so closing never loses it; once it exists, edits save as you type.
 */
export function GoalStep({ goal, onNext }: { goal?: GoalWithCells; onNext: (goal: GoalWithCells) => void }) {
  const { offline } = useAppState();
  const [draft] = useState(() => (goal ? null : readDraft()));
  const [title, setTitle] = useState(goal?.title ?? draft?.title ?? "");
  const [why, setWhy] = useState(goal?.why ?? draft?.why ?? "");
  const [deadline, setDeadline] = useState<string | null>(goal ? goal.deadline : (draft?.deadline ?? null));
  // You took the date away on purpose: do not fill it back in from the goal's words.
  const [noDate, setNoDate] = useState(draft?.noDate === true);
  // Kept with the draft until the goal is created: a retry after a lost response sends the
  // same id and gets back the goal the first try made, not a second one.
  const draftId = useRef(draft?.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const whyRef = useRef<HTMLInputElement>(null);
  const today = dayKey();
  const hints = title.trim().length >= 6 ? goalHints(title, deadline) : [];

  useLayoutEffect(() => {
    // Grow the goal box with its text, so a long goal never scrolls inside itself.
    const box = titleRef.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight}px`;
  }, [title]);

  const save = (next: Partial<GoalDraft>) => {
    if (!goal) {
      writeDraft({ title, why, deadline, noDate, id: draftId.current, ...next });
      return;
    }
    const patch: GoalPatch = {};
    if (next.title !== undefined && next.title.trim()) patch.title = next.title.trim();
    if (next.why !== undefined) patch.why = next.why.trim();
    if (next.deadline !== undefined) patch.deadline = next.deadline;
    if (Object.keys(patch).length) actions.updateGoal(goal.id, patch, { debounce: next.deadline === undefined });
  };

  const changeTitle = (value: string) => {
    const clean = value.replace(/\s*\n\s*/g, " ");
    setTitle(clean);
    setError(null);
    save({ title: clean });
  };
  const changeWhy = (value: string) => {
    setWhy(value);
    save({ why: value });
  };
  const changeDeadline = (value: string | null) => {
    setDeadline(value);
    setNoDate(value === null);
    save({ deadline: value, noDate: value === null });
  };

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const submit = async () => {
    const clean = title.trim();
    if (!clean || busy) return;
    // "By June 2027, I will…" with no date picked: the sentence already names the deadline.
    // Only for a new goal: an existing goal without a date may have had it cleared on
    // purpose, and it must not come back.
    const due = deadline ?? (noDate || goal ? null : deadlineFromText(clean, today));
    if (goal) {
      const patch: GoalPatch = {};
      if (clean !== goal.title) patch.title = clean;
      if (why.trim() !== goal.why) patch.why = why.trim();
      if (due !== goal.deadline) patch.deadline = due;
      if (Object.keys(patch).length) actions.updateGoal(goal.id, patch);
      onNext(goal);
      return;
    }
    // Store the id before sending, so it survives the app closing mid-request.
    const create = (id: string) => {
      draftId.current = id;
      writeDraft({ title, why, deadline, noDate, id });
      return actions.createGoal({ id, title: clean, why: why.trim() || undefined, deadline: due });
    };
    setBusy(true);
    setError(null);
    try {
      let created: GoalWithCells;
      try {
        created = await create(draftId.current ?? newUuid());
      } catch (err) {
        // 409: another account already has a goal with this id (an old draft). Once, with a new id.
        if (!(err instanceof ApiError && err.status === 409)) throw err;
        created = await create(newUuid());
      }
      writeDraft(null);
      if (alive.current) onNext(created);
      else {
        // Closed while saving: do not pull the user back into the flow.
        toast("Goal created", {
          action: {
            label: "Open",
            run: () => navigate({ name: "goal", goalId: created.id, pillar: null, map: false }),
          },
        });
      }
    } catch (err) {
      setBusy(false);
      setError(
        err instanceof ApiError && err.offline
          ? "You're offline. Your goal is kept here; try again when you're back."
          : err instanceof Error
            ? err.message
            : "Could not create the goal.",
      );
    }
  };

  const onTitleKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (event.metaKey || event.ctrlKey) void submit();
    else whyRef.current?.focus();
  };

  const onWhyKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void submit();
  };

  return (
    <>
      <StepBody>
        <div className="mx-auto w-full max-w-[560px] px-4 pt-7 pb-10 sm:pt-12">
          <StepHeading title="What do you want to achieve?" sub="One goal for the middle of your chart." />

          <div className="mt-6 rounded-2xl border border-line-strong px-4 py-3.5 transition-colors focus-within:border-fg">
            <textarea
              ref={titleRef}
              autoFocus
              rows={2}
              value={title}
              onChange={(event) => changeTitle(event.target.value)}
              onKeyDown={onTitleKey}
              placeholder="By June 2027, I will run a half marathon under 2 hours"
              aria-label="Your goal"
              maxLength={200}
              enterKeyHint="next"
              className="block w-full resize-none overflow-hidden bg-transparent text-[20px]! leading-snug font-medium tracking-tight outline-none! placeholder:font-normal placeholder:text-faint sm:text-[22px]!"
            />
          </div>

          {hints.length > 0 && (
            <ul className="mt-3 space-y-1 px-1">
              {hints.map((hint) => (
                <li key={hint} className="text-[13px] leading-snug text-muted">
                  {hint}
                </li>
              ))}
            </ul>
          )}

          <Deadline title={title} today={today} value={deadline} onChange={changeDeadline} />

          <section className="mt-9">
            <label htmlFor="goal-why" className={LABEL}>
              WHY IT MATTERS
            </label>
            <input
              id="goal-why"
              ref={whyRef}
              value={why}
              onChange={(event) => changeWhy(event.target.value)}
              onKeyDown={onWhyKey}
              placeholder="Why does it matter?"
              enterKeyHint="go"
              maxLength={300}
              className="mt-2.5 h-12 w-full rounded-xl border border-line-strong bg-bg px-4 text-[15px] outline-none! transition-colors placeholder:text-faint focus:border-fg"
            />
            <p className="mt-2 text-[13px] text-muted">Optional. On hard days, this is what keeps you going.</p>
          </section>
        </div>
      </StepBody>

      <Dock>
        {error ? (
          <p role="alert" className="mb-2.5 text-center text-[13px] text-danger">
            {error}
          </p>
        ) : (
          offline &&
          !goal && (
            <p className="mb-2.5 text-center text-[13px] text-muted">
              You&apos;re offline. Creating the goal needs a connection.
            </p>
          )
        )}
        <NavRow>
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            loading={busy}
            disabled={!title.trim()}
            onClick={() => void submit()}
          >
            Next
          </Button>
        </NavRow>
      </Dock>
    </>
  );
}

function Deadline({
  title,
  today,
  value,
  onChange,
}: {
  title: string;
  today: string;
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const chips = [
    { label: "3 months", day: addMonths(today, 3) },
    { label: "6 months", day: addMonths(today, 6) },
    { label: "1 year", day: addMonths(today, 12) },
  ];
  // "By June 2027, I will…": offer the date the goal already names.
  const written = deadlineFromText(title, today);
  if (written && !chips.some((chip) => chip.day === written)) chips.push({ label: formatDay(written), day: written });
  const custom = value !== null && !chips.some((chip) => chip.day === value);

  return (
    <section className="mt-9" aria-labelledby="goal-deadline">
      <h2 id="goal-deadline" className={LABEL}>
        BY WHEN
      </h2>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {chips.map((chip) => (
          <Chip
            key={chip.day}
            selected={value === chip.day}
            onClick={() => onChange(value === chip.day ? null : chip.day)}
          >
            {chip.label}
          </Chip>
        ))}
        <DateChip value={value} custom={custom} min={today} onChange={onChange} />
      </div>
      {value && (
        <p className="mt-3 flex items-center gap-2 text-[13px] text-muted">
          <span>By {formatDay(value, true)}</span>
          <button
            type="button"
            onClick={() => onChange(null)}
            className="rounded-full px-1.5 text-faint underline-offset-2 hover:text-fg hover:underline"
          >
            Clear
          </button>
        </p>
      )}
    </section>
  );
}

const CHIP =
  "inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium transition-colors duration-150";

function Chip({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(CHIP, selected ? "border-fg bg-fg text-white" : "border-line-strong text-fg hover:border-fg")}
    >
      {children}
    </button>
  );
}

/** A chip that opens the native date picker (the input sits invisibly on top of it). */
function DateChip({
  value,
  custom,
  min,
  onChange,
}: {
  value: string | null;
  custom: boolean;
  min: string;
  onChange: (value: string | null) => void;
}) {
  const fine = useMediaQuery("(hover: hover) and (pointer: fine)");
  return (
    <label
      className={cn(
        CHIP,
        "relative cursor-pointer focus-within:border-fg",
        custom ? "border-fg bg-fg text-white" : "border-line-strong text-fg hover:border-fg",
      )}
    >
      <CalendarDays size={14} aria-hidden />
      {custom && value ? formatDay(value) : "Pick a date"}
      <input
        type="date"
        min={min}
        value={value ?? ""}
        aria-label="Pick a date"
        onChange={(event) => onChange(event.target.value || null)}
        onClick={(event) => {
          // Desktop browsers open the calendar only from its icon; open it from anywhere.
          if (!fine) return;
          try {
            event.currentTarget.showPicker();
          } catch {
            // Not supported: the field still works by typing.
          }
        }}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
    </label>
  );
}
