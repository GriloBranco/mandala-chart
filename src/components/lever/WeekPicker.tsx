"use client";

import type { ReactNode } from "react";
import { GoalGlyph } from "@/components/shell/GoalGlyph";
import { cn } from "@/components/ui/cn";
import { actionCells, isFilled } from "@/lib/mandala";
import type { Cell, GoalWithCells } from "@/lib/types";
import { PickToggle } from "./parts";
import { coverage, pickablePillars, pillarName } from "./week";

/**
 * One action with its "this week" toggle. The Leverage view adds rating controls as
 * children; the new goal flow uses it bare.
 */
export function PickRow({
  goal,
  cell,
  picked,
  suggested = false,
  onToggle,
  reason,
  synergy,
  pillarTag = false,
  aside,
  metaExtra,
  children,
  className,
}: {
  goal: GoalWithCells;
  cell: Cell;
  picked: boolean;
  suggested?: boolean;
  onToggle: (next: boolean) => void;
  /** Why it is a good pick (from the AI). */
  reason?: string | null;
  /** Other pillars it also helps, shown as "Also helps …". */
  synergy?: number[] | null;
  pillarTag?: boolean;
  /** Right of the text, e.g. the score bar. */
  aside?: ReactNode;
  /** End of the small line under the text, e.g. the "Helps 2" toggle. */
  metaExtra?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const done = cell.status === "done";
  const meta: string[] = [];
  if (pillarTag) meta.push(pillarName(goal, cell.pillar));
  if (done) meta.push("Done");
  else if (cell.kind === "habit") meta.push("Habit");
  if (synergy?.length) meta.push(`Also helps ${synergy.map((p) => pillarName(goal, p)).join(", ")}`);

  return (
    <li className={cn("grid grid-cols-[44px_minmax(0,1fr)] gap-x-2 py-1.5", className)}>
      <PickToggle
        picked={picked}
        suggested={suggested}
        done={done}
        label={`This week: ${cell.text.trim()}`}
        onChange={onToggle}
        className="mt-0.5"
      />
      <div className="min-w-0 py-2">
        <div className="flex items-start gap-3">
          <p className={cn("min-w-0 flex-1 text-[15px] leading-snug break-words", done && "text-faint")}>
            {cell.text.trim()}
          </p>
          {aside}
        </div>
        {(meta.length > 0 || metaExtra) && (
          <div className="mt-1 flex min-w-0 items-center gap-2">
            {meta.length > 0 && <p className="min-w-0 truncate text-xs text-muted">{meta.join(" · ")}</p>}
            {metaExtra}
          </div>
        )}
        {reason && <p className="mt-1.5 text-[13px] leading-snug text-muted">{reason}</p>}
      </div>
      {children && <div className="col-span-2 pb-2 sm:col-span-1 sm:col-start-2">{children}</div>}
    </li>
  );
}

/** "This week: 6 · Pillars covered: 5/8", a coverage glyph, and one gentle line. */
export function PickSummary({
  goal,
  picks,
  carried = 0,
  className,
}: {
  goal: GoalWithCells;
  picks: Cell[];
  /** Open picks from earlier weeks. */
  carried?: number;
  className?: string;
}) {
  const { covered, total } = coverage(goal, picks);
  const glyph = Array.from({ length: 8 }, (_, p) => (covered.includes(p) ? 1 : total.includes(p) ? 0 : null));
  const n = picks.length;
  const note =
    n > 8
      ? "That's a lot for one week."
      : n >= 5 && total.length > 0 && covered.length === total.length
        ? "Every pillar covered."
        : carried > 0
          ? `Plus ${carried} still open from earlier weeks.`
          : n === 0
            ? "Pick 5-8 to start."
            : null;

  return (
    <div className={cn("flex min-w-0 items-center gap-3", className)}>
      <GoalGlyph pillars={glyph} size={22} />
      <div className="min-w-0" aria-live="polite">
        <p className="truncate text-[13px] text-fg">
          This week: <span className="font-mono">{n}</span>
          <span className="text-faint"> · </span>
          Pillars covered:{" "}
          <span className="font-mono">
            {covered.length}/{total.length}
          </span>
        </p>
        {note && <p className={cn("truncate text-xs", n > 8 ? "font-medium text-fg" : "text-muted")}>{note}</p>}
      </div>
    </div>
  );
}

/**
 * The week pick, grouped by pillar so "one from each pillar" is easy to see. A small
 * accent dot marks each pillar that already has a pick.
 */
export function WeekPicker({
  goal,
  picked,
  suggested,
  onToggle,
  reasons,
  synergy,
  className,
}: {
  goal: GoalWithCells;
  picked: Set<string>;
  suggested?: Set<string>;
  onToggle: (cell: Cell, next: boolean) => void;
  /** Shown under picked or suggested rows only, to keep the list calm. */
  reasons?: Map<string, string>;
  synergy?: (cell: Cell) => number[];
  className?: string;
}) {
  const groups = pickablePillars(goal).map((p) => ({ p, cells: actionCells(goal, p).filter(isFilled) }));
  return (
    <div className={cn("space-y-7", className)}>
      {groups.map(({ p, cells }) => {
        const count = cells.filter((c) => picked.has(c.id)).length;
        return (
          <section key={p} aria-label={pillarName(goal, p)}>
            <div className="flex items-center gap-2.5 border-b border-line pb-2">
              <span
                className={cn("size-1.5 shrink-0 rounded-full", count ? "bg-accent" : "bg-line-strong")}
                aria-hidden
              />
              <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight">
                {pillarName(goal, p)}
              </h3>
              {count > 0 && <span className="font-mono text-[11px] text-faint">{count} picked</span>}
            </div>
            <ul className="divide-y divide-line">
              {cells.map((cell) => {
                const on = picked.has(cell.id);
                const hinted = on || Boolean(suggested?.has(cell.id));
                return (
                  <PickRow
                    key={cell.id}
                    goal={goal}
                    cell={cell}
                    picked={on}
                    suggested={!on && Boolean(suggested?.has(cell.id))}
                    onToggle={(next) => onToggle(cell, next)}
                    reason={hinted ? reasons?.get(cell.id) : null}
                    synergy={synergy ? synergy(cell) : cell.helps}
                  />
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
