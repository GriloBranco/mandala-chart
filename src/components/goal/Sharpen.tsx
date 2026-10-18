"use client";

import { Sparkles, X } from "lucide-react";
import { useState } from "react";
import { ai } from "@/client/ai";
import { AsciiSpinner } from "@/components/ascii/AsciiSpinner";
import { Button, IconButton } from "@/components/ui/Button";
import { aiErrorMessage } from "./edits";

export type SharpenState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; issues: string[]; options: string[] }
  | { status: "error"; message: string };

const IDLE: SharpenState = { status: "idle" };

/**
 * AI rewrites of one line so it passes the method's tests. State belongs to one square:
 * moving to another square hides an older result, even one still loading.
 */
export function useSharpen(squareKey: string) {
  const [entry, setEntry] = useState<{ key: string; state: SharpenState }>({ key: squareKey, state: IDLE });
  const state = entry.key === squareKey ? entry.state : IDLE;

  async function run(input: { goalId: string; role: "goal" | "pillar" | "action"; text: string; pillar?: number }) {
    const key = squareKey;
    setEntry({ key, state: { status: "loading" } });
    try {
      const result = await ai.sharpen(input);
      setEntry({
        key,
        state: {
          status: "ready",
          issues: result.issues.filter((s) => s.trim()).slice(0, 3),
          options: result.options.filter((s) => s.trim()).slice(0, 3),
        },
      });
    } catch (error) {
      setEntry({ key, state: { status: "error", message: aiErrorMessage(error, "Could not sharpen this one.") } });
    }
  }

  return { state, run, reset: () => setEntry({ key: squareKey, state: IDLE }) };
}

export function SharpenButton({
  state,
  disabled,
  onRun,
}: {
  state: SharpenState;
  disabled?: boolean;
  onRun: () => void;
}) {
  if (state.status === "loading") {
    return (
      <span className="flex h-8 shrink-0 items-center gap-2 px-2 text-[13px] text-muted">
        <AsciiSpinner size="sm" label="Sharpening" />
        Sharpening
      </span>
    );
  }
  if (state.status === "ready") return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={<Sparkles size={14} />}
      disabled={disabled}
      onClick={onRun}
      className="-mr-2 text-muted hover:text-fg"
      // Keep the keyboard up on phones: tapping this should not blur the text field.
      onPointerDown={(event) => event.preventDefault()}
    >
      Sharpen
    </Button>
  );
}

export function SharpenPanel({
  state,
  onPick,
  onRetry,
  onClose,
}: {
  state: SharpenState;
  onPick: (option: string) => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  if (state.status === "error") {
    return (
      <p className="mt-2 text-[12.5px] leading-snug text-danger">
        {state.message}{" "}
        <button type="button" onClick={onRetry} className="font-medium underline underline-offset-2">
          Try again
        </button>
      </p>
    );
  }
  if (state.status !== "ready") return null;
  return (
    <div className="mt-3 animate-rise rounded-2xl border border-line bg-softer p-3">
      <div className="flex items-center justify-between gap-2 pl-1">
        <span className="font-mono text-[10.5px] tracking-[0.14em] text-faint">SHARPER</span>
        <IconButton label="Close suggestions" size="sm" onClick={onClose} className="-my-1 text-muted">
          <X size={15} />
        </IconButton>
      </div>
      {state.issues.length > 0 && (
        <ul className="mt-1 space-y-0.5 pl-1">
          {state.issues.map((issue) => (
            <li key={issue} className="text-[12.5px] leading-snug text-muted">
              {issue}
            </li>
          ))}
        </ul>
      )}
      {state.options.length ? (
        <div className="mt-2.5 space-y-1.5">
          {state.options.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onPick(option)}
              className="block w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-left text-[14px] leading-snug transition-colors hover:border-fg"
            >
              {option}
            </button>
          ))}
          <p className="pl-1 text-[11.5px] text-faint">Tap one to use it.</p>
        </div>
      ) : (
        <p className="mt-1 pl-1 text-[13px] text-muted">Looks clear as it is.</p>
      )}
    </div>
  );
}
