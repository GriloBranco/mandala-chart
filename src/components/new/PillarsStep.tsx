"use client";

import { ArrowRight, ListPlus } from "lucide-react";
import { useRef, useState } from "react";
import { SuggestionTray } from "@/components/shared/SuggestionTray";
import { GoalGlyph } from "@/components/shell/GoalGlyph";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { useMediaQuery } from "@/components/ui/hooks";
import { isFilled, pillarCell } from "@/domain/mandala";
import { actions, goalById } from "@/client/store";
import { toast } from "@/client/toast";
import type { GoalWithCells, Suggestion } from "@/domain/types";
import { Composer } from "./Composer";
import { FocusGrid } from "./FocusGrid";
import { CLEAR_PATCH, emptyPillarSlots, filledActionCount, firstEmptyPillar, nextEmptyPillar, restorePatch } from "./slots";
import { Dock, LABEL, NavRow, StepBody, StepHeading } from "./StepParts";
import { dumpIdeas, pillarHints, readDump, writeDump } from "./text";
import { useViewport } from "./viewport";

/** Step 2: the 8 pillars around the goal, typed one after another with Enter. */
export function PillarsStep({
  goal,
  initialSlot,
  typing,
  onComposerFocus,
  onEditGoal,
  onBack,
  onNext,
}: {
  goal: GoalWithCells;
  initialSlot: number | null;
  /** The input has focus and the phone keyboard is up. */
  typing: boolean;
  onComposerFocus: (focused: boolean) => void;
  onEditGoal: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const fine = useMediaQuery("(hover: hover) and (pointer: fine)");
  const { keyboard } = useViewport();
  const inputRef = useRef<HTMLInputElement>(null);
  const [slot, setSlot] = useState(() => initialSlot ?? firstEmptyPillar(goal) ?? 0);
  const [dumpFocused, setDumpFocused] = useState(false);
  const [dump, setDump] = useState(() => readDump(goal.id));
  const [dumpOpen, setDumpOpen] = useState(() => dump.trim().length > 0);

  const cells = Array.from({ length: 8 }, (_, p) => pillarCell(goal, p));
  const names = cells.map((c) => c?.text.trim() ?? "");
  const count = names.filter(Boolean).length;
  const cell = cells[slot];
  const text = cell?.text ?? "";
  const hints = pillarHints(
    text,
    names.filter((_, p) => p !== slot),
  );
  const ideas = dumpIdeas(dump, names);
  const latest = () => goalById(goal.id) ?? goal;

  const select = (index: number) => {
    setSlot(index);
    inputRef.current?.focus();
  };

  const type = (value: string) => {
    if (cell) actions.updateCell(cell.id, { text: value }, { debounce: true });
  };

  const enter = (raw: string) => {
    const current = pillarCell(latest(), slot);
    if (!current) return;
    const value = raw.trim();
    if (value !== current.text) actions.updateCell(current.id, { text: value }, { debounce: true });
    const next = value ? nextEmptyPillar(latest(), slot) : null;
    if (next !== null) setSlot(next);
    // Nothing left to name (or Enter on an empty line): put the keyboard away to show Next.
    else inputRef.current?.blur();
  };

  const clear = () => {
    const current = pillarCell(latest(), slot);
    if (!current || !isFilled(current)) return;
    const before = restorePatch(current);
    actions.updateCell(current.id, CLEAR_PATCH);
    toast("Pillar cleared", { action: { label: "Undo", run: () => actions.updateCell(current.id, before) } });
    inputRef.current?.focus();
  };

  const changeDump = (value: string) => {
    setDump(value);
    writeDump(goal.id, value);
  };

  /**
   * Places a pillar in the selected square if it is empty, else the next empty one. From the
   * brain dump, a full chart swaps the selected square and keeps the old name as an idea.
   */
  const place = (idea: string, swap: boolean) => {
    const g = latest();
    const selected = pillarCell(g, slot);
    const target = !isFilled(selected) ? slot : nextEmptyPillar(g, slot);
    if (target === null) {
      if (!swap || !selected) {
        toast("All 8 are named. Clear one to add another.");
        return;
      }
      const previous = selected.text.trim();
      const swapIn = () => {
        actions.updateCell(selected.id, { text: idea });
        if (!dumpIdeas(dump, []).some((d) => d.toLowerCase() === previous.toLowerCase())) {
          changeDump(`${dump.replace(/\s+$/, "")}\n${previous}`.replace(/^\n/, ""));
        }
        toast(`Swapped out ${previous}`, {
          action: { label: "Undo", run: () => actions.updateCell(selected.id, { text: previous }) },
        });
      };
      // Its actions would stay under the new name, so ask before renaming a pillar in use.
      const count = filledActionCount(g, slot);
      if (count > 0) {
        toast(`${previous} has ${count} action${count === 1 ? "" : "s"}. They would move to the new name.`, {
          action: { label: "Swap anyway", run: swapIn },
        });
        return;
      }
      swapIn();
      return;
    }
    const targetCell = pillarCell(g, target);
    if (!targetCell) return;
    actions.updateCell(targetCell.id, { text: idea });
    setSlot(nextEmptyPillar(latest(), target) ?? target);
  };

  const placeAll = (items: Suggestion[]) => {
    const g = latest();
    const updates = emptyPillarSlots(g, slot)
      .slice(0, items.length)
      .flatMap((p, i) => {
        const target = pillarCell(g, p);
        return target ? [{ id: target.id, patch: { text: items[i].text } }] : [];
      });
    if (!updates.length) {
      toast("All 8 are named. Clear one to add another.");
      return;
    }
    actions.updateCells(updates);
    toast(`Added ${updates.length}`, {
      action: { label: "Undo", run: () => actions.updateCells(updates.map((u) => ({ id: u.id, patch: { text: "" } }))) },
    });
    setSlot(firstEmptyPillar(latest()) ?? slot);
  };

  const hideDock = typing || (dumpFocused && keyboard);

  return (
    <>
      <StepBody typing={typing}>
        <div
          className={
            typing ? "flex min-h-0 flex-1 flex-col px-4 pt-1 pb-3" : "mx-auto w-full max-w-[560px] px-4 pt-6 pb-10"
          }
        >
          {typing ? (
            <div className="flex h-10 flex-none items-center gap-2">
              <span className={cn(LABEL, "flex-1")}>PILLARS · {count}/8</span>
              <Button variant="ghost" size="sm" onClick={() => inputRef.current?.blur()}>
                Done
              </Button>
            </div>
          ) : (
            <StepHeading
              title="8 things that make it happen"
              sub="To reach this, what has to be true? Brain dump first, then keep the 8 that matter most."
            />
          )}

          <div className={typing ? "min-h-0 flex-1 [container-type:size]" : "mx-auto mt-6 w-full max-w-[420px]"}>
            <FocusGrid
              compact={typing}
              className={typing ? "mx-auto w-[min(100cqw,100cqh)]" : undefined}
              center={goal.title}
              centerRole="goal"
              centerLabel={`Goal: ${goal.title}. Edit the goal`}
              ring={cells.map((c, p) => ({
                text: c?.text ?? "",
                label: isFilled(c) ? `Pillar ${p + 1}: ${c.text}` : `Pillar ${p + 1}, empty`,
              }))}
              ringRole="pillar"
              selected={slot}
              onSelect={select}
              onCenter={onEditGoal}
            />
          </div>

          <div className={typing ? "flex-none pt-3" : "mx-auto mt-4 w-full max-w-[420px]"}>
            <Composer
              inputRef={inputRef}
              value={text}
              label={`Pillar ${slot + 1}`}
              placeholder="Type a pillar and press Enter"
              enterKeyHint={nextEmptyPillar(goal, slot) !== null ? "next" : "done"}
              enterLabel={text.trim() ? "Place it and go to the next square" : "Done typing"}
              hint={hints.length ? hints.join(" ") : typing ? "Think mind, skill, body and daily life." : null}
              autoFocus={fine}
              onChange={type}
              onEnter={enter}
              onClear={clear}
              onFocus={() => onComposerFocus(true)}
              onBlur={() => onComposerFocus(false)}
              onSubmit={count > 0 ? onNext : undefined}
            />
          </div>

          {!typing && (
            <div className="mx-auto mt-7 w-full max-w-[420px] space-y-6">
              <p className="text-[13px] leading-relaxed text-muted">
                Cover mind, skill, body and daily life. Ohtani&apos;s chart had character and luck pillars.
              </p>
              {dumpOpen ? (
                <BrainDump
                  value={dump}
                  ideas={ideas}
                  named={names.map((n) => (n ? 1 : null))}
                  onChange={changeDump}
                  onPlace={(idea) => place(idea, true)}
                  onFocus={() => setDumpFocused(true)}
                  onBlur={() => setDumpFocused(false)}
                />
              ) : (
                <Button variant="secondary" size="sm" icon={<ListPlus size={15} />} onClick={() => setDumpOpen(true)}>
                  Brain dump
                </Button>
              )}
              <SuggestionTray
                goalId={goal.id}
                target="pillars"
                existing={names}
                onPick={(suggestion) => place(suggestion.text, false)}
                onPickAll={placeAll}
              />
            </div>
          )}
        </div>
      </StepBody>

      {!hideDock && (
        <Dock>
          {count < 8 && (
            <p className="mb-2.5 text-center text-xs text-muted">
              {count === 0 ? "Name at least one pillar to go on." : "You can fill the rest later."}
            </p>
          )}
          <NavRow onBack={onBack}>
            <Button variant="primary" size="lg" className="w-full" disabled={count === 0} onClick={onNext}>
              Next
              <ArrowRight size={17} />
            </Button>
          </NavRow>
        </Dock>
      )}
    </>
  );
}

/** Write every idea, one per line; tap the best ones to place them in the chart. */
function BrainDump({
  value,
  ideas,
  named,
  onChange,
  onPlace,
  onFocus,
  onBlur,
}: {
  value: string;
  ideas: string[];
  /** Per pillar: 1 when named, null when empty (a live mini chart next to the ideas). */
  named: (number | null)[];
  onChange: (value: string) => void;
  onPlace: (idea: string) => void;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const count = named.filter(Boolean).length;
  const full = count === 8;
  return (
    <section className="animate-fade-in" aria-labelledby="brain-dump">
      <h2 id="brain-dump" className={LABEL}>
        BRAIN DUMP
      </h2>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={(event) => {
          onFocus();
          // Once the keyboard is up, bring the box back into view.
          const box = event.currentTarget;
          setTimeout(() => box.scrollIntoView({ block: "nearest", behavior: "smooth" }), 350);
        }}
        onBlur={onBlur}
        rows={5}
        placeholder={"Every idea, one per line.\nThen tap the best ones to place them."}
        aria-label="Brain dump, one idea per line"
        className="mt-2.5 block w-full resize-y rounded-2xl border border-line-strong bg-bg px-4 py-3 text-[15px] leading-relaxed outline-none! transition-colors placeholder:text-faint focus:border-fg"
      />
      {ideas.length > 0 && (
        <div className="mt-3">
          <div className="flex items-center gap-2">
            <GoalGlyph pillars={named} size={16} />
            <p className="min-w-0 flex-1 text-xs text-muted">
              {full
                ? "All 8 named. Tap an idea to swap it into the selected square."
                : `${count}/8 named. Tap an idea to place it.`}
            </p>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {ideas.map((idea) => (
              <button
                key={idea}
                type="button"
                onClick={() => onPlace(idea)}
                className="max-w-full animate-fade-in truncate rounded-full border border-line-strong px-3 py-1.5 text-[13px] text-fg transition-colors hover:border-fg active:bg-soft"
              >
                {idea}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
