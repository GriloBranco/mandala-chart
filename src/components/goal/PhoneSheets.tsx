"use client";

import {
  CalendarMinus,
  CalendarPlus,
  Check,
  CircleDashed,
  Eraser,
  Grid3x3,
  Pencil,
  Repeat,
  RotateCcw,
} from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { dayKey, gridCoord, isFilled, ringIndex } from "@/domain/mandala";
import { navigate } from "@/client/nav";
import { useAppState } from "@/client/store";
import type { Cell, GoalWithCells } from "@/domain/types";
import { Block3x3, Square } from "@/components/shared/Square";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { useMediaQuery } from "@/components/ui/hooks";
import { Sheet } from "@/components/ui/Sheet";
import { CellEditor, type EditorTarget } from "./CellEditor";
import { clampClass, useSquareLines } from "./clamp";
import { clearSquare, editCell, setKind, toggleDone, toggleToday, toggleWeek } from "./edits";
import { Mini3x3, type MiniFill } from "./Mini3x3";
import {
  actionCoord,
  blockOf,
  cellAt,
  indexGoal,
  leverPillar,
  nextEmptyInBlock,
  pillarCoord,
  pillarName,
  ringCells,
  sameCoord,
  squareAt,
  type ChartIndex,
  type Coord,
} from "./model";

// ---------- editor ----------

/**
 * The cell editor in a bottom sheet. While the keyboard is up it shrinks to the text field
 * (the rest would sit under the keyboard), with Next and Done right above the keys.
 */
export function EditorSheet({
  goal,
  coord,
  onClose,
  onMove,
}: {
  goal: GoalWithCells;
  coord: Coord | null;
  onClose: () => void;
  /** Show another square in the same sheet (the Enter chain). */
  onMove: (coord: Coord) => void;
}) {
  const touch = useMediaQuery("(pointer: coarse)");
  const [typing, setTyping] = useState(false);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const index = useMemo(() => indexGoal(goal), [goal]);

  if (!coord) {
    // Closed from outside (or never opened): start the next open with the full editor.
    if (typing) setTyping(false);
    return null;
  }

  const ref = squareAt(coord);
  const cell = cellAt(index, ref);
  const target: EditorTarget | null = ref.role === "goal" ? { role: "goal" } : cell ? { role: ref.role, cell } : null;
  const next = nextEmptyInBlock(index, coord);
  const compact = touch && typing;
  const empty = ref.role !== "goal" && !isFilled(cell);
  const filledInBlock = ringCells(index, blockOf(coord)).filter((c) => isFilled(c)).length;

  const close = () => {
    setTyping(false);
    onClose();
  };

  const advance = (via: "enter" | "pick") => {
    if (next) onMove(next);
    else if (via === "enter") textRef.current?.blur();
  };

  const footer = compact ? (
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint">{filledInBlock}/8 filled</span>
      <Button
        variant={next ? "secondary" : "primary"}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => textRef.current?.blur()}
      >
        Done
      </Button>
      {next && (
        <Button
          variant="primary"
          // Keeps the keyboard up while moving to the next square.
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onMove(next)}
        >
          Next
        </Button>
      )}
    </div>
  ) : undefined;

  return (
    <Sheet open onClose={close} title={<EditorTitle index={index} coord={coord} />} footer={footer} size="md">
      {target ? (
        <CellEditor
          goal={goal}
          index={index}
          target={target}
          enterHint={next ? "next" : "done"}
          compact={compact}
          autoFocus={empty}
          textRef={textRef}
          onAdvance={advance}
          onTypingChange={setTyping}
          onOpenPillar={(p) => onMove(pillarCoord(p, blockOf(coord) !== 4))}
          className="pt-1"
        />
      ) : (
        <p className="text-sm text-muted">This square is not loaded yet.</p>
      )}
    </Sheet>
  );
}

function EditorTitle({ index, coord }: { index: ChartIndex; coord: Coord }) {
  const ref = squareAt(coord);
  const block = blockOf(coord);
  const fills: MiniFill[] = Array.from({ length: 9 }, (_, position) => {
    const here = gridCoord(block, position);
    if (sameCoord(here, coord)) return "strong";
    if (position === 4) return "mid";
    return isFilled(cellAt(index, squareAt(here))) ? "soft" : "line";
  });
  const text =
    ref.role === "goal"
      ? "Your goal"
      : ref.role === "pillar"
        ? `Pillar ${ref.pillar + 1} of 8`
        : pillarName(index, ref.pillar);
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <Mini3x3 fills={fills} size={18} />
      <span className="truncate">{text}</span>
    </span>
  );
}

// ---------- long-press menu ----------

/** Quick changes for one action without opening the editor. */
export function CellMenuSheet({
  goal,
  cellId,
  onClose,
  onEdit,
}: {
  goal: GoalWithCells;
  cellId: string | null;
  onClose: () => void;
  onEdit: (coord: Coord) => void;
}) {
  const { checkins } = useAppState();
  const today = dayKey();
  const cell = cellId ? goal.cells.find((c) => c.id === cellId) : undefined;
  if (!cell) return null;

  const checked = checkins.some((c) => c.cellId === cell.id && c.day === today);
  const run = (action: () => void) => () => {
    action();
    onClose();
  };

  return (
    <Sheet open onClose={onClose} title={<MenuTitle cell={cell} />} size="sm">
      <div className="-mx-2 pb-1" role="menu" aria-label="Square actions">
        {cell.kind === "habit" ? (
          <MenuRow
            icon={checked ? <RotateCcw size={18} /> : <Check size={18} />}
            label={checked ? "Not done today" : "Done today"}
            onClick={run(() => toggleToday(cell, today, checked))}
          />
        ) : (
          <>
            <MenuRow
              icon={cell.status === "done" ? <RotateCcw size={18} /> : <Check size={18} />}
              label={cell.status === "done" ? "Mark not done" : "Mark done"}
              onClick={run(() => toggleDone(cell))}
            />
            {cell.status !== "done" && (
              <MenuRow
                icon={<CircleDashed size={18} />}
                label={cell.status === "doing" ? "Back to to do" : "Mark as doing"}
                onClick={run(() => editCell(cell.id, { status: cell.status === "doing" ? "todo" : "doing" }))}
              />
            )}
          </>
        )}
        <MenuRow
          icon={cell.active ? <CalendarMinus size={18} /> : <CalendarPlus size={18} />}
          label={cell.active ? "Remove from this week" : "Add to this week"}
          onClick={run(() => toggleWeek(cell))}
        />
        <MenuRow
          icon={<Repeat size={18} />}
          label={cell.kind === "habit" ? "Make it a task" : "Make it a habit"}
          onClick={run(() => setKind(cell, cell.kind === "habit" ? "task" : "habit"))}
        />
        <MenuRow icon={<Pencil size={18} />} label="Edit" onClick={() => onEdit(actionCoord(cell.pillar, cell.slot))} />
        <div className="mx-3 my-1 border-t border-line" />
        <MenuRow
          icon={<Eraser size={18} />}
          label="Clear square"
          tone="danger"
          onClick={run(() => clearSquare(cell.id))}
        />
      </div>
    </Sheet>
  );
}

function MenuTitle({ cell }: { cell: Cell }) {
  const state =
    cell.status === "done" ? "Done" : cell.status === "doing" ? "Doing" : cell.active ? "This week" : "Idea";
  return (
    <span className="block min-w-0">
      <span className="line-clamp-2 break-words">{cell.text}</span>
      <span className="block font-mono text-[10.5px] font-normal tracking-[0.14em] text-faint">
        {(cell.kind === "habit" ? `HABIT · ${state}` : state).toUpperCase()}
      </span>
    </span>
  );
}

export function MenuRow({
  icon,
  label,
  onClick,
  tone,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  tone?: "danger";
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex h-12 w-full items-center gap-3.5 rounded-xl px-3 text-left text-[15px] transition-colors hover:bg-soft active:bg-soft",
        tone === "danger" ? "text-danger" : "text-fg",
      )}
    >
      <span className={cn("shrink-0", tone === "danger" ? "text-danger" : "text-muted")}>{icon}</span>
      {label}
    </button>
  );
}

// ---------- jump between pillars ----------

/** The tappable mini map in the pillar header: the center block, big enough to tap. */
export function JumpSheet({
  goal,
  open,
  current,
  onClose,
}: {
  goal: GoalWithCells;
  open: boolean;
  current: number | null;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <Sheet open onClose={onClose} title="Go to" size="sm">
      <JumpGrid goal={goal} current={current} onClose={onClose} />
    </Sheet>
  );
}

function JumpGrid({ goal, current, onClose }: { goal: GoalWithCells; current: number | null; onClose: () => void }) {
  const index = useMemo(() => indexGoal(goal), [goal]);
  const lever = leverPillar(index);
  const gridRef = useRef<HTMLDivElement>(null);
  useSquareLines(gridRef);

  const go = (pillar: number | null, map = false) => {
    onClose();
    navigate({ name: "goal", goalId: goal.id, pillar, map }, { replace: !map });
  };

  return (
    <>
      <div ref={gridRef}>
        <Block3x3 gap="focus">
          {Array.from({ length: 9 }, (_, position) => {
            if (position === 4) {
              return (
                <Square
                  key={position}
                  role="goal"
                  size="focus"
                  text={goal.title}
                  label="The goal and its 8 pillars"
                  onClick={() => go(null)}
                  className={clampClass("goal", goal.title)}
                />
              );
            }
            const p = ringIndex(position);
            const cell = index.pillars[p];
            return (
              <Square
                key={position}
                role="pillar"
                size="focus"
                text={cell?.text ?? ""}
                placeholder={`Pillar ${p + 1}`}
                selected={p === current}
                lever={p === lever}
                label={`Go to ${pillarName(index, p)}`}
                onClick={() => go(p)}
                className={clampClass("pillar", cell?.text ?? "")}
              />
            );
          })}
        </Block3x3>
      </div>
      <Button variant="ghost" icon={<Grid3x3 size={16} />} className="mt-3 -ml-2" onClick={() => go(null, true)}>
        Whole chart
      </Button>
    </>
  );
}

/** Mini map fills for the header button: where you are among the pillars. */
export function pillarMapFills(index: ChartIndex, current: number): MiniFill[] {
  return Array.from({ length: 9 }, (_, position) => {
    if (position === 4) return "mid";
    const p = ringIndex(position);
    if (p === current) return "strong";
    return isFilled(index.pillars[p]) ? "soft" : "line";
  });
}
