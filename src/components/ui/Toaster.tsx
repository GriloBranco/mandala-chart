"use client";

import { dismissToast, useToasts } from "@/lib/toast";
import { cn } from "./cn";
import { useKeyboardInset } from "./hooks";

export function Toaster() {
  const toasts = useToasts();
  const inset = useKeyboardInset();
  return (
    <div
      aria-live="polite"
      style={inset > 0 ? { bottom: inset + 12 } : undefined}
      className="pointer-events-none fixed inset-x-0 z-[60] flex flex-col items-center gap-2 px-4 bottom-[calc(84px+var(--safe-bottom))] lg:bottom-6"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "pointer-events-auto flex max-w-md animate-rise items-center gap-3 rounded-full py-2 pr-2 pl-4 text-sm shadow-[0_8px_24px_rgba(0,0,0,0.16)]",
            t.tone === "error" ? "bg-danger text-white" : "bg-fg text-white",
          )}
        >
          <span className="min-w-0 truncate">{t.message}</span>
          {t.action ? (
            <button
              type="button"
              className="rounded-full px-3 py-1 font-medium text-white/90 underline-offset-2 hover:bg-white/10"
              onClick={() => {
                t.action?.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          ) : (
            <span className="w-2" />
          )}
        </div>
      ))}
    </div>
  );
}
