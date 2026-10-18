"use client";

import { useSyncExternalStore } from "react";
import { dayKey } from "@/domain/mandala";

// The installed app can stay open for days. Re-read the date at midnight and whenever the
// app comes back to the front, so "today" never shows yesterday's check-ins.
function subscribe(listener: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    timer = setTimeout(() => {
      listener();
      schedule();
    }, midnight.getTime() - now.getTime());
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") listener();
  };
  schedule();
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", listener);
  return () => {
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", listener);
  };
}

/** Local calendar day (YYYY-MM-DD) that updates itself at midnight. */
export function useToday(): string {
  return useSyncExternalStore(subscribe, () => dayKey(), () => "");
}
