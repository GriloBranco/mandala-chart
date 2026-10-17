"use client";

// Opens the report recorder from anywhere (Today, a goal header, the sidebar, the R key).

import { useSyncExternalStore } from "react";

export interface RecorderRequest {
  open: boolean;
  /** null = a general report, mapped across all active goals. */
  goalId: string | null;
  /** Start in text mode instead of recording. */
  typed: boolean;
}

const CLOSED: RecorderRequest = { open: false, goalId: null, typed: false };
let current: RecorderRequest = CLOSED;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function openRecorder(goalId: string | null, options: { typed?: boolean } = {}) {
  current = { open: true, goalId, typed: Boolean(options.typed) };
  emit();
}

export function closeRecorder() {
  current = { ...current, open: false };
  emit();
}

export function useRecorderRequest(): RecorderRequest {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => CLOSED,
  );
}
