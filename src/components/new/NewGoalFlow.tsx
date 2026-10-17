"use client";

import { X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { AsciiSpinner } from "@/components/ascii/AsciiSpinner";
import { Button, IconButton } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { goBack, navigate } from "@/lib/nav";
import { useAppState, useGoal } from "@/lib/store";
import { ActionsStep } from "./ActionsStep";
import { GoalStep } from "./GoalStep";
import { PillarsStep } from "./PillarsStep";
import { ReadyStep } from "./ReadyStep";
import { useViewport } from "./viewport";
import { WeekStep } from "./WeekStep";

const STEPS = ["Goal", "Pillars", "Actions", "Week 1"];

/**
 * The new goal flow: goal, 8 pillars, 64 actions, then week 1. Full screen. The goal is
 * created at the end of step 1 and every later edit saves as you go, so closing is always
 * safe; the URL keeps the goal and the step.
 */
export function NewGoalFlow({ goalId, step }: { goalId?: string; step?: number }) {
  const goal = useGoal(goalId);
  const { status } = useAppState();
  const { keyboard } = useViewport();
  // "Rename pillar" from step 3 opens step 2 on that pillar.
  const [pillarHandoff, setPillarHandoff] = useState<number | null>(null);
  // The chart input has focus. With the phone keyboard up, steps 2 and 3 give the grid all
  // the room: no top bar, no Back/Next until the keyboard goes away.
  const [composer, setComposer] = useState(false);
  useBlockNewGoalKey();

  const current = goal ? Math.min(Math.max(step ?? 1, 1), 5) : 1;
  const typing = composer && keyboard && (current === 2 || current === 3);
  const go = (next: number, id = goal?.id) => {
    setComposer(false);
    setPillarHandoff(null);
    navigate({ name: "new", goalId: id, step: next > 1 ? next : undefined }, { replace: true });
  };
  const openChart = (id: string) => navigate({ name: "goal", goalId: id, pillar: null, map: false }, { replace: true });
  const close = () => (goal ? openChart(goal.id) : goBack({ name: "today" }));
  const toPillars = (pillar: number | null) => {
    go(2);
    setPillarHandoff(pillar);
  };

  let body: ReactNode;
  if (goalId && !goal) {
    body = status === "loading" || status === "idle" ? <Loading /> : <Gone />;
  } else if (!goal || current === 1) {
    body = <GoalStep key={goal?.id ?? "new"} goal={goal} onNext={(created) => go(2, created.id)} />;
  } else if (current === 2) {
    body = (
      <PillarsStep
        key={goal.id}
        goal={goal}
        initialSlot={pillarHandoff}
        typing={typing}
        onComposerFocus={setComposer}
        onEditGoal={() => go(1)}
        onBack={() => go(1)}
        onNext={() => go(3)}
      />
    );
  } else if (current === 3) {
    body = (
      <ActionsStep
        key={goal.id}
        goal={goal}
        typing={typing}
        onComposerFocus={setComposer}
        onBack={() => toPillars(null)}
        onNext={() => go(4)}
        onEditPillar={toPillars}
      />
    );
  } else if (current === 4) {
    body = <WeekStep key={goal.id} goal={goal} onBack={() => go(3)} onFinish={() => go(5)} />;
  } else {
    body = <ReadyStep goal={goal} onOpen={() => openChart(goal.id)} />;
  }

  return (
    <Frame>
      {typing ? (
        <div className="flex-none pt-[var(--safe-top)]" />
      ) : (
        <TopBar
          step={goalId && !goal ? 0 : current}
          onJump={goal ? (n) => (n === 2 ? toPillars(null) : go(n)) : undefined}
          onClose={close}
        />
      )}
      {body}
    </Frame>
  );
}

/** Fills the visible screen. On a phone that is the area above the keyboard. */
function Frame({ children }: { children: ReactNode }) {
  const { coarse, height, top } = useViewport();
  const sized = coarse && height > 0;
  return (
    <div
      className={cn("fixed inset-x-0 z-30 flex flex-col bg-bg", !sized && "inset-y-0")}
      style={sized ? { top, height } : undefined}
    >
      {children}
    </div>
  );
}

function TopBar({
  step,
  onJump,
  onClose,
}: {
  step: number;
  onJump?: (step: number) => void;
  onClose: () => void;
}) {
  const name = step >= 5 ? "Ready" : (STEPS[step - 1] ?? "");
  return (
    <header className="flex-none border-b border-line bg-bg pt-[var(--safe-top)]">
      <div className="flex h-12 items-center gap-2 px-2 lg:h-14 lg:px-4">
        <IconButton label="Close" onClick={onClose}>
          <X size={20} />
        </IconButton>
        <div className="flex min-w-0 flex-1 items-center justify-center gap-2.5">
          {step > 0 && (
            <nav aria-label="Steps" className="flex items-center">
              {STEPS.map((label, i) => {
                const n = i + 1;
                const state = n === step ? "current" : n < step || step >= 5 ? "done" : "todo";
                const dot = (
                  <span
                    aria-hidden
                    className={cn(
                      "block h-1.5 rounded-full transition-all duration-300",
                      state === "current" ? "w-5 bg-fg" : "w-1.5",
                      state === "done" && "bg-fg",
                      state === "todo" && "bg-line-strong",
                    )}
                  />
                );
                return onJump ? (
                  <button
                    key={label}
                    type="button"
                    onClick={() => n !== step && onJump(n)}
                    aria-label={`Step ${n}: ${label}`}
                    aria-current={state === "current" ? "step" : undefined}
                    className="grid h-8 place-items-center rounded-full px-1"
                  >
                    {dot}
                  </button>
                ) : (
                  <span key={label} className="grid h-8 place-items-center px-1">
                    {dot}
                  </span>
                );
              })}
            </nav>
          )}
          {name && (
            <span className="truncate text-[13px] font-medium">
              <span className="sr-only">{step <= 4 ? `Step ${step} of 4: ` : ""}</span>
              {name}
            </span>
          )}
        </div>
        <span className="size-10 shrink-0" aria-hidden />
      </div>
    </header>
  );
}

function Loading() {
  return (
    <div className="grid flex-1 place-items-center">
      <AsciiSpinner size="lg" label="Loading" />
    </div>
  );
}

function Gone() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-sm text-muted">This goal is gone.</p>
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => navigate({ name: "new" }, { replace: true })}>
          Start a new goal
        </Button>
        <Button variant="ghost" onClick={() => navigate({ name: "today" }, { replace: true })}>
          Go to Today
        </Button>
      </div>
    </div>
  );
}

/** N starts a new goal elsewhere in the app; here it would throw away your place. */
function useBlockNewGoalKey() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "n" && event.key !== "N") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      event.preventDefault();
    };
    // Capture phase, so this runs before the app's own shortcut handler.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
