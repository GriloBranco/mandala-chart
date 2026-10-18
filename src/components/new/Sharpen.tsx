"use client";

import { Sparkles, X } from "lucide-react";
import { useState } from "react";
import { Button, IconButton } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { ai } from "@/client/ai";
import { ApiError } from "@/client/api";
import { LABEL, keepFocus } from "./StepParts";

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; issues: string[]; options: string[] }
  | { status: "error"; message: string };

/**
 * "Sharpen": asks for three rewrites that pass the method's tests (a date and a number for
 * the goal; tick-off-able and in your control for an action). Tap one to use it.
 * Only render it when AI is on.
 */
export function Sharpen({
  role,
  text,
  goalId,
  pillar,
  deadline,
  onPick,
  keepKeyboard = false,
  className,
}: {
  role: "goal" | "pillar" | "action";
  text: string;
  goalId?: string;
  pillar?: number;
  /** The date picked on this screen, so a rewritten goal uses it. */
  deadline?: string | null;
  onPick: (text: string) => void;
  /** Taps here keep the input focused (the phone keyboard stays up). */
  keepKeyboard?: boolean;
  className?: string;
}) {
  const [state, setState] = useState<State>({ status: "idle" });
  const hold = keepKeyboard ? keepFocus : undefined;

  const run = async () => {
    setState({ status: "loading" });
    try {
      const result = await ai.sharpen({ goalId, role, text: text.trim(), pillar, deadline });
      const options = (result.options ?? []).map((o) => o.trim()).filter(Boolean);
      setState({ status: "ready", issues: result.issues ?? [], options });
    } catch (error) {
      const message =
        error instanceof ApiError && error.offline
          ? "You're offline."
          : error instanceof Error
            ? error.message
            : "Could not sharpen it.";
      setState({ status: "error", message });
    }
  };

  if (state.status === "ready") {
    return (
      <div className={cn("animate-rise rounded-2xl border border-line p-3", className)}>
        <div className="flex items-center gap-2 pl-1">
          <span className={cn(LABEL, "flex-1")}>SHARPER</span>
          <IconButton
            label="Close suggestions"
            size="sm"
            className="text-muted"
            onPointerDown={hold}
            onClick={() => setState({ status: "idle" })}
          >
            <X size={15} />
          </IconButton>
        </div>
        {state.issues.length > 0 && (
          <ul className="mt-0.5 space-y-0.5 pl-1">
            {state.issues.map((issue) => (
              <li key={issue} className="text-[13px] leading-snug text-muted">
                {issue}
              </li>
            ))}
          </ul>
        )}
        {state.options.length === 0 ? (
          <p className="mt-2 pl-1 text-[13px] text-muted">It already reads well.</p>
        ) : (
          <div className="mt-2 space-y-1.5">
            {state.options.map((option) => (
              <button
                key={option}
                type="button"
                onPointerDown={hold}
                onClick={() => {
                  onPick(option);
                  setState({ status: "idle" });
                }}
                className="block w-full rounded-xl border border-line-strong px-3.5 py-2.5 text-left text-[15px] leading-snug transition-colors hover:border-fg active:bg-soft"
              >
                {option}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={cn("flex min-w-0 items-center gap-3", className)}>
      <Button
        variant="secondary"
        size="sm"
        icon={<Sparkles size={14} />}
        loading={state.status === "loading"}
        disabled={!text.trim()}
        onPointerDown={hold}
        onClick={() => void run()}
      >
        Sharpen
      </Button>
      {state.status === "error" && <p className="min-w-0 truncate text-[13px] text-danger">{state.message}</p>}
    </div>
  );
}
