"use client";

import { ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";
import { useRef, useState } from "react";
import { Button, IconButton } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { useMediaQuery } from "@/components/ui/hooks";
import { dayKey, isFilled, PILLAR_SLOT } from "@/domain/mandala";
import { actions, goalById } from "@/client/store";
import { toast } from "@/client/toast";
import type { Cell, CellPatch, GoalWithCells } from "@/domain/types";
import { namedPillars, pillarName } from "@/domain/week";
import { Composer } from "./Composer";
import { FocusGrid } from "./FocusGrid";
import {
  actionAt,
  CLEAR_PATCH,
  filledActionCount,
  firstEmptyAction,
  firstPillarToFill,
  nextEmptyAction,
  nextPillarToFill,
  restorePatch,
  stepPillar,
} from "./slots";
import { Dock, keepFocus, LABEL, NavRow, StepBody } from "./StepParts";
import { actionNudges } from "./text";
import { HowOftenPicker, RepeatDayPicker } from "@/components/shared/HowOften";
import { guessHowOften, howOftenPatch, type HowOften } from "@/domain/repeat";

/** Step 3: 8 actions around each pillar, one pillar at a time, with one Enter chain for all 64. */
export function ActionsStep({
  goal,
  typing,
  onComposerFocus,
  onBack,
  onNext,
  onEditPillar,
}: {
  goal: GoalWithCells;
  /** The input has focus and the phone keyboard is up. */
  typing: boolean;
  onComposerFocus: (focused: boolean) => void;
  onBack: () => void;
  onNext: () => void;
  onEditPillar: (pillar: number) => void;
}) {
  const fine = useMediaQuery("(hover: hover) and (pointer: fine)");
  const inputRef = useRef<HTMLInputElement>(null);
  // Squares whose kind you set by hand (never auto-guessed again), and ones the guess made a habit.
  const touched = useRef(new Set<string>());
  const autoHabit = useRef(new Set<string>());
  const [pos, setPos] = useState(() => {
    const pillar = firstPillarToFill(goal) ?? 0;
    return { pillar, slot: firstEmptyAction(goal, pillar) ?? 0 };
  });

  const named = namedPillars(goal);
  // If this pillar lost its name meanwhile (another device), fall back to a named one.
  const pillar = named.includes(pos.pillar) ? pos.pillar : (named[0] ?? pos.pillar);
  const slot = pillar === pos.pillar ? pos.slot : (firstEmptyAction(goal, pillar) ?? 0);
  const cells = Array.from({ length: 8 }, (_, s) => actionAt(goal, pillar, s));
  const cell = cells[slot];
  const text = cell?.text ?? "";
  const name = pillarName(goal, pillar);
  const here = cells.filter(isFilled).length;
  const total = named.reduce((sum, p) => sum + filledActionCount(goal, p), 0);
  const others = goal.cells.filter((c) => c.slot !== PILLAR_SLOT && c.id !== cell?.id && isFilled(c)).map((c) => c.text);
  const hints = actionNudges(text, others);
  const latest = () => goalById(goal.id) ?? goal;

  if (!named.length) {
    return (
      <>
        <StepBody>
          <div className="mx-auto w-full max-w-[560px] px-4 pt-10 text-center">
            <p className="text-[15px] font-medium">Name at least one pillar first.</p>
            <p className="mt-1 text-sm text-muted">Actions go around the pillars.</p>
          </div>
        </StepBody>
        <Dock>
          <NavRow onBack={onBack}>
            <Button variant="primary" size="lg" className="w-full" onClick={onNext}>
              Skip to week 1
            </Button>
          </NavRow>
        </Dock>
      </>
    );
  }

  const goTo = (next: number) => setPos({ pillar: next, slot: firstEmptyAction(latest(), next) ?? 0 });

  const select = (index: number) => {
    setPos({ pillar, slot: index });
    inputRef.current?.focus();
  };

  /** Kind and repeat follow the text, but only until the user picks one by hand. */
  const kindPatch = (target: Cell, value: string): CellPatch => {
    if (touched.current.has(target.id)) return {};
    const guess = guessHowOften(value);
    if (guess.choice !== "task") {
      if (target.kind === "task") autoHabit.current.add(target.id);
      if (!autoHabit.current.has(target.id)) return {};
      return howOftenPatch(target, guess.choice, dayKey(), guess.on);
    }
    if (target.kind === "habit" && autoHabit.current.has(target.id)) {
      autoHabit.current.delete(target.id);
      return { kind: "task" };
    }
    return {};
  };

  const type = (value: string) => {
    if (!cell) return;
    actions.updateCell(cell.id, { text: value, ...kindPatch(cell, value) }, { debounce: true });
  };

  const setHowOften = (choice: HowOften) => {
    if (!cell) return;
    touched.current.add(cell.id);
    autoHabit.current.delete(cell.id);
    actions.updateCell(cell.id, howOftenPatch(cell, choice, dayKey()));
  };

  const setRepeatOn = (on: number) => {
    if (!cell) return;
    touched.current.add(cell.id);
    actions.updateCell(cell.id, { repeatOn: on });
  };

  const enter = (raw: string) => {
    const current = actionAt(latest(), pillar, slot);
    if (!current) return;
    const value = raw.trim();
    if (value !== current.text) actions.updateCell(current.id, { text: value }, { debounce: true });
    if (value) {
      const next = nextEmptyAction(latest(), pillar, slot);
      if (next !== null) {
        setPos({ pillar, slot: next });
        return;
      }
    }
    // This pillar is full, or Enter on an empty line: on to the next pillar with room.
    const following = nextPillarToFill(latest(), pillar);
    if (following !== null) goTo(following);
    else inputRef.current?.blur();
  };

  const clear = () => {
    const current = actionAt(latest(), pillar, slot);
    if (!current || !isFilled(current)) return;
    const before = restorePatch(current);
    actions.updateCell(current.id, CLEAR_PATCH);
    toast("Action cleared", { action: { label: "Undo", run: () => actions.updateCell(current.id, before) } });
    inputRef.current?.focus();
  };

  const prev = () => goTo(stepPillar(goal, pillar, -1));
  const next = () => goTo(stepPillar(goal, pillar, 1));
  const lastStop = nextPillarToFill(goal, pillar) === null && nextEmptyAction(goal, pillar, slot) === null;

  return (
    <>
      <StepBody typing={typing}>
        <div
          className={
            typing ? "flex min-h-0 flex-1 flex-col px-4 pt-1 pb-3" : "mx-auto w-full max-w-[560px] px-4 pt-5 pb-10"
          }
        >
          {typing ? (
            <div className="flex h-11 flex-none items-center gap-1">
              <IconButton label="Previous pillar" onPointerDown={keepFocus} onClick={prev} disabled={named.length < 2}>
                <ChevronLeft size={20} />
              </IconButton>
              <p key={pillar} className="min-w-0 flex-1 animate-fade-in truncate text-center text-[14px] font-semibold">
                {name} <span className="font-mono text-xs font-normal text-faint">{here}/8</span>
              </p>
              <IconButton label="Next pillar" onPointerDown={keepFocus} onClick={next} disabled={named.length < 2}>
                <ChevronRight size={20} />
              </IconButton>
              <Button variant="ghost" size="sm" onClick={() => inputRef.current?.blur()}>
                Done
              </Button>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-1">
                <IconButton label="Previous pillar" onPointerDown={keepFocus} onClick={prev} disabled={named.length < 2}>
                  <ChevronLeft size={20} />
                </IconButton>
                <div key={pillar} className="min-w-0 flex-1 animate-fade-in text-center">
                  <p className={LABEL}>
                    PILLAR {named.indexOf(pillar) + 1} OF {named.length}
                  </p>
                  <h1 className="truncate text-[22px] leading-tight font-semibold tracking-tight">{name}</h1>
                </div>
                <IconButton label="Next pillar" onPointerDown={keepFocus} onClick={next} disabled={named.length < 2}>
                  <ChevronRight size={20} />
                </IconButton>
              </div>
              <div className="mt-2 flex items-center justify-center gap-3">
                <PillarDots goal={goal} current={pillar} onGo={goTo} />
                <span className="font-mono text-xs text-muted" title="Actions written">
                  {total}/{named.length * 8}
                </span>
              </div>
            </div>
          )}

          <div className={typing ? "min-h-0 flex-1 pt-1 [container-type:size]" : "mx-auto mt-5 w-full max-w-[420px]"}>
            <div key={pillar} className={cn("animate-fade-in", typing && "mx-auto w-[min(100cqw,100cqh)]")}>
              <FocusGrid
                compact={typing}
                center={name}
                centerRole="pillar"
                centerLabel={`Pillar: ${name}. Rename it`}
                ring={cells.map((c, s) => ({
                  text: c?.text ?? "",
                  glyph: isFilled(c) && c.kind === "habit" ? "↻" : undefined,
                  label: isFilled(c)
                    ? `Action ${s + 1}${c.kind === "habit" ? " (habit)" : ""}: ${c.text}`
                    : `Action ${s + 1}, empty`,
                }))}
                ringRole="action"
                selected={slot}
                onSelect={select}
                onCenter={() => onEditPillar(pillar)}
                onSwipe={named.length > 1 ? (direction) => (direction > 0 ? next() : prev()) : undefined}
              />
            </div>
          </div>

          <div className={typing ? "flex-none pt-3" : "mx-auto mt-4 w-full max-w-[420px]"}>
            <Composer
              inputRef={inputRef}
              value={text}
              label={`Action ${slot + 1} for ${name}`}
              placeholder="Type an action and press Enter"
              enterKeyHint={lastStop ? "done" : "next"}
              enterLabel={text.trim() ? "Place it and go to the next square" : "Next pillar"}
              hint={hints.length ? hints.slice(0, 2).join(" ") : "Can you tick it off? Is it in your control?"}
              extra={
                isFilled(cell) ? (
                  <span onPointerDown={keepFocus} className="flex flex-wrap items-center justify-end gap-2">
                    <HowOftenPicker size="sm" cell={cell} onPick={setHowOften} />
                    <RepeatDayPicker cell={cell} onPick={setRepeatOn} />
                  </span>
                ) : null
              }
              autoFocus={fine}
              onChange={type}
              onEnter={enter}
              onClear={clear}
              onFocus={() => onComposerFocus(true)}
              onBlur={() => onComposerFocus(false)}
              onSubmit={onNext}
            />
          </div>

          {!typing && (
            <div className="mx-auto mt-7 w-full max-w-[420px] space-y-5">
              <p className="text-[13px] leading-relaxed text-muted">
                Things you can tick off and that are in your control: inputs, not outcomes. &ldquo;Post 2 videos a
                day&rdquo;, not &ldquo;get 10M views&rdquo;.
              </p>
            </div>
          )}
        </div>
      </StepBody>

      {!typing && (
        <Dock>
          {total < named.length * 8 && (
            <p className="mb-2.5 text-center text-xs text-muted">You can fill the rest later.</p>
          )}
          <NavRow onBack={onBack}>
            <Button variant="primary" size="lg" className="w-full" onClick={onNext}>
              Next
              <ArrowRight size={17} />
            </Button>
          </NavRow>
        </Dock>
      )}
    </>
  );
}

/** 8 dots, clockwise from 12 o'clock: hollow = no actions yet, gray = some, black = all 8. */
function PillarDots({
  goal,
  current,
  onGo,
}: {
  goal: GoalWithCells;
  current: number;
  onGo: (pillar: number) => void;
}) {
  const named = new Set(namedPillars(goal));
  return (
    <div role="group" aria-label="Pillars" className="flex items-center">
      {Array.from({ length: 8 }, (_, p) => {
        const isNamed = named.has(p);
        const count = filledActionCount(goal, p);
        return (
          <button
            key={p}
            type="button"
            disabled={!isNamed}
            onPointerDown={keepFocus}
            onClick={() => onGo(p)}
            aria-label={isNamed ? `${pillarName(goal, p)}: ${count} of 8 actions` : `Pillar ${p + 1} has no name`}
            aria-current={p === current ? "true" : undefined}
            className="grid size-7 place-items-center rounded-full disabled:cursor-default"
          >
            <span
              className={cn(
                "block size-2 rounded-full transition-all duration-200",
                p === current && "ring-2 ring-fg ring-offset-2 ring-offset-bg",
                !isNamed
                  ? "bg-line"
                  : count === 8
                    ? "bg-fg"
                    : count > 0
                      ? "bg-fg/40"
                      : "border border-line-strong bg-bg",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
