"use client";

// Report data shared by the Today card, the Reports list and the report sheet.
// Lists are cached in memory, so going back to Reports paints at once and refreshes quietly.

import { useSyncExternalStore } from "react";
import { api } from "@/client/api";
import type { Report } from "@/domain/types";

/** Fired on window after a report is saved. Lists and the Today card refetch on it. */
export const REPORT_SAVED_EVENT = "mandala:report-saved";

// ---------- latest report (the Today card) ----------

export interface LatestReport {
  report: Report | null;
  /** False until the server has answered once. */
  loaded: boolean;
}

const UNKNOWN: LatestReport = { report: null, loaded: false };
let latest: LatestReport = UNKNOWN;
let latestRun = 0;
const latestListeners = new Set<() => void>();

function setLatest(next: LatestReport) {
  latest = next;
  for (const listener of latestListeners) listener();
}

function loadLatest() {
  const run = ++latestRun;
  api
    .get<Report[]>("/api/reports?limit=1")
    .then((list) => {
      // A newer load or a save happened meanwhile: its answer wins.
      if (run === latestRun) setLatest({ report: list[0] ?? null, loaded: true });
    })
    .catch(() => undefined); // offline: keep what we had
}

function onVisible() {
  if (document.visibilityState === "visible") loadLatest();
}

function subscribeLatest(listener: () => void) {
  latestListeners.add(listener);
  if (latestListeners.size === 1) {
    loadLatest();
    window.addEventListener(REPORT_SAVED_EVENT, loadLatest);
    document.addEventListener("visibilitychange", onVisible);
  }
  return () => {
    latestListeners.delete(listener);
    if (latestListeners.size === 0) {
      window.removeEventListener(REPORT_SAVED_EVENT, loadLatest);
      document.removeEventListener("visibilitychange", onVisible);
    }
  };
}

/** The most recent report, fetched when first used and after every save. */
export function useLatestReport(): LatestReport {
  return useSyncExternalStore(subscribeLatest, () => latest, () => UNKNOWN);
}

/** Call after saving: updates the Today card at once and tells lists to refetch. */
export function announceReportSaved(report: Report) {
  latestRun++;
  setLatest({ report, loaded: true });
  window.dispatchEvent(new Event(REPORT_SAVED_EVENT));
}

// ---------- report lists ----------

const lists = new Map<string, Report[]>();

export function cachedReports(goalId: string | undefined): Report[] | null {
  return lists.get(goalId ?? "") ?? null;
}

export async function fetchReports(goalId: string | undefined): Promise<Report[]> {
  const query = goalId ? `limit=100&goalId=${encodeURIComponent(goalId)}` : "limit=100";
  const reports = await api.get<Report[]>(`/api/reports?${query}`);
  lists.set(goalId ?? "", reports);
  return reports;
}

/** Deletes the report. */
export async function deleteReport(id: string): Promise<void> {
  await api.delete(`/api/reports/${encodeURIComponent(id)}`);
  for (const [key, list] of lists) lists.set(key, list.filter((report) => report.id !== id));
  if (latest.report?.id === id) loadLatest();
}
