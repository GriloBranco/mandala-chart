"use client";

// Opens the report sheet from anywhere (Today, a goal header, the sidebar, the R key).

import { useSyncExternalStore } from "react";

export interface ReportRequest {
  open: boolean;
  /** null = a general report, not tied to one goal. */
  goalId: string | null;
}

const CLOSED: ReportRequest = { open: false, goalId: null };
let current: ReportRequest = CLOSED;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function openReport(goalId: string | null) {
  current = { open: true, goalId };
  emit();
}

export function closeReport() {
  current = { ...current, open: false };
  emit();
}

export function useReportRequest(): ReportRequest {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => CLOSED,
  );
}
