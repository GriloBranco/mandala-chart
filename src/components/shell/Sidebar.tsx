"use client";

import { ChevronDown, CircleUserRound, Mic, NotebookPen, Plus, Sun } from "lucide-react";
import { useMemo, useState } from "react";
import { dayKey, goalProgress, isFilled, pillarCell, pillarProgress, todayItems } from "@/lib/mandala";
import { navigate, useView, viewGoalId, type View } from "@/lib/nav";
import { openRecorder } from "@/lib/recorder";
import { useAppState } from "@/lib/store";
import type { GoalWithCells } from "@/lib/types";
import { AccountSheet } from "@/components/account/AccountSheet";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { GoalGlyph } from "./GoalGlyph";
import { SyncStatus } from "./SyncStatus";

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { goals, checkins, user } = useAppState();
  const view = useView();
  const [showDone, setShowDone] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const today = dayKey();

  const { active, done, routinesLeft } = useMemo(() => {
    const { habits } = todayItems(goals);
    const left = habits.filter((h) => !checkins.some((c) => c.cellId === h.cell.id && c.day === today)).length;
    return {
      active: goals.filter((g) => g.status === "active"),
      done: goals.filter((g) => g.status !== "active"),
      routinesLeft: left,
    };
  }, [goals, checkins, today]);

  const go = (next: View) => {
    navigate(next);
    onNavigate?.();
  };
  const currentGoalId = "goalId" in view ? view.goalId : undefined;

  return (
    <nav className="flex h-full flex-col" aria-label="Goals">
      <div className="flex items-center gap-2.5 px-5 pt-[calc(var(--safe-top)+20px)] pb-4">
        <GoalGlyph pillars={[1, 0.5, 1, 0.5, 1, 0.5, 1, 0.5]} size={18} />
        <span className="font-mono text-[12px] font-medium tracking-[0.32em] text-fg">MANDALA</span>
      </div>

      <div className="px-3 pb-3">
        <Button variant="primary" className="w-full" icon={<Plus size={16} />} onClick={() => go({ name: "new" })}>
          New goal
        </Button>
      </div>

      <div className="space-y-0.5 px-3">
        <NavRow
          icon={<Sun size={16} />}
          label="Today"
          active={view.name === "today"}
          badge={routinesLeft || undefined}
          onClick={() => go({ name: "today" })}
        />
        <NavRow
          icon={<NotebookPen size={16} />}
          label="Reports"
          active={view.name === "reports" && !view.goalId}
          onClick={() => go({ name: "reports" })}
        />
      </div>

      <div className="mt-5 min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        <div className="px-2 pb-1.5 font-mono text-[10.5px] tracking-[0.14em] text-faint">GOALS</div>
        {active.length === 0 && <p className="px-2 py-2 text-[13px] text-muted">No goals yet.</p>}
        <ul className="space-y-0.5">
          {active.map((goal) => (
            <li key={goal.id}>
              <GoalRow
                goal={goal}
                checkins={checkins}
                today={today}
                selected={currentGoalId === goal.id && view.name !== "reports"}
                onClick={() => go({ name: "goal", goalId: goal.id, pillar: null, map: false })}
              />
            </li>
          ))}
        </ul>
        {done.length > 0 && (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setShowDone((v) => !v)}
              className="flex w-full items-center gap-1 px-2 py-1 font-mono text-[10.5px] tracking-[0.14em] text-faint hover:text-muted"
              aria-expanded={showDone}
            >
              DONE & ARCHIVED · {done.length}
              <ChevronDown size={12} className={cn("transition-transform", showDone && "rotate-180")} />
            </button>
            {showDone && (
              <ul className="mt-1 space-y-0.5 opacity-70">
                {done.map((goal) => (
                  <li key={goal.id}>
                    <GoalRow
                      goal={goal}
                      checkins={checkins}
                      today={today}
                      selected={currentGoalId === goal.id}
                      onClick={() => go({ name: "goal", goalId: goal.id, pillar: null, map: false })}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="space-y-2 border-t border-line px-3 pt-3 pb-[calc(var(--safe-bottom)+12px)]">
        <Button
          variant="secondary"
          className="w-full"
          icon={<Mic size={16} />}
          onClick={() => {
            openRecorder(viewGoalId(view));
            onNavigate?.();
          }}
        >
          Report
        </Button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={() => {
              setAccountOpen(true);
              // On phones the drawer makes way for the sheet.
              onNavigate?.();
            }}
            className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-[13px] text-muted transition-colors hover:bg-soft hover:text-fg lg:h-9"
          >
            <CircleUserRound size={16} className="shrink-0" />
            <span className="sr-only">Account: </span>
            <span className="truncate">{user?.email ?? "Account"}</span>
          </button>
          <SyncStatus className="shrink-0 pr-1" />
        </div>
      </div>
      <AccountSheet open={accountOpen} onClose={() => setAccountOpen(false)} />
    </nav>
  );
}

function NavRow({
  icon,
  label,
  active,
  badge,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors",
        active ? "bg-soft font-medium text-fg" : "text-muted hover:bg-softer hover:text-fg",
      )}
    >
      {icon}
      <span className="flex-1 text-left">{label}</span>
      {badge !== undefined && (
        <span className="rounded-full bg-fg px-1.5 py-px font-mono text-[10px] leading-4 text-white">{badge}</span>
      )}
    </button>
  );
}

function GoalRow({
  goal,
  checkins,
  today,
  selected,
  onClick,
}: {
  goal: GoalWithCells;
  checkins: ReturnType<typeof useAppState>["checkins"];
  today: string;
  selected: boolean;
  onClick: () => void;
}) {
  const pillars = Array.from({ length: 8 }, (_, p) =>
    isFilled(pillarCell(goal, p)) ? pillarProgress(goal, p, checkins, today) : null,
  );
  const progress = goalProgress(goal, checkins, today);
  const next = goal.cells.find((c) => c.active && c.status !== "done" && c.slot >= 0 && isFilled(c));
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
        selected ? "bg-soft" : "hover:bg-softer",
      )}
    >
      <GoalGlyph pillars={pillars} size={20} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-sm", selected ? "font-medium text-fg" : "text-fg/90")}>
          {goal.title || "Untitled goal"}
        </span>
        {next && <span className="block truncate text-xs text-muted">Next: {next.text}</span>}
      </span>
      <span className="pt-0.5 font-mono text-[11px] text-faint">{Math.round(progress * 100)}%</span>
    </button>
  );
}
