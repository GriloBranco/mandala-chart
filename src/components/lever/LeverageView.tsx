"use client";

import { ArrowDownWideNarrow, ChevronLeft, Sparkles } from "lucide-react";
import { useState, type ReactNode } from "react";
import { AsciiSpinner } from "@/components/ascii/AsciiSpinner";
import { PillarChips } from "@/components/shared/PillarChips";
import { ViewHeader } from "@/components/shell/ViewHeader";
import { Button, IconButton } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { Segmented, type SegmentedOption } from "@/components/ui/Segmented";
import { actionLever, dayKey, EFFORT_LABELS, IMPACT_LABELS, pillarCell, pillarLever } from "@/domain/mandala";
import { goBack, navigate } from "@/client/nav";
import { actions, goalById, useAppState, useGoal } from "@/client/store";
import { toast } from "@/client/toast";
import type { Cell, GoalWithCells } from "@/domain/types";
import { startLeverage, useLeverageRun, type LeverageRun } from "./leverage-run";
import { ChipsToggle, GhostChip, LeverBar, LeverTag, SectionLabel } from "./parts";
import { PickRow, PickSummary } from "./WeekPicker";
import {
  ACTION_SCALE,
  actionsByLever,
  filledActions,
  isUnrated,
  keepOrder,
  leverSig,
  namedPillars,
  PILLAR_SCALE,
  pillarName,
  pillarsByLever,
  ratingPatches,
  readAnalysis,
  sameSet,
  topLeverPillar,
  undoPatches,
  weekInfo,
  type AiAction,
  type AiPillar,
  type AiRead,
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
  const { aiEnabled } = useAppState();
  const run = useLeverageRun(goal.id);
  // Orders are fixed when the view opens (or on Sort), so rows never move under your finger.
  const [pillarOrder, setPillarOrder] = useState(() => pillarsByLever(goal));
  const [actionOrder, setActionOrder] = useState(() => actionsByLever(goal));
  const [filter, setFilter] = useState<Filter>("all");
  // The rows a filter showed when it was chosen. A row you just rated stays until the filter changes.
  const [shown, setShown] = useState<string[] | null>(null);
  const [layer, setLayer] = useState(false);
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
  const read = layer && run?.status === "ready" && run.data ? readAnalysis(goal, run.data) : null;
  const aiPicks = new Set(
    (read?.picks ?? []).filter((id) => {
      const cell = byId.get(id);
      return cell && !cell.active && cell.status !== "done";
    }),
  );

  const back = () => goBack({ name: "goal", goalId: goal.id, pillar: null, map: false });

  const askAi = () => {
    setLayer(true);
    startLeverage(goal.id, leverSig(goal));
  };

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

  const applyAiRatings = () => {
    if (!read) return;
    const current = goalById(goal.id) ?? goal;
    const updates = ratingPatches(current, read, "all");
    if (!updates.length) {
      toast("Your ratings already match");
      return;
    }
    const before = undoPatches(current, updates);
    actions.updateCells(updates);
    toast(`Rated ${updates.length} ${updates.length === 1 ? "square" : "squares"}`, {
      action: { label: "Undo", run: () => actions.updateCells(before) },
    });
  };

  const addAiPicks = () => {
    const ids = [...aiPicks];
    if (!ids.length) return;
    actions.updateCells(ids.map((id) => ({ id, patch: { active: true } })));
    toast(`Added ${ids.length} to this week`, {
      action: { label: "Undo", run: () => actions.updateCells(ids.map((id) => ({ id, patch: { active: false } }))) },
    });
  };

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
        right={
          aiEnabled && named.length > 0 ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<Sparkles size={14} />}
              loading={layer && run?.status === "loading"}
              onClick={askAi}
            >
              Ask AI
            </Button>
          ) : undefined
        }
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

        {layer && (
          <AiPanel
            run={run}
            read={read}
            pickCount={aiPicks.size}
            onUse={applyAiRatings}
            onAddPicks={addAiPicks}
            onRetry={askAi}
            onHide={() => setLayer(false)}
          />
        )}

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
                    ai={read?.pillars.get(p)}
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
                            ai={read?.actions.get(id)}
                            suggested={aiPicks.has(id)}
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

function AiPanel({
  run,
  read,
  pickCount,
  onUse,
  onAddPicks,
  onRetry,
  onHide,
}: {
  run: LeverageRun | null;
  read: AiRead | null;
  pickCount: number;
  onUse: () => void;
  onAddPicks: () => void;
  onRetry: () => void;
  onHide: () => void;
}) {
  if (!run || run.status === "loading") {
    return (
      <div className="mt-5 flex items-center gap-3 rounded-2xl border border-line px-4 py-3.5 animate-fade-in">
        <AsciiSpinner size="md" label="Reading your chart" />
        <p className="text-sm text-muted">Reading your chart…</p>
      </div>
    );
  }
  if (run.status === "error") {
    return (
      <div className="mt-5 rounded-2xl border border-line px-4 py-3.5 animate-fade-in">
        <p className="text-sm text-danger">{run.error}</p>
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Try again
          </Button>
          <Button size="sm" variant="ghost" onClick={onHide}>
            Hide
          </Button>
        </div>
      </div>
    );
  }
  if (!read) return null;
  return (
    <div className="mt-5 rounded-2xl border border-line px-4 py-4 animate-rise">
      <SectionLabel>THE LEVER</SectionLabel>
      <p className="mt-1.5 text-[15px] leading-snug">
        {read.insight || "Ratings are ready. Dashed chips show what the AI would set."}
      </p>
      <div className="mt-3.5 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" onClick={onUse}>
          Use AI ratings
        </Button>
        {pickCount > 0 && (
          <Button size="sm" variant="secondary" onClick={onAddPicks}>
            Add AI picks to this week ({pickCount})
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onHide}>
          Hide
        </Button>
      </div>
    </div>
  );
}

function PillarRow({
  goal,
  pillar,
  top,
  ai,
  open,
  onChips,
}: {
  goal: GoalWithCells;
  pillar: number;
  top: boolean;
  ai: AiPillar | undefined;
  open: boolean;
  onChips: () => void;
}) {
  const cell = pillarCell(goal, pillar);
  if (!cell) return null;
  const name = cell.text.trim();
  const differs = Boolean(ai && (ai.impact !== cell.impact || !sameSet(ai.helps, cell.helps)));
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
      {ai && (
        <AiLine
          differs={differs}
          label={
            `${IMPACT_LABELS[ai.impact]} impact` +
            (ai.helps.length ? ` · makes ${ai.helps.map((p) => pillarName(goal, p)).join(", ")} easier` : "")
          }
          reason={ai.reason}
          onUse={() => actions.updateCell(cell.id, { impact: ai.impact, helps: ai.helps })}
        />
      )}
    </li>
  );
}

function ActionRow({
  goal,
  cell,
  ai,
  suggested,
  open,
  onChips,
}: {
  goal: GoalWithCells;
  cell: Cell;
  ai: AiAction | undefined;
  suggested: boolean;
  open: boolean;
  onChips: () => void;
}) {
  const done = cell.status === "done";
  const differs = Boolean(
    ai && (ai.impact !== cell.impact || ai.effort !== cell.effort || !sameSet(ai.helps, cell.helps)),
  );
  return (
    <PickRow
      goal={goal}
      cell={cell}
      picked={cell.active}
      suggested={suggested}
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
          {ai && (
            <AiLine
              differs={differs}
              label={
                `${IMPACT_LABELS[ai.impact]} impact · ${EFFORT_LABELS[ai.effort]}` +
                (ai.helps.length ? ` · helps ${ai.helps.map((p) => pillarName(goal, p)).join(", ")}` : "")
              }
              reason={ai.reason}
              onUse={() => actions.updateCell(cell.id, { impact: ai.impact, effort: ai.effort, helps: ai.helps })}
            />
          )}
        </>
      )}
    </PickRow>
  );
}

/** The AI's values as a dashed chip with "Use", and its reason. Hidden chip once they match. */
function AiLine({
  differs,
  label,
  reason,
  onUse,
}: {
  differs: boolean;
  label: string;
  reason: string;
  onUse: () => void;
}) {
  if (!differs && !reason) return null;
  return (
    <div className="mt-2.5 animate-fade-in">
      {differs && (
        <div className="flex min-w-0 items-center gap-1.5">
          <GhostChip className="min-w-0">{label}</GhostChip>
          <Button size="sm" variant="ghost" onClick={onUse} className="px-2.5">
            Use
          </Button>
        </div>
      )}
      {reason && <p className={cn("text-[13px] leading-snug text-muted", differs && "mt-1")}>{reason}</p>}
    </div>
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
