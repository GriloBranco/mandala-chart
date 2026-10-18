"use client";

// One AI leverage analysis per goal, kept outside React so the new goal flow can start it
// once and the result survives moving between steps.

import { useSyncExternalStore } from "react";
import { ai } from "@/client/ai";
import { ApiError } from "@/client/api";
import type { LeverageAnalysis } from "@/domain/types";

export interface LeverageRun {
  status: "loading" | "ready" | "error";
  data: LeverageAnalysis | null;
  error: string | null;
  /** The chart's words when the run started (see leverSig). */
  sig: string;
  id: number;
}

const runs = new Map<string, LeverageRun>();
const listeners = new Set<() => void>();
let nextId = 1;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function message(error: unknown): string {
  if (error instanceof ApiError && error.offline) return "You're offline. Try again when you're back.";
  return error instanceof Error && error.message ? error.message : "Could not rank the actions.";
}

export function getLeverageRun(goalId: string): LeverageRun | null {
  return runs.get(goalId) ?? null;
}

export function startLeverage(goalId: string, sig: string): void {
  const id = nextId++;
  runs.set(goalId, { status: "loading", data: null, error: null, sig, id });
  emit();
  ai.leverage({ goalId }).then(
    (data) => {
      if (runs.get(goalId)?.id !== id) return;
      runs.set(goalId, { status: "ready", data, error: null, sig, id });
      emit();
    },
    (error: unknown) => {
      if (runs.get(goalId)?.id !== id) return;
      runs.set(goalId, { status: "error", data: null, error: message(error), sig, id });
      emit();
    },
  );
}

export function useLeverageRun(goalId: string): LeverageRun | null {
  return useSyncExternalStore(
    subscribe,
    () => runs.get(goalId) ?? null,
    () => null,
  );
}
