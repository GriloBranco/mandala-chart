"use client";

import { ArrowDownWideNarrow, ChevronLeft } from "lucide-react";
import { useState, type ReactNode } from "react";
import { PillarChips } from "@/components/shared/PillarChips";
import { ViewHeader } from "@/components/shell/ViewHeader";
import { Button, IconButton } from "@/components/ui/Button";
import { Segmented, type SegmentedOption } from "@/components/ui/Segmented";
import { actionLever, dayKey, IMPACT_LABELS, pillarCell, pillarLever } from "@/domain/mandala";
import { goBack, navigate } from "@/client/nav";
import { actions, useGoal } from "@/client/store";
import type { Cell, GoalWithCells } from "@/domain/types";
import { ChipsToggle, LeverBar, LeverTag, SectionLabel } from "./parts";
import { PickRow, PickSummary } from "./WeekPicker";
import {
  ACTION_SCALE,
  actionsByLever,
  filledActions,
  isUnrated,
  keepOrder,
  namedPillars,
  PILLAR_SCALE,
  pillarsByLever,
  topLeverPillar,
  weekInfo,
} from "@/domain/week";

type Filter = "all" | "unrated" | "week";

const FILTERS: SegmentedOption<Filter>[] = [
  { value: "all", label: "All" },
  { value: "unrated", label: "Unrated" },
  { value: "week", label: "This week" },
];

const IMPACT_FULL: SegmentedOption<number>[] = [1, 2, 3].map((value) => ({ value, label: IMPACT_LABELS[value] }));
// Short labels keep impact and effort side by side on a phone.
const IMPACT_SHORT: SegmentedOption<number>[] = [
  { value: 1, label: "Low" },
  { value: 2, label: "Med" },
  { value: 3, label: "High" },
];
const EFFORT_SHORT: SegmentedOption<number>[] = [
  { value: 1, label: "Easy" },
  { value: 2, label: "Med" },
  { value: 3, label: "Hard" },
];

export function LeverageView({ goalId }: { goalId: string }) {
  const goal = useGoal(goalId);
  if (!goal) return null;
  return <Leverage key={goal.id} goal={goal} />;
}

function matching(goal: GoalWithCells, filter: Filter): string[] {
  return filledActions(goal)
    .filter((c) => (filter === "week" ? c.active : c.status !== "done" && isUnrated(c)))
    .map((c) => c.id);
}

function Leverage({ goal }: { goal: GoalWithCells }) {
  // Orders are fixed when the view opens (or on Sort), so rows never move under your finger.
  const [pillarOrder, setPillarOrder] = useState(() => pillarsByLever(goal));
  const [actionOrder, setActionOrder] = useState(() => actionsByLever(goal));
  const [filter, setFilter] = useState<Filter>("all");
  // The rows a filter showed when it was chosen. A row you just rated stays until the filter changes.
  const [shown, setShown] = useState<string[] | null>(null);
  const [openChips, setOpenChips] = useState<string | null>(null);

  const info = weekInfo(goal, dayKey());
  const named = namedPillars(goal);
  const filled = filledActions(goal);
  const byId = new Map(filled.map((c) => [c.id, c]));
  const pillars = keepOrder(pillarOrder, named);
  const visible = new Set(shown ?? []);
  const rows = keepOrder(
    actionOrder,
    filled.map((c) => c.id),
  ).filter((id) => !shown || visible.has(id));
  const top = topLeverPillar(goal);

  const back = () => goBack({ name: "goal", goalId: goal.id, pillar: null, map: false });

  const changeFilter = (next: Filter | null) => {
    const value = next ?? "all";
    setFilter(value);
    setShown(value === "all" ? null : matching(goal, value));
  };

  const sortActions = () => {
    setActionOrder(actionsByLever(goal));
    if (filter !== "all") setShown(matching(goal, filter));
  };

  const toggleChips = (key: string) => setOpenChips((current) => (current === key ? null : key));

  return (
    <div className="min-h-full">
      <ViewHeader
        left={
          <IconButton label="Back" onClick={back}>
            <ChevronLeft size={20} />
          </IconButton>
        }
        title="Leverage"
        subtitle={`Week ${info.week} · ${goal.title}`}
      />

      <div className="mx-auto max-w-[720px] px-4 pt-5 pb-8 lg:px-6 lg:pt-8 xl:max-w-[1120px]">
        {info.due && (
          <div className="mb-5 animate-rise rounded-2xl bg-soft px-4 py-3.5">
            <p className="text-[15px] font-semibold tracking-tight">
              New week: add <span className="whitespace-nowrap">5-8</span> more
            </p>
            <p className="mt-0.5 text-sm text-muted">
              Keep last week&apos;s picks going and add the next few. One per pillar if you can.
            </p>
          </div>
        )}

        <p className="max-w-[60ch] text-[15px] leading-relaxed text-muted">
          Pick the actions that move the goal most. One per pillar if you can; actions that help two pillars first.
          Add <span className="whitespace-nowrap">5-8</span> more each week.
        </p>

        {named.length === 0 ? (
          <Empty
            title="Name your pillars first"
            body="Leverage starts with the 8 things around your goal."
            action="Name pillars"
            onAction={() => navigate({ name: "new", goalId: goal.id, step: 2 })}
          />
        ) : (
          <div className="mt-8 xl:grid xl:grid-cols-[320px_minmax(0,1fr)] xl:gap-12">
            <section aria-labelledby="lever-pillars">
              <div className="flex items-center gap-2">
                <SectionLabel id="lever-pillars" className="flex-1">
                  PILLARS
                </SectionLabel>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<ArrowDownWideNarrow size={14} />}
                  onClick={() => setPillarOrder(pillarsByLever(goal))}
                >
                  Sort
                </Button>
              </div>
              <p className="text-[13px] text-muted">How much each one moves the goal, and which it makes easier.</p>
              <ul className="mt-1 divide-y divide-line">
                {pillars.map((p) => (
                  <PillarRow
                    key={p}
                    goal={goal}
                    pillar={p}
                    top={p === top}
                    open={openChips === `p${p}`}
                    onChips={() => toggleChips(`p${p}`)}
                  />
                ))}
              </ul>
            </section>

            <section aria-labelledby="lever-actions" className="mt-10 xl:mt-0">
              <div className="flex items-center gap-2">
                <SectionLabel id="lever-actions" className="flex-1">
                  ACTIONS · {filled.length}
                </SectionLabel>
                {filled.length > 0 && (
                  <Button variant="ghost" size="sm" icon={<ArrowDownWideNarrow size={14} />} onClick={sortActions}>
                    Sort
                  </Button>
                )}
              </div>
              {filled.length === 0 ? (
                <Empty
                  title="No actions yet"
                  body="Write a few for each pillar, then pick this week's."
                  action="Add actions"
                  onAction={() => navigate({ name: "new", goalId: goal.id, step: 3 })}
                />
              ) : (
                <>
                  <p className="text-[13px] text-muted">Impact, effort, and which other pillars it helps.</p>
                  <Segmented
                    value={filter}
                    options={FILTERS}
                    onChange={changeFilter}
                    label="Show actions"
                    size="sm"
                    className="mt-3"
                  />
                  {rows.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted">
                      {filter === "unrated" ? "Everything is rated." : "Nothing picked for this week yet."}
                    </p>
                  ) : (
                    <ul className="mt-2 divide-y divide-line">
                      {rows.map((id) => {
                        const cell = byId.get(id);
                        if (!cell) return null;
                        return (
                          <ActionRow
                            key={id}
                            goal={goal}
                            cell={cell}
                            open={openChips === id}
                            onChips={() => toggleChips(id)}
                          />
                        );
                      })}
                    </ul>
                  )}
                </>
              )}
            </section>
          </div>
        )}
      </div>

      {named.length > 0 && (
        <div className="sticky bottom-[calc(68px+var(--safe-bottom))] z-20 border-t border-line bg-bg/95 backdrop-blur-md lg:bottom-0">
          <div className="mx-auto flex max-w-[720px] items-center gap-3 px-4 py-3 lg:px-6 xl:max-w-[1120px]">
            <PickSummary goal={goal} picks={info.batch} carried={info.carried} className="flex-1" />
            <Button variant="primary" onClick={back}>
              Done
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function PillarRow({
  goal,
  pillar,
  top,
  open,
  onChips,
}: {
  goal: GoalWithCells;
  pillar: number;
  top: boolean;
  open: boolean;
  onChips: () => void;
}) {
  const cell = pillarCell(goal, pillar);
  if (!cell) return null;
  const name = cell.text.trim();
  return (
    <li className="py-3.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight">{name}</span>
        {top && <LeverTag />}
        <LeverBar score={pillarLever(cell)} scale={PILLAR_SCALE} accent={top} />
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Segmented
          size="sm"
          label={`${name}: impact on the goal`}
          value={cell.impact}
          options={IMPACT_FULL}
          allowClear
          onChange={(impact) => actions.updateCell(cell.id, { impact })}
        />
        <ChipsToggle
          label={cell.helps.length ? `Makes ${cell.helps.length} easier` : "Makes easier"}
          open={open}
          onClick={onChips}
        />
      </div>
      {open && (
        <PillarChips
          goal={goal}
          exclude={pillar}
          value={cell.helps}
          onChange={(helps) => actions.updateCell(cell.id, { helps })}
          className="mt-2.5"
        />
      )}
    </li>
  );
}

function ActionRow({
  goal,
  cell,
  open,
  onChips,
}: {
  goal: GoalWithCells;
  cell: Cell;
  open: boolean;
  onChips: () => void;
}) {
  const done = cell.status === "done";
  return (
    <PickRow
      goal={goal}
      cell={cell}
      picked={cell.active}
      onToggle={(active) => actions.updateCell(cell.id, { active })}
      pillarTag
      aside={<LeverBar score={actionLever(cell)} scale={ACTION_SCALE} className="mt-2" />}
      metaExtra={
        done ? undefined : (
          <ChipsToggle
            label={cell.helps.length ? `Helps ${cell.helps.length}` : "Also helps"}
            open={open}
            onClick={onChips}
          />
        )
      }
    >
      {!done && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              size="sm"
              label="Impact"
              value={cell.impact}
              options={IMPACT_SHORT}
              allowClear
              onChange={(impact) => actions.updateCell(cell.id, { impact })}
            />
            <Segmented
              size="sm"
              label="Effort"
              value={cell.effort}
              options={EFFORT_SHORT}
              allowClear
              onChange={(effort) => actions.updateCell(cell.id, { effort })}
            />
          </div>
          {open && (
            <PillarChips
              goal={goal}
              exclude={cell.pillar}
              value={cell.helps}
              onChange={(helps) => actions.updateCell(cell.id, { helps })}
              className="mt-2.5"
            />
          )}
        </>
      )}
    </PickRow>
  );
}

function Empty({
  title,
  body,
  action,
  onAction,
}: {
  title: string;
  body: ReactNode;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="mt-6 rounded-2xl border border-dashed border-line-strong px-5 py-7 text-center">
      <p className="text-[15px] font-semibold tracking-tight">{title}</p>
      <p className="mt-1 text-sm text-muted">{body}</p>
      <Button variant="primary" className="mt-4" onClick={onAction}>
        {action}
      </Button>
    </div>
  );
}
