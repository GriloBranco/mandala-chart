"use client";

import { PenLine, Sun, LayoutGrid } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { GoalView } from "@/components/goal/GoalView";
import { LeverageView } from "@/components/lever/LeverageView";
import { NewGoalFlow } from "@/components/new/NewGoalFlow";
import { ReportSheet } from "@/components/report/ReportSheet";
import { ReportsView } from "@/components/report/ReportsView";
import { TodayView } from "@/components/today/TodayView";
import { AsciiSpinner } from "@/components/ascii/AsciiSpinner";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { useIsDesktop } from "@/components/ui/hooks";
import { Toaster } from "@/components/ui/Toaster";
import { navigate, useView, viewGoalId, type View } from "@/client/nav";
import { closeReport, openReport, useReportRequest } from "@/client/report-sheet";
import { actions, startStore, useAppState } from "@/client/store";
import { ShellContext } from "./ShellContext";
import { Sidebar } from "./Sidebar";

const noop = () => () => {};

/**
 * The app only renders in the browser: its data comes from this device's cache and the API,
 * and many views read today's date, which must not be frozen into a prerendered page.
 * The server sends a static loading shell instead.
 */
export function MandalaApp() {
  const inBrowser = useSyncExternalStore(noop, () => true, () => false);
  if (!inBrowser) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <AsciiSpinner size="lg" label="Loading" />
      </div>
    );
  }
  return <App />;
}

function App() {
  const view = useView();
  const isDesktop = useIsDesktop();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const report = useReportRequest();

  useEffect(() => {
    startStore();
    // Home-screen shortcut and deep link: /?report=1 opens the report sheet straight away.
    const params = new URLSearchParams(window.location.search);
    if (params.has("report")) {
      params.delete("report");
      const query = params.toString();
      window.history.replaceState(window.history.state, "", query ? `/?${query}` : "/");
      openReport(null);
    }
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) return;
      if (event.key === "r" || event.key === "R") {
        event.preventDefault();
        openReport(viewGoalId(view));
      } else if (event.key === "n" || event.key === "N") {
        event.preventDefault();
        navigate({ name: "new" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);

  const shell = useMemo(() => ({ openDrawer: () => setDrawerOpen(true), isDesktop }), [isDesktop]);
  const fullScreen = view.name === "new";

  return (
    <ShellContext value={shell}>
      <div className="flex min-h-dvh">
        {isDesktop && !fullScreen && (
          <aside className="sticky top-0 h-dvh w-[264px] shrink-0 border-r border-line bg-softer/60">
            <Sidebar />
          </aside>
        )}
        {!isDesktop && <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />}

        <main className={cn("min-w-0 flex-1", !isDesktop && !fullScreen && "pb-[calc(76px+var(--safe-bottom))]")}>
          <Content view={view} />
        </main>

        {!isDesktop && !fullScreen && <BottomBar view={view} onGoals={() => setDrawerOpen(true)} />}
        <ReportSheet open={report.open} goalId={report.goalId} onClose={closeReport} />
        <Toaster />
      </div>
    </ShellContext>
  );
}

function Content({ view }: { view: View }) {
  const { status, goals, error } = useAppState();

  if (status === "idle" || (status === "loading" && !goals.length)) {
    return (
      <div className="grid min-h-[70dvh] place-items-center">
        <AsciiSpinner size="lg" label="Loading" />
      </div>
    );
  }
  if (status === "error" && !goals.length) {
    return (
      <div className="mx-auto flex min-h-[70dvh] max-w-sm flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-sm text-muted">{error ?? "Could not load your goals."}</p>
        <Button onClick={() => actions.refresh()}>Try again</Button>
      </div>
    );
  }

  const known = (id: string) => goals.some((g) => g.id === id);
  switch (view.name) {
    case "today":
      return <TodayView />;
    case "reports":
      return <ReportsView goalId={view.goalId} />;
    case "new":
      return <NewGoalFlow goalId={view.goalId} step={view.step} />;
    case "lever":
      return known(view.goalId) ? <LeverageView goalId={view.goalId} /> : <Missing />;
    case "goal":
      return known(view.goalId) ? (
        <GoalView goalId={view.goalId} pillar={view.pillar} map={view.map} />
      ) : (
        <Missing />
      );
  }
}

function Missing() {
  return (
    <div className="mx-auto flex min-h-[70dvh] max-w-sm flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-sm text-muted">This goal is gone or not loaded yet.</p>
      <Button onClick={() => navigate({ name: "today" }, { replace: true })}>Go to Today</Button>
    </div>
  );
}

function Drawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <div className={cn("fixed inset-0 z-40", !open && "pointer-events-none")} aria-hidden={!open}>
      <div
        className={cn("absolute inset-0 bg-black/25 transition-opacity duration-200", open ? "opacity-100" : "opacity-0")}
        onClick={onClose}
      />
      <aside
        className={cn(
          "absolute inset-y-0 left-0 w-[86%] max-w-[320px] bg-bg shadow-[8px_0_30px_rgba(0,0,0,0.08)] transition-transform duration-250 ease-out",
          open ? "translate-x-0" : "-translate-x-full",
        )}
        inert={!open}
      >
        <Sidebar onNavigate={onClose} />
      </aside>
    </div>
  );
}

function BottomBar({ view, onGoals }: { view: View; onGoals: () => void }) {
  const goalScope = viewGoalId(view);
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/95 pb-[var(--safe-bottom)] backdrop-blur-md"
    >
      <div className="mx-auto flex h-[68px] max-w-md items-center justify-around px-6">
        <TabButton label="Today" active={view.name === "today"} onClick={() => navigate({ name: "today" })}>
          <Sun size={20} />
        </TabButton>
        <button
          type="button"
          aria-label={goalScope ? "Write a report for this goal" : "Write a report"}
          onClick={() => openReport(goalScope)}
          className="-mt-6 grid size-16 place-items-center rounded-full bg-fg text-white shadow-[0_6px_20px_rgba(0,0,0,0.18)] transition-transform active:scale-95"
        >
          <PenLine size={22} />
        </button>
        <TabButton label="Goals" active={view.name === "goal" || view.name === "lever"} onClick={onGoals}>
          <LayoutGrid size={20} />
        </TabButton>
      </div>
    </nav>
  );
}

function TabButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-16 flex-col items-center gap-1 text-[11px] font-medium transition-colors",
        active ? "text-fg" : "text-faint",
      )}
    >
      {children}
      {label}
    </button>
  );
}
