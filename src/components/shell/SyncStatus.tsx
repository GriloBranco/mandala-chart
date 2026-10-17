"use client";

import { useAppState } from "@/lib/store";
import { cn } from "@/components/ui/cn";

/** Quiet sync line: "Saved", "Saving…", or "Offline · 3 unsaved". */
export function SyncStatus({ className }: { className?: string }) {
  const { unsynced, offline } = useAppState();
  const label = offline ? `Offline${unsynced ? ` · ${unsynced} unsaved` : ""}` : unsynced ? "Saving…" : "Saved";
  return (
    <span className={cn("flex items-center gap-1.5 font-mono text-[10.5px] text-faint", className)} aria-live="polite">
      <span
        className={cn(
          "size-1.5 rounded-full",
          offline ? "bg-accent" : unsynced ? "animate-pulse bg-faint" : "bg-line-strong",
        )}
        aria-hidden
      />
      {label}
    </span>
  );
}
