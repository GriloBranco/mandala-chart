import { cn } from "./cn";

/** Thin progress line. value is 0-1. */
export function ProgressBar({
  value,
  tone = "fg",
  className,
}: {
  value: number;
  tone?: "fg" | "accent" | "muted";
  className?: string;
}) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className={cn("h-[3px] w-full overflow-hidden rounded-full bg-line", className)}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-500 ease-out",
          tone === "fg" && "bg-fg",
          tone === "accent" && "bg-accent",
          tone === "muted" && "bg-faint",
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
