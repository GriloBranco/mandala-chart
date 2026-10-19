"use client";

import { PenLine } from "lucide-react";
import { useId } from "react";
import { sinceLabel, timeLabel } from "@/components/report/format";
import { useLatestReport } from "@/components/report/reports-data";
import { navigate } from "@/client/nav";
import { openReport } from "@/client/report-sheet";

/** "How did today go?" with a big write button. Once today's report is in, it shows its summary. */
export function ReportCard({ today }: { today: string }) {
  const titleId = useId();
  const { report } = useLatestReport();
  const todays = report && report.day === today ? report : null;

  let meta: string | null = null;
  if (todays) meta = `REPORTED · ${timeLabel(todays.createdAt).toUpperCase()}`;
  else if (report) meta = `LAST REPORT · ${sinceLabel(report.day, today).toUpperCase()}`;

  const summary = todays ? todays.summary.trim() || todays.text.trim().split("\n")[0] : null;

  return (
    <section aria-labelledby={titleId} className="rounded-[16px] border border-line p-4 sm:p-5">
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-[17px] font-semibold tracking-tight text-fg">
            {todays ? "Today's report is in" : "How did today go?"}
          </h2>
          <p className="mt-1 line-clamp-2 text-[14px] leading-snug text-muted">
            {summary ?? "What you did, what got in the way, what's next."}
          </p>
        </div>
        <button
          type="button"
          onClick={() => openReport(null)}
          aria-label={todays ? "Write another report" : "Write a report"}
          className="grid size-14 shrink-0 place-items-center rounded-full bg-fg text-white shadow-[0_4px_14px_rgba(0,0,0,0.12)] transition-[transform,background-color] duration-150 hover:bg-black/80 active:scale-95"
        >
          <PenLine size={21} strokeWidth={1.75} />
        </button>
      </div>
      {meta && (
        <div className="-mb-2 mt-1 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => navigate({ name: "reports" })}
            className="-mr-2 min-h-11 rounded-full px-2 font-mono text-[10.5px] tracking-[0.14em] text-faint transition-colors hover:text-muted"
          >
            {meta}
          </button>
        </div>
      )}
    </section>
  );
}
