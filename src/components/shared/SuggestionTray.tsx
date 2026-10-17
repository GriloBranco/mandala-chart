"use client";

import { Plus, RefreshCw, Sparkles } from "lucide-react";
import { useState } from "react";
import { ai } from "@/lib/ai-client";
import { useAppState } from "@/lib/store";
import type { Suggestion } from "@/lib/types";
import { AsciiSpinner } from "@/components/ascii/AsciiSpinner";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";

/**
 * "Suggest with AI": fetches candidate pillars or actions and shows them as chips.
 * Nothing goes into the chart until the user taps a chip (the AI proposes, you decide).
 */
export function SuggestionTray({
  goalId,
  target,
  pillar,
  existing,
  onPick,
  onPickAll,
  className,
}: {
  goalId: string;
  target: "pillars" | "actions";
  pillar?: number;
  /** Texts already in the chart, hidden from the suggestions. */
  existing: string[];
  onPick: (suggestion: Suggestion) => void;
  /** Optional "Add all" (fills the empty squares in order). */
  onPickAll?: (suggestions: Suggestion[]) => void;
  className?: string;
}) {
  const { aiEnabled } = useAppState();
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [items, setItems] = useState<Suggestion[]>([]);
  const [error, setError] = useState<string | null>(null);

  if (!aiEnabled) return null;

  const taken = new Set(existing.map((t) => t.trim().toLowerCase()).filter(Boolean));
  const visible = items.filter((s) => !taken.has(s.text.trim().toLowerCase()));

  async function load() {
    setStatus("loading");
    setError(null);
    try {
      const hint = items.length ? `Different from: ${items.map((s) => s.text).join("; ")}` : undefined;
      const { suggestions } = await ai.suggest({ goalId, target, pillar, hint });
      setItems(suggestions);
      setStatus("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not get suggestions");
      setStatus("error");
    }
  }

  if (status === "idle") {
    return (
      <Button variant="secondary" size="sm" icon={<Sparkles size={14} />} onClick={load} className={className}>
        Suggest with AI
      </Button>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10.5px] tracking-[0.14em] text-faint">SUGGESTIONS</span>
        {status === "loading" && <AsciiSpinner size="sm" label="Thinking" />}
        <span className="flex-1" />
        {status === "ready" && onPickAll && visible.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => onPickAll(visible)}>
            Add all
          </Button>
        )}
        {status !== "loading" && (
          <Button variant="ghost" size="sm" icon={<RefreshCw size={13} />} onClick={load}>
            More
          </Button>
        )}
      </div>
      {status === "error" && <p className="text-sm text-danger">{error}</p>}
      {status === "ready" && visible.length === 0 && <p className="text-sm text-muted">All used. Tap More for new ones.</p>}
      <div className="flex flex-wrap gap-1.5">
        {visible.map((s) => (
          <button
            key={s.text}
            type="button"
            onClick={() => onPick(s)}
            title={s.note}
            className="group flex max-w-full animate-fade-in items-center gap-1.5 rounded-full border border-dashed border-line-strong px-3 py-1.5 text-left text-[13px] text-fg transition-colors hover:border-fg hover:bg-softer"
          >
            <Plus size={13} className="shrink-0 text-faint group-hover:text-fg" />
            <span className="min-w-0 truncate">{s.text}</span>
            {s.kind === "habit" && <span className="shrink-0 font-mono text-[10px] text-faint">habit</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
