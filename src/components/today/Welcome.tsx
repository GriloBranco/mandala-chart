"use client";

import { useImportBackup } from "@/components/account/useImportBackup";
import { AsciiMandala } from "@/components/ascii/AsciiMandala";
import { Headline } from "@/components/shell/Headline";
import { Button } from "@/components/ui/Button";
import { navigate } from "@/client/nav";

/** First run: no goals yet. */
export function Welcome({ voice }: { voice: boolean }) {
  const backup = useImportBackup();
  const lines: [string, string][] = [
    ["1", "goal in the middle, with a date"],
    ["8", "pillars around it that make it happen"],
    [
      "64",
      voice
        ? "small actions. Pick 5-8 a week and report daily by voice."
        : "small actions. Pick 5-8 a week and check them off daily.",
    ],
  ];
  return (
    <div className="mx-auto flex min-h-[calc(100dvh-76px-var(--safe-bottom))] w-full max-w-md flex-col items-center justify-center px-6 pt-[calc(var(--safe-top)+32px)] pb-10 lg:min-h-dvh">
      {/* Also capped by height, so the whole welcome fits on a small phone without scrolling. */}
      <AsciiMandala intro className="w-[min(340px,80vw,42dvh)]" />
      {/* The left padding balances the tracking after the last letter, so the word sits centered. */}
      <p className="mt-7 pl-[0.42em] font-mono text-[13px] font-medium tracking-[0.42em] text-fg">MANDALA</p>
      <Headline className="mt-5 max-w-[340px] text-center text-[20px] leading-[1.2]" />
      <ol className="mt-8 w-full max-w-[320px] space-y-3.5">
        {lines.map(([number, text]) => (
          <li key={number} className="flex items-baseline gap-4">
            <span className="w-7 shrink-0 text-right font-mono text-[13px] text-faint">{number}</span>
            <span className="text-[15px] leading-snug text-fg">{text}</span>
          </li>
        ))}
      </ol>
      <Button variant="primary" size="lg" className="mt-10 w-full max-w-[320px]" onClick={() => navigate({ name: "new" })}>
        Start your first goal
      </Button>
      {backup.input}
      <button
        type="button"
        className="mt-4 rounded-full px-3 py-1.5 text-[13px] text-muted hover:bg-soft hover:text-fg disabled:opacity-50"
        disabled={backup.busy}
        onClick={backup.pick}
      >
        {backup.busy ? "Importing…" : "Have a backup? Import it"}
      </button>
    </div>
  );
}
