"use client";

import { ChevronLeft, Grid3x3, Zap } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { dayKey, fillCounts, goalProgress } from "@/domain/mandala";
import { goBack, navigate } from "@/client/nav";
import { useAppState, useGoal } from "@/client/store";
import type { GoalWithCells } from "@/domain/types";
import { ViewHeader } from "@/components/shell/ViewHeader";
import { Button, IconButton } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { useIsDesktop } from "@/components/ui/hooks";
import { DesktopChart, type DesktopChartHandle } from "./DesktopChart";
import { FocusView } from "./FocusView";
import { GoalMenu, setGoalStatus } from "./GoalMenu";
import { MapView } from "./MapView";
import { Mini3x3 } from "./Mini3x3";
import { GOAL_COORD, goalSubtitle, indexGoal, pillarName, type Coord } from "./model";
import { CellMenuSheet, EditorSheet, JumpSheet, pillarMapFills } from "./PhoneSheets";

/** One goal's chart: the full 9x9 with an inspector on desktop, one 3x3 at a time on phones. */
export function GoalView({ goalId, pillar, map }: { goalId: string; pillar: number | null; map: boolean }) {
  const goal = useGoal(goalId);
  if (!goal) return null;
  // Keyed by goal: switching goals starts with a clean selection and closed sheets.
  return <GoalScreen key={goal.id} goal={goal} pillar={pillar} map={map} />;
}

function GoalScreen({ goal, pillar, map }: { goal: GoalWithCells; pillar: number | null; map: boolean }) {
  const isDesktop = useIsDesktop();
  const { checkins, offline, unsynced } = useAppState();
  const today = dayKey();
  const index = useMemo(() => indexGoal(goal), [goal]);
  const chartRef = useRef<DesktopChartHandle>(null);

  // Phone sheets: the editor (a square, by its place in the 9x9), the long-press menu, the pillar jump.
  const [editing, setEditing] = useState<Coord | null>(null);
  const [menuCell, setMenuCell] = useState<string | null>(null);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [layout, setLayout] = useState(isDesktop);
  if (layout !== isDesktop) {
    setLayout(isDesktop);
    setEditing(null);
    setMenuCell(null);
    setJumpOpen(false);
  }

  const counts = fillCounts(goal);
  const progress = goalProgress(goal, checkins, today);
  const stats = goalSubtitle(goal, progress, counts);
  // The sidebar shows sync status on desktop; phones get it here.
  const subtitle = !isDesktop && offline ? `Offline${unsynced ? ` · ${unsynced} unsaved` : ""} · ${stats}` : stats;

  const inPillar = !isDesktop && !map && pillar !== null;
  const center = { name: "goal" as const, goalId: goal.id, pillar: null, map: false };
  const openLever = () => navigate({ name: "lever", goalId: goal.id });

  let left: ReactNode = undefined;
  let right: ReactNode;
  if (isDesktop) {
    right = (
      <>
        <Button variant="secondary" size="sm" icon={<Zap size={14} />} onClick={openLever}>
          Leverage
        </Button>
        <GoalMenu goal={goal} isDesktop onEditGoal={() => chartRef.current?.editGoal()} />
      </>
    );
  } else if (inPillar) {
    left = (
      <IconButton label="Back to the goal" size="lg" onClick={() => goBack(center)} className="-ml-1">
        <ChevronLeft size={22} />
      </IconButton>
    );
    right = (
      <>
        <IconButton
          label={`${pillarName(index, pillar)}. Go to another pillar`}
          size="lg"
          onClick={() => setJumpOpen(true)}
        >
          <Mini3x3 fills={pillarMapFills(index, pillar)} size={20} />
        </IconButton>
        <GoalMenu goal={goal} isDesktop={false} onEditGoal={() => setEditing(GOAL_COORD)} />
      </>
    );
  } else {
    right = (
      <>
        <IconButton label="Leverage" size="lg" onClick={openLever}>
          <Zap size={19} />
        </IconButton>
        <IconButton
          label={map ? "Back to the focus view" : "Whole chart"}
          aria-pressed={map}
          size="lg"
          onClick={() => navigate({ ...center, map: !map }, { replace: true })}
          className={cn(map && "bg-soft")}
        >
          <Grid3x3 size={19} />
        </IconButton>
        <GoalMenu goal={goal} isDesktop={false} onEditGoal={() => setEditing(GOAL_COORD)} />
      </>
    );
  }

  const banner =
    goal.status === "active" ? null : (
      <div className="flex h-11 items-center justify-between gap-3 border-b border-line bg-softer px-4 lg:px-6">
        <span className="truncate text-[13px] text-muted">
          {goal.status === "achieved" ? "Achieved. Well done." : "Archived. It stays off Today."}
        </span>
        <Button variant="ghost" size="sm" onClick={() => setGoalStatus(goal, "active")} className="-mr-2">
          Make active again
        </Button>
      </div>
    );

  return (
    <>
      <ViewHeader title={goal.title || "Untitled goal"} subtitle={subtitle} left={left} right={right} />
      {banner}
      {isDesktop ? (
        <DesktopChart ref={chartRef} goal={goal} pillar={pillar} offset={banner ? 44 : 0} />
      ) : (
        <>
          {map ? (
            <MapView goal={goal} />
          ) : (
            <FocusView goal={goal} pillar={pillar} onEdit={setEditing} onMenu={setMenuCell} />
          )}
          <EditorSheet goal={goal} coord={editing} onClose={() => setEditing(null)} onMove={setEditing} />
          <CellMenuSheet
            goal={goal}
            cellId={menuCell}
            onClose={() => setMenuCell(null)}
            onEdit={(coord) => {
              setMenuCell(null);
              setEditing(coord);
            }}
          />
          <JumpSheet goal={goal} open={jumpOpen} current={pillar} onClose={() => setJumpOpen(false)} />
        </>
      )}
    </>
  );
}
