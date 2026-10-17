"use client";

import { ChevronLeft, ChevronRight, Zap } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { RING, dayKey, fillCounts, goalProgress, isFilled, pillarProgress, ringIndex } from "@/lib/mandala";
import { navigate } from "@/lib/nav";
import { useAppState } from "@/lib/store";
import type { Cell, Checkin, GoalWithCells } from "@/lib/types";
import { Block3x3, Square } from "@/components/shared/Square";
import { SuggestionTray } from "@/components/shared/SuggestionTray";
import { Button, IconButton } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { useReducedMotion } from "@/components/ui/hooks";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { clampClass, useSquareLines } from "./clamp";
import { fillSquares } from "./edits";
import { flashSquares, useChangeFlash } from "./flash";
import {
  GOAL_COORD,
  actionCoord,
  chartHint,
  glyphsFor,
  indexGoal,
  isMarked,
  leverPillar,
  namedPillars,
  pillarCoord,
  pillarName,
  squareLabel,
  weekCount,
  type ChartIndex,
  type Coord,
} from "./model";

type Motion =
  { kind: "zoom-in"; position: number } | { kind: "zoom-out"; position: number } | { kind: "next" } | { kind: "prev" };

const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
// Full width on a phone, but small enough that the block and its progress fit on screen
// in landscape and on tablets.
const BLOCK_SIZE = "min(480px, max(270px, calc(100dvh - 300px)))";
const SWIPE_DISTANCE = 64;

/**
 * Phone: one 3x3 at a time. The center block holds the goal and its 8 pillars; tap a named pillar
 * to zoom into its block of 8 actions. Swipe left or right there to walk the pillars clockwise.
 */
export function FocusView({
  goal,
  pillar,
  onEdit,
  onMenu,
}: {
  goal: GoalWithCells;
  pillar: number | null;
  /** Opens the editor sheet for a square. */
  onEdit: (coord: Coord) => void;
  /** Long-press menu for a filled action. */
  onMenu: (cellId: string) => void;
}) {
  const { checkins } = useAppState();
  const today = dayKey();
  const reduced = useReducedMotion();
  const index = useMemo(() => indexGoal(goal), [goal]);
  const glyphs = useMemo(() => glyphsFor(goal, checkins, today), [goal, checkins, today]);
  const lever = leverPillar(index);

  const rootRef = useRef<HTMLDivElement>(null);
  const blockRef = useRef<HTMLDivElement>(null);
  /** The motion planned by the tap or swipe that changed the pillar. */
  const motion = useRef<Motion | null>(null);
  const shown = useRef(pillar);
  const drag = useRef<{ id: number; x: number; y: number; dx: number; active: boolean } | null>(null);
  const swallowClick = useRef(false);

  useChangeFlash(rootRef, goal, checkins, glyphs, today, null);
  useSquareLines(blockRef);

  // Zoom into the tapped pillar, zoom back out to it, or slide to the next one.
  useLayoutEffect(() => {
    const from = shown.current;
    shown.current = pillar;
    const planned = motion.current;
    motion.current = null;
    const el = blockRef.current;
    if (from === pillar || !el) return;
    el.style.transform = "";
    el.style.opacity = "";
    if (reduced || typeof el.animate !== "function") return;
    play(el, planned ?? inferMotion(from, pillar));
  }, [pillar, reduced]);

  function go(next: number | null, how: Motion, replace = false) {
    motion.current = how;
    navigate({ name: "goal", goalId: goal.id, pillar: next, map: false }, { replace });
  }

  function step(direction: 1 | -1) {
    if (pillar === null) return;
    go((pillar + direction + 8) % 8, direction === 1 ? { kind: "next" } : { kind: "prev" }, true);
  }

  // ---------- swipe (pillar view only) ----------

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (pillar === null || !event.isPrimary) return;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, active: false };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (!d.active) {
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
        drag.current = null; // a scroll, not a swipe
        return;
      }
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
      d.active = true;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // The pointer is already gone; the swipe still works without capture.
      }
    }
    d.dx = dx;
    const el = blockRef.current;
    if (el) {
      el.style.transform = `translateX(${dx * 0.5}px)`;
      el.style.opacity = String(1 - Math.min(0.45, Math.abs(dx) / 700));
    }
  }

  function onPointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    drag.current = null;
    if (!d.active) return;
    // The finger lifted on a square; that is not a tap.
    swallowClick.current = true;
    setTimeout(() => {
      swallowClick.current = false;
    }, 400);
    const el = blockRef.current;
    if (event.type === "pointerup" && Math.abs(d.dx) > SWIPE_DISTANCE) {
      step(d.dx < 0 ? 1 : -1);
      return;
    }
    if (!el) return;
    const from = { transform: el.style.transform || "none", opacity: el.style.opacity || "1" };
    el.style.transform = "";
    el.style.opacity = "";
    if (!reduced && typeof el.animate === "function") {
      el.animate([from, { transform: "none", opacity: "1" }], { duration: 200, easing: EASE });
    }
  }

  function onClickCapture(event: MouseEvent<HTMLDivElement>) {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  }

  const onFilled = (ids: string[]) => flashSquares(rootRef.current, ids);

  return (
    <div ref={rootRef} className="mx-auto w-full max-w-[560px] px-4 pt-4 pb-10">
      <div className="mx-auto" style={{ maxWidth: BLOCK_SIZE }}>
        <div
          ref={blockRef}
          className={cn(pillar !== null && "touch-pan-y")}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onClickCapture={onClickCapture}
        >
          {pillar === null ? (
            <CenterBlock
              goal={goal}
              index={index}
              lever={lever}
              checkins={checkins}
              today={today}
              onEdit={onEdit}
              onOpen={(p) => go(p, { kind: "zoom-in", position: RING[p] })}
            />
          ) : (
            <PillarBlock
              goal={goal}
              index={index}
              pillar={pillar}
              lever={lever}
              glyphs={glyphs}
              onEdit={onEdit}
              onMenu={onMenu}
            />
          )}
        </div>

        {pillar === null ? (
          <CenterFooter goal={goal} index={index} checkins={checkins} today={today} onFilled={onFilled} />
        ) : (
          <PillarFooter
            goal={goal}
            index={index}
            pillar={pillar}
            checkins={checkins}
            today={today}
            onStep={step}
            onEdit={onEdit}
            onFilled={onFilled}
          />
        )}
      </div>
    </div>
  );
}

function inferMotion(from: number | null, to: number | null): Motion {
  if (from === null && to !== null) return { kind: "zoom-in", position: RING[to] };
  if (from !== null && to === null) return { kind: "zoom-out", position: RING[from] };
  if (from !== null && to !== null) return (to - from + 8) % 8 <= 4 ? { kind: "next" } : { kind: "prev" };
  return { kind: "next" };
}

function play(el: HTMLElement, motion: Motion) {
  if (motion.kind === "next" || motion.kind === "prev") {
    const dx = motion.kind === "next" ? 56 : -56;
    el.animate(
      [
        { transform: `translateX(${dx}px)`, opacity: 0 },
        { transform: "none", opacity: 1 },
      ],
      {
        duration: 260,
        easing: EASE,
      },
    );
    return;
  }
  // Grow out of (or shrink back into) the pillar's square in the center block.
  const origin = `${(motion.position % 3) * 50}% ${Math.floor(motion.position / 3) * 50}%`;
  const start = motion.kind === "zoom-in" ? "scale(0.4)" : "scale(1.6)";
  el.animate(
    [
      { transform: start, transformOrigin: origin, opacity: 0 },
      { transform: "none", transformOrigin: origin, opacity: 1 },
    ],
    { duration: 320, easing: EASE },
  );
}

// ---------- center block: the goal and its 8 pillars ----------

function CenterBlock({
  goal,
  index,
  lever,
  checkins,
  today,
  onEdit,
  onOpen,
}: {
  goal: GoalWithCells;
  index: ChartIndex;
  lever: number | null;
  checkins: Checkin[];
  today: string;
  onEdit: (coord: Coord) => void;
  onOpen: (pillar: number) => void;
}) {
  return (
    <Block3x3 gap="focus">
      {Array.from({ length: 9 }, (_, position) => {
        if (position === 4) {
          return (
            <div key={position}>
              <Square
                role="goal"
                size="focus"
                text={goal.title}
                label={`Goal: ${goal.title}. Tap to edit.`}
                onClick={() => onEdit(GOAL_COORD)}
                className={clampClass("goal", goal.title)}
              />
            </div>
          );
        }
        const p = ringIndex(position);
        const cell = index.pillars[p];
        const named = isFilled(cell);
        const hasActions = index.actions[p].some((c) => isFilled(c));
        return (
          <div key={position} data-cell={cell?.id}>
            <Square
              role="pillar"
              size="focus"
              text={cell?.text ?? ""}
              placeholder="+"
              lever={p === lever}
              label={named ? `${cell.text}. Open its actions.` : `Add pillar ${p + 1}`}
              onClick={() => (named ? onOpen(p) : onEdit(pillarCoord(p)))}
              onLongPress={() => onEdit(pillarCoord(p))}
              className={clampClass("pillar", cell?.text ?? "")}
            >
              {named && hasActions && <MiniBar value={pillarProgress(goal, p, checkins, today)} />}
            </Square>
          </div>
        );
      })}
    </Block3x3>
  );
}

/** A pillar's progress along the bottom of its square. */
function MiniBar({ value }: { value: number }) {
  return (
    <span aria-hidden className="absolute inset-x-3 bottom-2.5 h-[3px] overflow-hidden rounded-full bg-black/[0.07]">
      <span
        className="block h-full rounded-full bg-fg/70 transition-[width] duration-500"
        style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }}
      />
    </span>
  );
}

function CenterFooter({
  goal,
  index,
  checkins,
  today,
  onFilled,
}: {
  goal: GoalWithCells;
  index: ChartIndex;
  checkins: Checkin[];
  today: string;
  onFilled: (ids: string[]) => void;
}) {
  const counts = fillCounts(goal);
  const week = weekCount(goal);
  const progress = goalProgress(goal, checkins, today);
  const hint = chartHint(counts, week.actions, "phone");
  const emptyPillars = index.pillars.filter((c): c is Cell => Boolean(c) && !isFilled(c));

  return (
    <div className="mt-5 space-y-4">
      {counts.actions > 0 && (
        <div className="space-y-1.5">
          <ProgressBar value={progress} />
          <div className="flex justify-between font-mono text-[11px] text-muted">
            <span>
              {counts.actions}/64 actions{week.actions ? ` · ${week.actions} this week` : ""}
            </span>
            <span>{Math.round(progress * 100)}%</span>
          </div>
        </div>
      )}
      {hint && <p className="text-[13.5px] leading-relaxed text-muted">{hint}</p>}
      {counts.actions > 0 && week.actions === 0 && (
        <Button
          variant="secondary"
          size="sm"
          icon={<Zap size={14} />}
          onClick={() => navigate({ name: "lever", goalId: goal.id })}
        >
          Pick this week&apos;s actions
        </Button>
      )}
      {emptyPillars.length > 0 && (
        <SuggestionTray
          goalId={goal.id}
          target="pillars"
          existing={index.pillars.filter((c) => isFilled(c)).map((c) => c?.text ?? "")}
          onPick={(suggestion) => onFilled(fillSquares(emptyPillars, [suggestion], "pillars"))}
          onPickAll={(list) => onFilled(fillSquares(emptyPillars, list, "pillars"))}
        />
      )}
    </div>
  );
}

// ---------- one pillar: its 8 actions ----------

function PillarBlock({
  goal,
  index,
  pillar,
  lever,
  glyphs,
  onEdit,
  onMenu,
}: {
  goal: GoalWithCells;
  index: ChartIndex;
  pillar: number;
  lever: number | null;
  glyphs: Map<string, string | undefined>;
  onEdit: (coord: Coord) => void;
  onMenu: (cellId: string) => void;
}) {
  const own = index.pillars[pillar];
  const named = isFilled(own);
  return (
    <Block3x3 gap="focus">
      {Array.from({ length: 9 }, (_, position) => {
        if (position === 4) {
          return (
            <div key={position} data-cell={own?.id}>
              <Square
                role="pillar"
                size="focus"
                text={own?.text ?? ""}
                placeholder="Name this pillar"
                lever={pillar === lever}
                label={named ? `Pillar: ${own.text}. Tap to edit.` : `Name pillar ${pillar + 1}`}
                onClick={() => onEdit(pillarCoord(pillar, true))}
                className={clampClass("pillar", own?.text ?? "")}
              />
            </div>
          );
        }
        const slot = ringIndex(position);
        const cell = index.actions[pillar][slot];
        const filled = isFilled(cell);
        return (
          <div key={position} data-cell={cell?.id}>
            <Square
              role="action"
              size="focus"
              text={cell?.text ?? ""}
              glyph={cell ? glyphs.get(cell.id) : undefined}
              marker={isMarked(cell)}
              muted={cell?.status === "done"}
              dim={!named}
              label={squareLabel(goal, index, { role: "action", pillar, slot })}
              onClick={() => onEdit(actionCoord(pillar, slot))}
              onLongPress={filled && cell ? () => onMenu(cell.id) : undefined}
              className={clampClass("action", cell?.text ?? "")}
            />
          </div>
        );
      })}
    </Block3x3>
  );
}

function PillarFooter({
  goal,
  index,
  pillar,
  checkins,
  today,
  onStep,
  onEdit,
  onFilled,
}: {
  goal: GoalWithCells;
  index: ChartIndex;
  pillar: number;
  checkins: Checkin[];
  today: string;
  onStep: (direction: 1 | -1) => void;
  onEdit: (coord: Coord) => void;
  onFilled: (ids: string[]) => void;
}) {
  const named = isFilled(index.pillars[pillar]);
  const own = index.actions[pillar];
  const filled = own.filter((c) => isFilled(c)).length;
  const week = own.filter((c) => isMarked(c)).length;
  const empty = own.filter((c): c is Cell => Boolean(c) && !isFilled(c));
  const progress = pillarProgress(goal, pillar, checkins, today);
  const names = namedPillars(index);

  return (
    <div className="mt-5">
      <div className="space-y-1.5">
        <ProgressBar value={progress} />
        <div className="flex justify-between font-mono text-[11px] text-muted">
          <span>
            {filled}/8 actions{week ? ` · ${week} this week` : ""}
          </span>
          <span>{Math.round(progress * 100)}%</span>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between">
        <IconButton label="Previous pillar" size="lg" onClick={() => onStep(-1)} className="-ml-2.5">
          <ChevronLeft size={20} />
        </IconButton>
        <div className="flex items-center gap-1.5" role="img" aria-label={`Pillar ${pillar + 1} of 8`}>
          {names.map((on, p) => (
            <span
              key={p}
              className={cn(
                "h-1.5 rounded-full transition-all duration-200",
                p === pillar ? "w-4 bg-fg" : on ? "w-1.5 bg-faint" : "w-1.5 bg-line-strong",
              )}
            />
          ))}
        </div>
        <IconButton label="Next pillar" size="lg" onClick={() => onStep(1)} className="-mr-2.5">
          <ChevronRight size={20} />
        </IconButton>
      </div>

      {!named ? (
        <p className="mt-3 text-center text-[13.5px] text-muted">
          Name the pillar first.{" "}
          <button
            type="button"
            className="font-medium text-fg underline underline-offset-2"
            onClick={() => onEdit(pillarCoord(pillar, true))}
          >
            Name it
          </button>
        </p>
      ) : (
        empty.length > 0 && (
          <SuggestionTray
            key={`actions-${pillar}`}
            goalId={goal.id}
            target="actions"
            pillar={pillar}
            existing={goal.cells.filter((c) => c.slot >= 0 && isFilled(c)).map((c) => c.text)}
            onPick={(suggestion) => onFilled(fillSquares(empty, [suggestion], "actions"))}
            onPickAll={(list) => onFilled(fillSquares(empty, list, `actions to ${pillarName(index, pillar)}`))}
            className="mt-3"
          />
        )
      )}
    </div>
  );
}
