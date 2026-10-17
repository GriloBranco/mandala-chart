"use client";

import { useSyncExternalStore } from "react";

export interface Toast {
  id: number;
  message: string;
  action?: { label: string; run: () => void };
  tone?: "default" | "error";
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** Shows a short message at the bottom. Pass an action for "Undo". */
export function toast(
  message: string,
  options: { action?: Toast["action"]; tone?: Toast["tone"]; duration?: number } = {},
): number {
  const id = nextId++;
  toasts = [...toasts.slice(-2), { id, message, action: options.action, tone: options.tone }];
  emit();
  setTimeout(() => dismissToast(id), options.duration ?? (options.action ? 5000 : 2600));
  return id;
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

const EMPTY: Toast[] = [];

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => toasts,
    () => EMPTY,
  );
}
