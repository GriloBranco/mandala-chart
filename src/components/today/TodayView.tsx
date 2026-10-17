"use client";

import { CalendarMinus, ChevronDown, ChevronRight, Circle, CircleDot, LayoutGrid, Mic, PenLine, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { daysBetween, longDate, shortGoalTitle } from "@/components/report/format";
import { GoalGlyph } from "@/components/shell/GoalGlyph";
import { Headline } from "@/components/shell/Headline";
import { ViewHeader } from "@/components/shell/ViewHeader";
import { Button, IconButton } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { useIsDesktop, useMediaQuery } from "@/components/ui/hooks";
import { fillCounts, goalProgress, isFilled, pillarCell, pillarProgress, type TodayItem } from "@/lib/mandala";
import { navigate, type View } from "@/lib/nav";
import { openRecorder } from "@/lib/recorder";
import { actions, localKey, useAppState } from "@/lib/store";
import { toast } from "@/lib/toast";
import type { CellStatus, Checkin, GoalWithCells } from "@/lib/types";
import { ReportCard } from "./ReportCard";
import { buildToday, contextLine, type IdleGoal, type SetupStep } from "./today-model";
import { DoneRow, HabitRow, MenuSheet, RowMenu, TaskRow, type MenuItem } from "./TodayRows";
import { useToday } from "./useToday";
import { Welcome } from "./Welcome";

const LABEL = "font-mono text-[10.5px] tracking-[0.14em] text-faint";

const SETUP: Record<SetupStep, { title: string; body: string; action: string; view: (goal: GoalWithCells) => View }> = {
  pillars: {
    title: "Finish your chart",
    body: "Name the 8 pillars around your goal: what has to be true to get there.",
    action: "Name the pillars",
    view: (goal) => ({ name: "new", goalId: goal.id, step: 2 }),
  },
  actions: {
    title: "Add your actions",
    body: "Write small steps for each pillar, things you can tick off.",
    action: "Add actions",
    view: (goal) => ({ name: "new", goalId: goal.id, step: 3 }),
  },
  pick: {
    title: "Pick this week's actions",
    body: "Start with 5-8. One from each pillar if you can, and actions that help two pillars first.",
    action: "Pick actions",
    view: (goal) => ({ name: "lever", goalId: goal.id }),
  },
};

// Quiet cards the user hid stay hidden for a week (kept on this device only, per account).
const DISMISS = "today-dismissed:v1";

function readDismissed(): Record<string, string> {
  const key = localKey(DISMISS)?.key;
  if (!key) return {};
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function TodayView() {
  const { goals, aiEnabled } = useAppState();
  if (!goals.length) return <Welcome voice={aiEnabled} />;
  return <TodayList />;
}

function TodayList() {
  const { goals, checkins, aiEnabled, offline } = useAppState();
  const today = useToday();
  const isDesktop = useIsDesktop();
  // Mouse users get a "..." menu on hover; touch users long-press a row.
  const mouse = useMediaQuery("(hover: hover) and (pointer: fine)");
  const [fading, setFading] = useState<string[]>([]);
  const [menuCell, setMenuCell] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [dismissed, setDismissed] = useState(readDismissed);
  /** Status before a task was checked here, so unchecking puts "doing" back. */
  const before = useRef(new Map<string, CellStatus>());

  useEffect(() => {
    const key = localKey(DISMISS)?.key;
    if (!key) return;
    try {
      window.localStorage.setItem(key, JSON.stringify(dismissed));
    } catch {
      // Private mode: the card just comes back next time.
    }
  }, [dismissed]);

  const model = useMemo(() => buildToday(goals, checkins, today, fading), [goals, checkins, today, fading]);
  const showGoal = model.activeGoals.length > 1;
  const habitsDone = model.habits.filter((item) => model.checkedToday.has(item.cell.id)).length;
  const hasOpen = model.habits.length > 0 || model.tasks.some((item) => item.cell.status !== "done");

  // ---------- actions ----------

  const openChart = (item: TodayItem) =>
    navigate({ name: "goal", goalId: item.goal.id, pillar: item.cell.pillar, map: false });

  const toggleHabit = (item: TodayItem, done: boolean) => {
    const id = item.cell.id;
    actions.toggleCheckin(id, today, done);
    const undo = { label: "Undo", run: () => actions.toggleCheckin(id, today, !done) };
    if (!done) {
      toast("Unchecked", { action: undo });
      return;
    }
    const left = model.habits.filter((h) => h.cell.id !== id && !model.checkedToday.has(h.cell.id)).length;
    toast(left === 0 && model.habits.length > 1 ? "All routines done today" : "Done for today", { action: undo });
  };

  const setTaskDone = (item: TodayItem, done: boolean) => {
    const id = item.cell.id;
    if (done) {
      const previous = item.cell.status;
      before.current.set(id, previous);
      actions.updateCell(id, { status: "done" });
      // Stay in place, checked, for a moment, then move to "Done today".
      setFading((ids) => [...ids, id]);
      setTimeout(() => setFading((ids) => ids.filter((x) => x !== id)), 1200);
      toast(`Done · ${item.cell.text}`, {
        action: { label: "Undo", run: () => actions.updateCell(id, { status: previous }) },
      });
    } else {
      const back = before.current.get(id) ?? "todo";
      before.current.delete(id);
      actions.updateCell(id, { status: back });
      setFading((ids) => ids.filter((x) => x !== id));
      toast("Marked not done", { action: { label: "Undo", run: () => actions.updateCell(id, { status: "done" }) } });
    }
  };

  const setDoing = (item: TodayItem, doing: boolean) => {
    const id = item.cell.id;
    const previous = item.cell.status;
    actions.updateCell(id, { status: doing ? "doing" : "todo" });
    toast(doing ? "Marked as doing" : "Marked as not started", {
      action: { label: "Undo", run: () => actions.updateCell(id, { status: previous }) },
    });
  };

  const removeFromWeek = (item: TodayItem) => {
    const id = item.cell.id;
    const activatedAt = item.cell.activatedAt;
    actions.updateCell(id, { active: false });
    toast("Removed from this week", {
      action: { label: "Undo", run: () => actions.updateCell(id, { active: true, activatedAt }) },
    });
  };

  const menuFor = (item: TodayItem): MenuItem[] => {
    const items: MenuItem[] = [];
    if (item.cell.kind === "task") {
      items.push(
        item.cell.status === "doing"
          ? { label: "Mark as not started", icon: <Circle size={16} />, run: () => setDoing(item, false) }
          : { label: "Mark as doing", icon: <CircleDot size={16} />, run: () => setDoing(item, true) },
      );
    }
    items.push({ label: "Remove from this week", icon: <CalendarMinus size={16} />, run: () => removeFromWeek(item) });
    items.push({ label: "Open in chart", icon: <LayoutGrid size={16} />, run: () => openChart(item) });
    return items;
  };

  const rowMenu = (item: TodayItem) => (mouse ? <RowMenu label={item.cell.text} items={menuFor(item)} /> : null);
  const longPress = (item: TodayItem) => (mouse ? undefined : () => setMenuCell(item.cell.id));
  const menuTarget = menuCell ? [...model.habits, ...model.tasks].find((item) => item.cell.id === menuCell) : undefined;

  const isHidden = (key: string) => {
    const day = dismissed[key];
    return Boolean(day && today && daysBetween(day, today) < 7);
  };
  const hide = (key: string) => {
    setDismissed((current) => ({ ...current, [key]: today }));
    toast("Hidden for a week", {
      action: {
        label: "Undo",
        run: () =>
          setDismissed((current) => {
            const next = { ...current };
            delete next[key];
            return next;
          }),
      },
    });
  };

  // ---------- layout ----------

  const voice = aiEnabled;
  const quietIdle = hasOpen ? model.idle.filter(({ goal }) => !isHidden(`idle:${goal.id}`)) : [];
  const quietRollout = model.rollout.filter((goal) => !isHidden(`rollout:${goal.id}`));

  return (
    <>
      <ViewHeader
        title="Today"
        subtitle={today ? `${longDate(today)}${offline ? " · Offline" : ""}` : undefined}
        right={
          isDesktop ? (
            <Button
              variant="secondary"
              size="sm"
              icon={voice ? <Mic size={15} /> : <PenLine size={15} />}
              title="Shortcut: R"
              onClick={() => openRecorder(null, { typed: !voice })}
            >
              {voice ? "Record" : "Write report"}
            </Button>
          ) : undefined
        }
      />

      <div className="mx-auto w-full max-w-[720px] px-4 pt-6 pb-12 lg:px-8 lg:pt-10">
        <Headline editable className="mb-6 text-[26px] leading-[1.15] lg:mb-9 lg:text-[34px] lg:leading-[1.12]" />
        <ReportCard today={today} voice={voice} />

        {model.habits.length > 0 && (
          <Section
            label={`ROUTINES · ${habitsDone}/${model.habits.length}`}
            aside={habitsDone === model.habits.length ? "All done today" : undefined}
          >
            <ul className="divide-y divide-line">
              {model.habits.map((item) => (
                <HabitRow
                  key={item.cell.id}
                  item={item}
                  context={contextLine(item, showGoal)}
                  done={model.checkedToday.has(item.cell.id)}
                  checkins={checkins}
                  today={today}
                  onToggle={(done) => toggleHabit(item, done)}
                  onOpen={() => openChart(item)}
                  menu={rowMenu(item)}
                  onLongPress={longPress(item)}
                />
              ))}
            </ul>
          </Section>
        )}

        {model.tasks.length > 0 && (
          <Section label="THIS WEEK">
            <ul className="divide-y divide-line">
              {model.tasks.map((item) => (
                <TaskRow
                  key={item.cell.id}
                  item={item}
                  context={contextLine(item, showGoal)}
                  fading={item.cell.status === "done"}
                  onToggle={(done) => setTaskDone(item, done)}
                  onOpen={() => openChart(item)}
                  menu={rowMenu(item)}
                  onLongPress={longPress(item)}
                />
              ))}
            </ul>
          </Section>
        )}

        {model.doneToday.length > 0 && (
          <section className="mt-6">
            <button
              type="button"
              aria-expanded={showDone}
              onClick={() => setShowDone((value) => !value)}
              className={cn(LABEL, "-ml-1 flex min-h-11 items-center gap-1 rounded-full px-1 transition-colors hover:text-muted")}
            >
              DONE TODAY · {model.doneToday.length}
              <ChevronDown size={12} className={cn("transition-transform", showDone && "rotate-180")} />
            </button>
            {showDone && (
              <ul className="animate-fade-in divide-y divide-line">
                {model.doneToday.map((item) => (
                  <DoneRow
                    key={item.cell.id}
                    item={item}
                    context={contextLine(item, showGoal)}
                    onUndo={() => setTaskDone(item, false)}
                    onOpen={() => openChart(item)}
                  />
                ))}
              </ul>
            )}
          </section>
        )}

        {!hasOpen && model.idle.length > 0 && (
          <SetupCard entries={model.idle} checkins={checkins} today={today} />
        )}

        {!hasOpen && model.activeGoals.length === 0 && (
          <section className="mt-8 rounded-[16px] border border-line p-5">
            <h2 className="text-[17px] font-semibold tracking-tight">No active goals</h2>
            <p className="mt-1 text-[14px] leading-snug text-muted">Your goals are achieved or archived. Start a new one.</p>
            <Button variant="primary" className="mt-4" icon={<Plus size={16} />} onClick={() => navigate({ name: "new" })}>
              New goal
            </Button>
          </section>
        )}

        {(quietIdle.length > 0 || quietRollout.length > 0) && (
          <div className="mt-8 space-y-2">
            {quietRollout.map((goal) => (
              <QuietCard
                key={`rollout:${goal.id}`}
                label={showGoal ? shortGoalTitle(goal.title) : undefined}
                text="New week: add 5-8 more"
                action="Add more"
                onAction={() => navigate({ name: "lever", goalId: goal.id })}
                onHide={() => hide(`rollout:${goal.id}`)}
              />
            ))}
            {quietIdle.map(({ goal, step }) => (
              <QuietCard
                key={`idle:${goal.id}`}
                label={shortGoalTitle(goal.title)}
                text={IDLE_TEXT[step]}
                action={SETUP[step].action}
                onAction={() => navigate(SETUP[step].view(goal))}
                onHide={() => hide(`idle:${goal.id}`)}
              />
            ))}
          </div>
        )}

        {model.activeGoals.length > 0 && (
          <div className="lg:hidden">
            <GoalsList goals={model.activeGoals} checkins={checkins} today={today} />
          </div>
        )}
      </div>

      {menuTarget && (
        <MenuSheet title={menuTarget.cell.text} items={menuFor(menuTarget)} onClose={() => setMenuCell(null)} />
      )}
    </>
  );
}

const IDLE_TEXT: Record<SetupStep, string> = {
  pillars: "Name the pillars to finish the chart",
  actions: "Add actions to the chart",
  pick: "Nothing picked this week",
};

function Section({ label, aside, children }: { label: string; aside?: string; children: ReactNode }) {
  return (
    <section className="mt-9">
      <div className="flex items-baseline justify-between gap-3 pb-1">
        <h2 className={LABEL}>{label}</h2>
        {aside && <span className="text-[12.5px] text-muted">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function QuietCard({
  label,
  text,
  action,
  onAction,
  onHide,
}: {
  /** The goal it is about, when there are several. */
  label?: string;
  text: string;
  action: string;
  onAction: () => void;
  onHide: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-[14px] bg-softer py-2 pr-2 pl-4">
      <div className="min-w-0 flex-1 py-1">
        {label && <p className="truncate text-[12px] text-faint">{label}</p>}
        <p className="text-[14px] leading-snug text-muted">{text}</p>
      </div>
      <Button variant="secondary" size="sm" onClick={onAction}>
        {action}
      </Button>
      <IconButton label="Hide for a week" size="lg" onClick={onHide} className="-my-1 -ml-1">
        <X size={15} className="text-faint" />
      </IconButton>
    </div>
  );
}

function pillarGlyphs(goal: GoalWithCells, checkins: Checkin[], today: string): (number | null)[] {
  return Array.from({ length: 8 }, (_, p) =>
    isFilled(pillarCell(goal, p)) ? pillarProgress(goal, p, checkins, today) : null,
  );
}

/** Nothing on Today yet: the one next step that gets something there. */
function SetupCard({ entries, checkins, today }: { entries: IdleGoal[]; checkins: Checkin[]; today: string }) {
  if (entries.length === 1) {
    const { goal, step, allDone } = entries[0];
    const copy = SETUP[step];
    const praise = allDone && step === "pick";
    return (
      <section className="mt-8 rounded-[16px] border border-line p-5">
        <h2 className="text-[17px] font-semibold tracking-tight">{praise ? "All done. Pick what's next" : copy.title}</h2>
        <p className="mt-1 text-[14px] leading-snug text-muted">
          {praise ? "Everything you picked is done. Keep it and add 5-8 more." : copy.body}
        </p>
        <Button variant="primary" className="mt-4" onClick={() => navigate(copy.view(goal))}>
          {copy.action}
        </Button>
      </section>
    );
  }
  return (
    <section className="mt-8 rounded-[16px] border border-line p-5">
      <h2 className="text-[17px] font-semibold tracking-tight">Pick this week&apos;s actions</h2>
      <p className="mt-1 text-[14px] leading-snug text-muted">{SETUP.pick.body}</p>
      <ul className="-mx-2 mt-3">
        {entries.map(({ goal, step }) => (
          <li key={goal.id}>
            <button
              type="button"
              onClick={() => navigate(SETUP[step].view(goal))}
              className="flex min-h-12 w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-softer"
            >
              <GoalGlyph pillars={pillarGlyphs(goal, checkins, today)} size={22} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] text-fg">{goal.title || "Untitled goal"}</span>
                <span className="block text-[12.5px] text-faint">{SETUP[step].action}</span>
              </span>
              <ChevronRight size={16} className="shrink-0 text-faint" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Phones only: the sidebar already lists goals on desktop. */
function GoalsList({ goals, checkins, today }: { goals: GoalWithCells[]; checkins: Checkin[]; today: string }) {
  return (
    <Section label="GOALS">
      <ul className="divide-y divide-line">
        {goals.map((goal) => {
          const progress = goalProgress(goal, checkins, today);
          const next = goal.cells.find((c) => c.active && c.status !== "done" && c.slot >= 0 && isFilled(c));
          const counts = fillCounts(goal);
          return (
            <li key={goal.id}>
              <button
                type="button"
                onClick={() => navigate({ name: "goal", goalId: goal.id, pillar: null, map: false })}
                className="flex min-h-14 w-full items-center gap-3 py-2.5 text-left"
              >
                <GoalGlyph pillars={pillarGlyphs(goal, checkins, today)} size={26} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] text-fg">{goal.title || "Untitled goal"}</span>
                  <span className="block truncate text-[12.5px] text-faint">
                    {next ? `Next: ${next.text}` : `${counts.pillars}/8 pillars · ${counts.actions}/64 actions`}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-[12px] text-faint">{Math.round(progress * 100)}%</span>
                <ChevronRight size={16} className="shrink-0 text-line-strong" />
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={() => navigate({ name: "new" })}
        className="mt-1 -ml-2 flex h-10 items-center gap-1.5 rounded-full px-2 text-[13.5px] text-muted transition-colors hover:bg-soft hover:text-fg"
      >
        <Plus size={15} />
        New goal
      </button>
    </Section>
  );
}
