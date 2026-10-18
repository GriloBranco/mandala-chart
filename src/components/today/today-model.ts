import { weekInfo } from "@/domain/week";
import {
  actionLever,
  dayKey,
  fillCounts,
  isFilled,
  PILLAR_SLOT,
  pillarCell,
  todayItems,
  type TodayItem,
} from "@/domain/mandala";
import type { Checkin, GoalWithCells } from "@/domain/types";
import { shortGoalTitle } from "@/components/report/format";

export type SetupStep = "pillars" | "actions" | "pick";

export interface IdleGoal {
  goal: GoalWithCells;
  /** What this goal needs before it can show anything on Today. */
  step: SetupStep;
  /** Everything picked for this goal is done. */
  allDone: boolean;
}

export interface TodayModel {
  activeGoals: GoalWithCells[];
  habits: TodayItem[];
  /** Active tasks not done, plus ones just checked that are still fading out. */
  tasks: TodayItem[];
  doneToday: TodayItem[];
  checkedToday: Set<string>;
  /** Active goals with nothing open on Today, most recently touched first. */
  idle: IdleGoal[];
  /** Goals whose newest pick is a week old while unpicked actions wait: time to add 5-8 more. */
  rollout: GoalWithCells[];
}

// Same order as todayItems: highest lever first, then by pillar.
const byLever = (a: TodayItem, b: TodayItem) =>
  (actionLever(b.cell) ?? 0) - (actionLever(a.cell) ?? 0) || a.cell.pillar - b.cell.pillar;

function lastTouched(goal: GoalWithCells): string {
  let latest = goal.updatedAt;
  for (const cell of goal.cells) if (cell.updatedAt > latest) latest = cell.updatedAt;
  return latest;
}

function setupStep(goal: GoalWithCells): SetupStep {
  const { pillars, actions } = fillCounts(goal);
  if (!pillars) return "pillars";
  if (!actions) return "actions";
  return "pick";
}

/** Same weekly rule as the Leverage view: a new week started, nothing added yet, actions left. */
function needsRollout(goal: GoalWithCells, today: string): boolean {
  return weekInfo(goal, today).due;
}

export function buildToday(
  goals: GoalWithCells[],
  checkins: Checkin[],
  today: string,
  fading: string[],
): TodayModel {
  const activeGoals = goals.filter((goal) => goal.status === "active");
  const { habits } = todayItems(goals);
  const tasks: TodayItem[] = [];
  const doneToday: TodayItem[] = [];
  for (const goal of activeGoals) {
    for (const cell of goal.cells) {
      if (cell.slot === PILLAR_SLOT || cell.kind !== "task" || !isFilled(cell)) continue;
      const item = { goal, pillar: pillarCell(goal, cell.pillar), cell };
      const fadingOut = fading.includes(cell.id);
      if (cell.active && (cell.status !== "done" || fadingOut)) tasks.push(item);
      // doneAt, not updatedAt: rating or noting an old task must not bring it back here.
      else if (cell.status === "done" && cell.doneAt && dayKey(new Date(cell.doneAt)) === today) doneToday.push(item);
    }
  }
  tasks.sort(byLever);
  doneToday.sort((a, b) => (b.cell.doneAt ?? "").localeCompare(a.cell.doneAt ?? ""));

  const open = new Set<string>();
  for (const item of habits) open.add(item.goal.id);
  for (const item of tasks) if (item.cell.status !== "done") open.add(item.goal.id);

  const idle = activeGoals
    .filter((goal) => !open.has(goal.id))
    .sort((a, b) => lastTouched(b).localeCompare(lastTouched(a)))
    .map((goal) => ({
      goal,
      step: setupStep(goal),
      allDone: goal.cells.some((c) => c.active && c.slot !== PILLAR_SLOT && c.status === "done" && isFilled(c)),
    }));

  return {
    activeGoals,
    habits,
    tasks,
    doneToday,
    checkedToday: new Set(checkins.filter((c) => c.day === today).map((c) => c.cellId)),
    idle,
    rollout: activeGoals.filter((goal) => open.has(goal.id) && needsRollout(goal, today)),
  };
}

/** "Pillar · Goal", or just the pillar when there is only one goal. Pillar first: goal titles are long. */
export function contextLine(item: TodayItem, showGoal: boolean): string {
  const pillar = item.pillar?.text.trim() || `Pillar ${item.cell.pillar + 1}`;
  return showGoal ? `${pillar} · ${shortGoalTitle(item.goal.title)}` : pillar;
}
