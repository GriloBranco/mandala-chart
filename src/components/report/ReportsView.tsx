"use client";

import { ChevronDown, ChevronLeft, Keyboard, Mic, PenLine, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AsciiSpinner } from "@/components/ascii/AsciiSpinner";
import { useShell } from "@/components/shell/ShellContext";
import { ViewHeader } from "@/components/shell/ViewHeader";
import { useToday } from "@/components/today/useToday";
import { Button, IconButton } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { ApiError } from "@/lib/api-client";
import { goBack, navigate } from "@/lib/nav";
import { openRecorder } from "@/lib/recorder";
import { useAppState } from "@/lib/store";
import { toast } from "@/lib/toast";
import type { Cell, ReportWithEvents } from "@/lib/types";
import { dayLabel, eventLine, shortGoalTitle, timeLabel } from "./format";
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
  const { goals, aiEnabled } = useAppState();
  const { isDesktop } = useShell();
  const today = useToday();
  const [reports, setReports] = useState<ReportWithEvents[] | null>(() => cachedReports(goalId));
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
  const cells = useMemo(() => {
    const map = new Map<string, Cell>();
    for (const g of goals) for (const cell of g.cells) map.set(cell.id, cell);
    return map;
  }, [goals]);

  const groups = useMemo(() => {
    const byDay = new Map<string, ReportWithEvents[]>();
    for (const report of reports ?? []) {
      const list = byDay.get(report.day) ?? [];
      list.push(report);
      byDay.set(report.day, list);
    }
    return [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [reports]);

  const record = () => openRecorder(goalId ?? null, { typed: !aiEnabled });
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

  const openCell = (cell: Cell) => navigate({ name: "goal", goalId: cell.goalId, pillar: cell.pillar, map: false });

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
          {aiEnabled
            ? "Talk for a minute about your day. You review every change before it is saved."
            : "Write a few lines about your day. Each report is kept here."}
        </p>
        <Button
          variant="primary"
          className="mt-5"
          icon={aiEnabled ? <Mic size={16} /> : <PenLine size={16} />}
          onClick={record}
        >
          {aiEnabled ? "Record a report" : "Write a report"}
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
                  scopeGoalId={goalId}
                  goalTitle={!goalId && report.goalId ? goalTitles.get(report.goalId) : undefined}
                  cells={cells}
                  confirming={confirming === report.id}
                  deleting={deleting && confirming === report.id}
                  onAskDelete={() => setConfirming(report.id)}
                  onCancelDelete={() => setConfirming(null)}
                  onDelete={() => void remove(report.id)}
                  onOpenCell={openCell}
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
            <Button
              variant="secondary"
              size="sm"
              icon={aiEnabled ? <Mic size={15} /> : <PenLine size={15} />}
              title="Shortcut: R"
              onClick={record}
            >
              {aiEnabled ? "Record" : "Write report"}
            </Button>
          ) : (
            <IconButton label={aiEnabled ? "Record a report" : "Write a report"} onClick={record}>
              {aiEnabled ? <Mic size={20} /> : <PenLine size={19} />}
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
  scopeGoalId,
  goalTitle,
  cells,
  confirming,
  deleting,
  onAskDelete,
  onCancelDelete,
  onDelete,
  onOpenCell,
}: {
  report: ReportWithEvents;
  /** In a goal's reports, only that goal's changes are listed. */
  scopeGoalId?: string;
  goalTitle?: string;
  cells: Map<string, Cell>;
  confirming: boolean;
  deleting: boolean;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
  onOpenCell: (cell: Cell) => void;
}) {
  const [open, setOpen] = useState(false);
  const transcript = report.transcript.trim();
  const summary = report.summary.trim() || transcript.split("\n")[0];
  const events = scopeGoalId ? report.events.filter((event) => event.goalId === scopeGoalId) : report.events;
  const voice = report.source === "voice";
  const SourceIcon = voice ? Mic : Keyboard;

  return (
    <li className="group py-4">
      <div className="flex min-h-8 items-center gap-2 text-faint">
        <SourceIcon size={13} aria-hidden />
        <span className="sr-only">{voice ? "Voice report" : "Typed report"}</span>
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

      {events.length > 0 && (
        <ul className="mt-2.5 space-y-1">
          {events.map((event) => {
            const cell = event.cellId ? cells.get(event.cellId) : undefined;
            const line = eventLine(event, report.day, cell?.text);
            return (
              <li key={event.id}>
                <button
                  type="button"
                  disabled={!cell}
                  onClick={() => cell && onOpenCell(cell)}
                  className="group/line flex w-full items-baseline gap-2.5 py-0.5 text-left text-[13.5px] leading-snug"
                >
                  <span className="w-3 shrink-0 text-center font-mono text-[12px] text-faint" aria-hidden>
                    {line.glyph}
                  </span>
                  <span className="min-w-0 text-muted">
                    <span className="text-fg/80 group-enabled/line:group-hover/line:underline group-enabled/line:group-hover/line:decoration-line-strong group-enabled/line:group-hover/line:underline-offset-2">
                      {line.name}
                    </span>
                    {line.change && ` · ${line.change}`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {transcript && transcript !== summary && (
        <>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="mt-1 -mb-2 -ml-1 flex min-h-10 items-center gap-1 rounded-full px-1 text-[12.5px] text-faint transition-colors hover:text-muted"
          >
            Transcript
            <ChevronDown size={12} className={cn("transition-transform", open && "rotate-180")} />
          </button>
          {open && (
            <p className="mt-1 animate-fade-in whitespace-pre-wrap text-[14px] leading-relaxed text-muted">{transcript}</p>
          )}
        </>
      )}

      {confirming && (
        <div className="mt-3 flex animate-fade-in flex-wrap items-center gap-2 rounded-[14px] bg-softer py-2.5 pr-2.5 pl-4">
          <p className="min-w-0 flex-1 text-[13.5px] leading-snug text-fg">
            Delete this report? Changes it made to your chart stay.
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
