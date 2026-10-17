import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

/** A labeled group in the editor: small mono label above its control. */
export function Field({
  label,
  aside,
  children,
  className,
}: {
  label: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-2", className)}>
      <div className="flex items-baseline gap-2">
        <h3 className="font-mono text-[10.5px] tracking-[0.14em] text-faint">{label}</h3>
        {aside && <span className="text-[11px] text-faint">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

/** A small label on the left, the control on the right (Impact, Effort). */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[13px] text-muted">{label}</span>
      {children}
    </div>
  );
}

/** The visual part of an on/off switch. The button around it carries role="switch". */
export function SwitchKnob({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors duration-150",
        on ? "bg-accent" : "bg-line-strong",
      )}
    >
      <span
        className={cn(
          "absolute left-0.5 size-5 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-transform duration-150",
          on && "translate-x-4",
        )}
      />
    </span>
  );
}

const LEGEND: [string, string][] = [
  ["○", "idea"],
  ["◉", "this week"],
  ["◐", "doing"],
  ["●", "done"],
  ["▓", "habit"],
];

/** What the corner glyphs mean. */
export function GlyphLegend({ className }: { className?: string }) {
  return (
    <p className={cn("flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-muted", className)}>
      {LEGEND.map(([glyph, word]) => (
        <span key={word} className="whitespace-nowrap">
          <span className="text-fg">{glyph}</span> {word}
        </span>
      ))}
    </p>
  );
}
