"use client";

import { ChevronDown, ChevronLeft, PenLine, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AsciiSpinner } from "@/components/ascii/AsciiSpinner";
import { useShell } from "@/components/shell/ShellContext";
import { ViewHeader } from "@/components/shell/ViewHeader";
import { useToday } from "@/client/useToday";
import { Button, IconButton } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { ApiError } from "@/client/api";
import { goBack } from "@/client/nav";
import { openReport } from "@/client/report-sheet";
import { useAppState } from "@/client/store";
import { toast } from "@/client/toast";
import type { Report } from "@/domain/types";
import { dayLabel, shortGoalTitle, timeLabel } from "./format";
import { cachedReports, deleteReport, fetchReports, REPORT_SAVED_EVENT } from "./reports-data";

const LABEL = "font-mono text-[10.5px] tracking-[0.14em] text-faint";

function loadError(error: unknown): string {
  if (error instanceof ApiError && error.offline) return "You're offline. Reports load when you're back.";
  return error instanceof Error && error.message ? error.message : "Could not load reports.";
}

export function ReportsView({ goalId }: { goalId?: string }) {
  // A fresh list per scope, so switching between all reports and one goal never mixes them.
  return <ReportsList key={goalId ?? "all"} goalId={goalId} />;
}

function ReportsList({ goalId }: { goalId?: string }) {
  const { goals } = useAppState();
  const { isDesktop } = useShell();
  const today = useToday();
  const [reports, setReports] = useState<Report[] | null>(() => cachedReports(goalId));
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchReports(goalId).then(
      (list) => {
        if (!alive) return;
        setReports(list);
        setError(null);
      },
      (reason: unknown) => {
        if (alive) setError(loadError(reason));
      },
    );
    return () => {
      alive = false;
    };
  }, [goalId, version]);

  useEffect(() => {
    const reload = () => setVersion((v) => v + 1);
    window.addEventListener(REPORT_SAVED_EVENT, reload);
    window.addEventListener("online", reload);
    return () => {
      window.removeEventListener(REPORT_SAVED_EVENT, reload);
      window.removeEventListener("online", reload);
    };
  }, []);

  const goal = goalId ? goals.find((g) => g.id === goalId) : undefined;
  const goalTitles = useMemo(() => new Map(goals.map((g) => [g.id, shortGoalTitle(g.title)])), [goals]);

  const groups = useMemo(() => {
    const byDay = new Map<string, Report[]>();
    for (const report of reports ?? []) {
      const list = byDay.get(report.day) ?? [];
      list.push(report);
      byDay.set(report.day, list);
    }
    return [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [reports]);

  const write = () => openReport(goalId ?? null);
  const retry = () => {
    setError(null);
    setVersion((v) => v + 1);
  };

  const remove = async (id: string) => {
    setDeleting(true);
    try {
      await deleteReport(id);
      setReports((list) => list?.filter((report) => report.id !== id) ?? list);
      setConfirming(null);
      toast("Report deleted");
    } catch (reason) {
      toast(
        reason instanceof ApiError && reason.offline ? "You're offline. Try again when you're back." : "Could not delete the report.",
        { tone: "error" },
      );
    } finally {
      setDeleting(false);
    }
  };

  let content;
  if (reports === null && !error) {
    content = (
      <div className="grid min-h-[50dvh] place-items-center">
        <AsciiSpinner size="lg" label="Loading reports" />
      </div>
    );
  } else if (reports === null) {
    content = (
      <div className="flex min-h-[50dvh] flex-col items-center justify-center gap-4 text-center">
        <p className="max-w-xs text-[14px] leading-snug text-muted">{error}</p>
        <Button onClick={retry}>Try again</Button>
      </div>
    );
  } else if (reports.length === 0) {
    content = (
      <div className="flex min-h-[50dvh] flex-col items-center justify-center text-center">
        <p className="text-[15px] font-medium text-fg">{goalId ? "No reports for this goal yet" : "No reports yet"}</p>
        <p className="mt-1 max-w-xs text-[14px] leading-snug text-muted">
          Write a few lines about your day. Each report is kept here.
        </p>
        <Button variant="primary" className="mt-5" icon={<PenLine size={16} />} onClick={write}>
          Write a report
        </Button>
      </div>
    );
  } else {
    content = (
      <>
        {error && <p className="pt-3 text-[12.5px] text-faint">{error}</p>}
        {groups.map(([day, list]) => (
          <section key={day} className="mt-7 first:mt-3">
            <h2 className={LABEL}>{today ? dayLabel(day, today).toUpperCase() : day}</h2>
            <ul className="divide-y divide-line">
              {list.map((report) => (
                <ReportItem
                  key={report.id}
                  report={report}
                  goalTitle={!goalId && report.goalId ? goalTitles.get(report.goalId) : undefined}
                  confirming={confirming === report.id}
                  deleting={deleting && confirming === report.id}
                  onAskDelete={() => setConfirming(report.id)}
                  onCancelDelete={() => setConfirming(null)}
                  onDelete={() => void remove(report.id)}
                />
              ))}
            </ul>
          </section>
        ))}
        {reports.length >= 100 && (
          <p className="mt-8 text-center text-[12.5px] text-faint">Showing the latest 100 reports.</p>
        )}
      </>
    );
  }

  return (
    <>
      <ViewHeader
        title="Reports"
        subtitle={goalId ? goal?.title || "Goal" : undefined}
        left={
          goalId ? (
            <IconButton
              label="Back to the goal"
              onClick={() => goBack({ name: "goal", goalId, pillar: null, map: false })}
            >
              <ChevronLeft size={20} />
            </IconButton>
          ) : undefined
        }
        right={
          isDesktop ? (
            <Button variant="secondary" size="sm" icon={<PenLine size={15} />} title="Shortcut: R" onClick={write}>
              Write report
            </Button>
          ) : (
            <IconButton label="Write a report" onClick={write}>
              <PenLine size={19} />
            </IconButton>
          )
        }
      />
      <div className="mx-auto w-full max-w-[720px] px-4 pb-12 lg:px-8 lg:pt-4">{content}</div>
    </>
  );
}

function ReportItem({
  report,
  goalTitle,
  confirming,
  deleting,
  onAskDelete,
  onCancelDelete,
  onDelete,
}: {
  report: Report;
  goalTitle?: string;
  confirming: boolean;
  deleting: boolean;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const text = report.text.trim();
  const summary = report.summary.trim() || text.split("\n")[0];

  return (
    <li className="group py-4">
      <div className="flex min-h-8 items-center gap-2 text-faint">
        <span className="shrink-0 font-mono text-[11px] whitespace-nowrap">{timeLabel(report.createdAt)}</span>
        {goalTitle && <span className="min-w-0 truncate text-[12px]">· {goalTitle}</span>}
        <span className="flex-1" />
        <IconButton
          label="Delete report"
          size="lg"
          onClick={onAskDelete}
          className={cn(
            "group/delete -my-2 -mr-3",
            !confirming && "pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus-visible:opacity-100",
          )}
        >
          <Trash2 size={14} className="text-faint transition-colors group-hover/delete:text-danger" />
        </IconButton>
      </div>

      <p className="mt-0.5 text-[15px] leading-snug text-fg">{summary}</p>

      {text && text !== summary && (
        <>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="mt-1 -mb-2 -ml-1 flex min-h-10 items-center gap-1 rounded-full px-1 text-[12.5px] text-faint transition-colors hover:text-muted"
          >
            Full report
            <ChevronDown size={12} className={cn("transition-transform", open && "rotate-180")} />
          </button>
          {open && (
            <p className="mt-1 animate-fade-in whitespace-pre-wrap text-[14px] leading-relaxed text-muted">{text}</p>
          )}
        </>
      )}

      {confirming && (
        <div className="mt-3 flex animate-fade-in flex-wrap items-center gap-2 rounded-[14px] bg-softer py-2.5 pr-2.5 pl-4">
          <p className="min-w-0 flex-1 text-[13.5px] leading-snug text-fg">
            Delete this report?
          </p>
          <div className="flex gap-1.5">
            <Button variant="ghost" size="sm" onClick={onCancelDelete} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" className="bg-red-50" loading={deleting} autoFocus onClick={onDelete}>
              Delete
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
