"use client";

import { X, Zap } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type Ref,
  type RefObject,
} from "react";
import { dayKey, fillCounts, gridCoord, isFilled, pillarProgress, ringIndex } from "@/domain/mandala";
import { navigate } from "@/client/nav";
import { useAppState } from "@/client/store";
import type { Cell, Checkin, GoalWithCells } from "@/domain/types";
import { weekInfo } from "@/domain/week";
import { Block3x3, Square } from "@/components/shared/Square";
import { SuggestionTray } from "@/components/shared/SuggestionTray";
import { Button, IconButton } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { CellEditor, type EditorTarget } from "./CellEditor";
import { clampClass, useSquareLines } from "./clamp";
import { clearSquare, fillSquares } from "./edits";
import { flashSquares, useChangeFlash } from "./flash";
import {
  GOAL_COORD,
  blockOf,
  cellAt,
  chartHint,
  clampCoord,
  coordKey,
  glyphsFor,
  indexGoal,
  isMarked,
  leverPillar,
  nextEmptyInBlock,
  pillarCoord,
  pillarName,
  sameCoord,
  squareAt,
  squareLabel,
  weekCount,
  type ChartIndex,
  type Coord,
} from "./model";
import { Field, GlyphLegend } from "./parts";

export interface DesktopChartHandle {
  /** Selects the goal in the middle and puts the cursor in its title. */
  editGoal(): void;
}

const ARROWS: Record<string, [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

// The chart is a square that fits the window: never wider than 760px, never taller than the
// space under the header, so the whole 9x9 is always in view.
function chartSize(offset: number) {
  return `max(420px, min(760px, calc(100dvh - 7rem - ${offset}px)))`;
}

/**
 * Desktop: the full 9x9 with an inspector on the right. Click a square to edit it; arrows move,
 * Enter edits, Esc steps back out. In the text field, Enter jumps to the next empty square of
 * the same block, so a block can be filled in one go.
 */
export function DesktopChart({
  goal,
  pillar,
  offset = 0,
  ref,
}: {
  goal: GoalWithCells;
  pillar: number | null;
  /** Height of anything between the header and the chart (a status banner), in px. */
  offset?: number;
  ref?: Ref<DesktopChartHandle>;
}) {
  const { checkins } = useAppState();
  const today = dayKey();
  const index = useMemo(() => indexGoal(goal), [goal]);
  const glyphs = useMemo(() => glyphsFor(goal, checkins, today), [goal, checkins, today]);
  const lever = leverPillar(index);

  const [sel, setSel] = useState<Coord | null>(() => (pillar !== null ? pillarCoord(pillar, true) : null));
  const [focusTick, setFocusTick] = useState(0);
  // Another screen can open this goal at a pillar (?p=3): select that pillar's block.
  const [urlPillar, setUrlPillar] = useState(pillar);
  if (pillar !== urlPillar) {
    setUrlPillar(pillar);
    if (pillar !== null) setSel(pillarCoord(pillar, true));
  }

  const gridRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  /** Where the arrows pick up again after Esc. */
  const lastSel = useRef<Coord>(GOAL_COORD);

  function select(next: Coord | null, options: { focusText?: boolean } = {}) {
    setSel(next);
    if (next) lastSel.current = next;
    if (next && options.focusText) setFocusTick((tick) => tick + 1);
  }

  function focusSquare(coord: Coord) {
    gridRef.current?.querySelector<HTMLElement>(`[data-rc="${coordKey(coord)}"] > button`)?.focus();
  }

  function advance(via: "enter" | "pick") {
    if (!sel) return;
    const next = nextEmptyInBlock(index, sel);
    if (next) select(next, { focusText: via === "enter" });
    else if (via === "enter") focusSquare(sel);
  }

  useImperativeHandle(ref, () => ({ editGoal: () => select(GOAL_COORD, { focusText: true }) }));

  // A newly picked square starts at the top of the panel. The panel would keep the last
  // square's scroll, and the text field gets focus without scrolling, so it could be hidden.
  const selKey = sel ? coordKey(sel) : null;
  useLayoutEffect(() => {
    panelRef.current?.scrollTo({ top: 0 });
  }, [selKey]);

  // Put the cursor at the end of the text once the inspector shows the selected square.
  useEffect(() => {
    if (!focusTick) return;
    const el = textRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focusTick]);

  // One tab stop for the whole grid (the selected square); arrows do the rest.
  useEffect(() => {
    const root = gridRef.current;
    if (!root) return;
    const active = coordKey(sel ?? lastSel.current);
    for (const wrap of root.querySelectorAll<HTMLElement>("[data-rc]")) {
      const button = wrap.firstElementChild;
      if (button instanceof HTMLElement) button.tabIndex = wrap.dataset.rc === active ? 0 : -1;
    }
  }, [sel]);

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (document.querySelector('[aria-modal="true"]')) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest('[role="menu"], [role="dialog"]')) return;
    const inGrid = Boolean(target?.closest("[data-chart-grid]"));
    const inPanel = Boolean(target?.closest("[data-chart-panel]"));
    const loose = !target || target === document.body;

    if (event.key === "Escape") {
      if (!sel) return;
      event.preventDefault();
      if (inPanel) {
        focusSquare(sel);
      } else if (inGrid || loose) {
        select(null);
        target?.blur();
      }
      return;
    }
    if (!inGrid && !loose) return;

    const step = ARROWS[event.key];
    if (step) {
      event.preventDefault();
      const next = sel ? clampCoord(sel.row + step[0], sel.col + step[1]) : lastSel.current;
      select(next);
      focusSquare(next);
      return;
    }
    if (!sel) return;
    if (event.key === "Enter") {
      event.preventDefault();
      select(sel, { focusText: true });
    } else if ((event.key === "Backspace" || event.key === "Delete") && inGrid) {
      // Only from the square itself. Focus drops to the page after some clicks in the
      // inspector, and a Backspace meant for the text must not wipe the whole square.
      const cell = cellAt(index, squareAt(sel));
      if (!cell) return;
      event.preventDefault();
      clearSquare(cell.id);
    }
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const selectedCell = sel ? cellAt(index, squareAt(sel)) : undefined;
  useChangeFlash(gridRef, goal, checkins, glyphs, today, selectedCell?.id ?? null);
  useSquareLines(gridRef, { scaleFont: true });

  const onFilled = (ids: string[]) => flashSquares(gridRef.current, ids);

  function onBackground(event: MouseEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("button, a, input, textarea, select")) return;
    if (sel) select(null);
  }

  return (
    <div className="flex min-h-[520px]" style={{ height: `calc(100dvh - 4rem - ${offset}px)` }}>
      <div className="min-w-0 flex-1 overflow-y-auto p-6" onClick={onBackground}>
        <div
          ref={gridRef}
          data-chart-grid
          role="group"
          aria-label="Mandala chart. Arrow keys move, Enter edits."
          className="mx-auto grid w-full grid-cols-3 gap-3"
          style={{ maxWidth: chartSize(offset) }}
        >
          {Array.from({ length: 9 }, (_, block) => (
            <GridBlock
              key={block}
              block={block}
              goal={goal}
              index={index}
              glyphs={glyphs}
              lever={lever}
              sel={sel}
              onPick={(coord) => select(coord, { focusText: true })}
              onFocusSquare={(coord) => select(coord)}
            />
          ))}
        </div>
      </div>

      {/* Narrow desktops (small windows, tablets) give the chart the room until a square is picked. */}
      <aside
        ref={panelRef}
        data-chart-panel
        aria-label={sel ? "Edit square" : "Goal overview"}
        className={cn(
          // scroll-pt-14: the caret stays clear of the inspector's sticky header while typing.
          "w-[300px] shrink-0 scroll-pt-14 overflow-y-auto border-l border-line min-[1440px]:w-[340px]",
          !sel && "hidden min-[1280px]:block",
        )}
      >
        {sel ? (
          <Inspector
            goal={goal}
            index={index}
            coord={sel}
            lever={lever}
            textRef={textRef}
            onClose={() => select(null)}
            onAdvance={advance}
            onEscape={() => focusSquare(sel)}
            onOpenPillar={(p) => select(pillarCoord(p, true), { focusText: true })}
            onFilled={onFilled}
          />
        ) : (
          <Overview
            goal={goal}
            index={index}
            checkins={checkins}
            today={today}
            lever={lever}
            onSelect={(coord, focusText) => select(coord, { focusText })}
            onFilled={onFilled}
          />
        )}
      </aside>
    </div>
  );
}

// ---------- grid ----------

function GridBlock({
  block,
  goal,
  index,
  glyphs,
  lever,
  sel,
  onPick,
  onFocusSquare,
}: {
  block: number;
  goal: GoalWithCells;
  index: ChartIndex;
  glyphs: Map<string, string | undefined>;
  lever: number | null;
  sel: Coord | null;
  onPick: (coord: Coord) => void;
  onFocusSquare: (coord: Coord) => void;
}) {
  const pillar = block === 4 ? null : ringIndex(block);
  const unnamed = pillar !== null && !isFilled(index.pillars[pillar]);
  const selectedHere = sel !== null && blockOf(sel) === block;

  return (
    <div className="group/block relative">
      <Block3x3 gap="grid">
        {Array.from({ length: 9 }, (_, position) => {
          const coord = gridCoord(block, position);
          const ref = squareAt(coord);
          const cell = cellAt(index, ref);
          const text = ref.role === "goal" ? goal.title : (cell?.text ?? "");
          const selected = sameCoord(sel, coord);
          return (
            <div
              key={position}
              data-rc={coordKey(coord)}
              data-cell={cell?.id}
              // Keyboard focus only; clicks select in onClick. Chrome focuses the square on
              // mousedown, and selecting there opens the inspector on narrow windows, which
              // shrinks the grid so the mouseup misses the square and the click deselects.
              onFocus={(event) => {
                if (!selected && (event.target as HTMLElement).matches(":focus-visible")) onFocusSquare(coord);
              }}
            >
              <Square
                role={ref.role}
                size="grid"
                text={text}
                placeholder={ref.role === "pillar" ? "+" : undefined}
                glyph={ref.role === "action" && cell ? glyphs.get(cell.id) : undefined}
                marker={ref.role === "action" && isMarked(cell)}
                muted={ref.role === "action" && cell?.status === "done"}
                lever={ref.role === "pillar" && ref.pillar === lever}
                dim={ref.role === "action" && unnamed && !selected}
                selected={selected}
                label={squareLabel(goal, index, ref)}
                onClick={() => onPick(coord)}
                // The selected ring is the focus ring here (the global outline would double it).
                // On the black goal square it needs a white gap to show.
                className={cn(
                  "focus-visible:outline-none!",
                  clampClass(ref.role, text),
                  selected && ref.role === "goal" && "shadow-[0_0_0_2px_var(--bg),0_0_0_4px_var(--fg)]!",
                )}
              />
            </div>
          );
        })}
      </Block3x3>
      {unnamed && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-1.5 mx-auto w-fit rounded-full bg-fg px-2.5 py-1 text-[11px] font-medium whitespace-nowrap text-white opacity-0 transition-opacity duration-150 group-hover/block:opacity-100",
            selectedHere && "opacity-100",
          )}
        >
          Name the pillar first
        </span>
      )}
    </div>
  );
}

// ---------- inspector ----------

function Inspector({
  goal,
  index,
  coord,
  lever,
  textRef,
  onClose,
  onAdvance,
  onEscape,
  onOpenPillar,
  onFilled,
}: {
  goal: GoalWithCells;
  index: ChartIndex;
  coord: Coord;
  lever: number | null;
  textRef: RefObject<HTMLTextAreaElement | null>;
  onClose: () => void;
  onAdvance: (via: "enter" | "pick") => void;
  onEscape: () => void;
  onOpenPillar: (pillar: number) => void;
  onFilled: (ids: string[]) => void;
}) {
  const ref = squareAt(coord);
  const cell = cellAt(index, ref);
  const target: EditorTarget | null = ref.role === "goal" ? { role: "goal" } : cell ? { role: ref.role, cell } : null;
  const next = nextEmptyInBlock(index, coord);

  const label =
    ref.role === "goal"
      ? "GOAL"
      : ref.role === "pillar"
        ? `PILLAR ${ref.pillar + 1} OF 8`
        : `ACTION ${ref.slot + 1} OF 8`;
  const context = ref.role === "action" ? pillarName(index, ref.pillar) : null;

  return (
    <div className="flex min-h-full flex-col">
      <div className="sticky top-0 z-10 flex min-h-12 items-center gap-2 border-b border-line bg-bg/95 pr-3 pl-6 backdrop-blur-md">
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 font-mono text-[10.5px] tracking-[0.14em] text-faint">{label}</span>
          {context && <span className="truncate text-[12.5px] text-muted">{context}</span>}
          {ref.role === "pillar" && ref.pillar === lever && (
            <span className="font-mono text-[10.5px] tracking-[0.14em] text-accent">LEVER</span>
          )}
        </div>
        <IconButton label="Close (Esc)" size="sm" onClick={onClose} className="text-muted">
          <X size={16} />
        </IconButton>
      </div>

      <div className="flex-1 px-6 pt-5 pb-6">
        {target ? (
          <CellEditor
            goal={goal}
            index={index}
            target={target}
            enterHint={next ? "next" : "done"}
            textRef={textRef}
            refocusText
            onAdvance={onAdvance}
            onEscape={onEscape}
            onOpenPillar={onOpenPillar}
            onFilled={onFilled}
          />
        ) : (
          <p className="text-sm text-muted">This square is not loaded yet.</p>
        )}
      </div>

      <p className="px-6 pb-5 font-mono text-[10.5px] leading-relaxed text-faint">
        Enter {next ? "next empty square" : "done"} · Esc back to the chart
      </p>
    </div>
  );
}

// ---------- overview (nothing selected) ----------

function Overview({
  goal,
  index,
  checkins,
  today,
  lever,
  onSelect,
  onFilled,
}: {
  goal: GoalWithCells;
  index: ChartIndex;
  checkins: Checkin[];
  today: string;
  lever: number | null;
  onSelect: (coord: Coord, focusText: boolean) => void;
  onFilled: (ids: string[]) => void;
}) {
  const counts = fillCounts(goal);
  const week = weekCount(goal);
  const hint = chartHint(counts, week.actions, "desktop");
  const emptyPillars = index.pillars.filter((c): c is Cell => Boolean(c) && !isFilled(c));
  // Same weekly rule as Today and Leverage, in local days.
  const newWeek = weekInfo(goal, today).due;

  return (
    <div className="space-y-8 px-6 py-6">
      <Field label="WHY IT MATTERS">
        {goal.why.trim() ? (
          <button
            type="button"
            onClick={() => onSelect(GOAL_COORD, false)}
            className="block w-full text-left text-[14px] leading-relaxed whitespace-pre-line text-fg/85 hover:text-fg"
          >
            {goal.why}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onSelect(GOAL_COORD, false)}
            className="text-[13.5px] text-muted underline-offset-2 hover:text-fg hover:underline"
          >
            Add why it matters to you
          </button>
        )}
      </Field>

      <Field label="PILLARS" aside={`${counts.pillars}/8 · ${counts.actions}/64 actions`}>
        {counts.pillars === 0 ? (
          <Button variant="primary" size="sm" onClick={() => onSelect(pillarCoord(0), true)}>
            Name the 8 pillars
          </Button>
        ) : (
          <ul className="-mx-2">
            {index.pillars.map((cell, p) => {
              const named = isFilled(cell);
              const filled = index.actions[p].filter((c) => isFilled(c)).length;
              return (
                <li key={p}>
                  <button
                    type="button"
                    onClick={() => onSelect(pillarCoord(p, true), !named)}
                    className="flex h-9 w-full items-center gap-3 rounded-lg px-2 text-left transition-colors hover:bg-softer"
                  >
                    <span className={cn("min-w-0 flex-1 truncate text-[13.5px]", !named && "text-faint")}>
                      {named ? cell.text : `+ Pillar ${p + 1}`}
                    </span>
                    {p === lever && <span className="font-mono text-[10px] tracking-[0.14em] text-accent">LEVER</span>}
                    {named && (
                      <>
                        <span className="w-14 shrink-0">
                          <ProgressBar value={pillarProgress(goal, p, checkins, today)} />
                        </span>
                        <span className="w-7 shrink-0 text-right font-mono text-[11px] text-faint">{filled}/8</span>
                      </>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {hint && <p className="pt-1 text-[13px] leading-relaxed text-muted">{hint}</p>}
        {emptyPillars.length > 0 && (
          <SuggestionTray
            goalId={goal.id}
            target="pillars"
            existing={index.pillars.filter((c) => isFilled(c)).map((c) => c?.text ?? "")}
            onPick={(suggestion) => onFilled(fillSquares(emptyPillars, [suggestion], "pillars"))}
            onPickAll={(list) => onFilled(fillSquares(emptyPillars, list, "pillars"))}
            className="pt-1"
          />
        )}
      </Field>

      {counts.actions > 0 && (
        <Field label="THIS WEEK">
          <p className="text-[13.5px] text-fg/85">
            {week.actions
              ? `${week.actions} ${week.actions === 1 ? "action" : "actions"} · ${week.pillars}/8 pillars covered`
              : "Nothing picked yet."}
          </p>
          {newWeek && <p className="text-[13px] text-muted">New week: add 5-8 more.</p>}
          <Button
            variant="secondary"
            size="sm"
            icon={<Zap size={14} />}
            onClick={() => navigate({ name: "lever", goalId: goal.id })}
          >
            {week.actions ? "Leverage" : "Pick this week's actions"}
          </Button>
        </Field>
      )}

      <div className="space-y-3 border-t border-line pt-6">
        <GlyphLegend />
        <p className="font-mono text-[10.5px] leading-relaxed text-faint">
          Click a square to edit · Arrow keys move · Enter edit · Esc close · Delete clears
        </p>
      </div>
    </div>
  );
}
