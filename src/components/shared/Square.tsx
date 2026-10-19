"use client";

import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { useLongPress } from "@/components/ui/useLongPress";

export type SquareRole = "goal" | "pillar" | "action";
export type SquareSize = "map" | "grid" | "focus";

/**
 * One square of the chart. Every chart in the app (desktop 9x9, phone 3x3, the new-goal
 * steps, the glyph map) draws its squares with this, so they all look the same.
 */
export function Square({
  role,
  text,
  placeholder,
  size = "focus",
  glyph,
  marker,
  selected = false,
  lever = false,
  muted = false,
  flash = false,
  dim = false,
  label,
  onClick,
  onLongPress,
  children,
  className,
}: {
  role: SquareRole;
  text: string;
  /** Shown faintly when the square is empty. */
  placeholder?: string;
  size?: SquareSize;
  /** Status glyph in the corner: ○ idea, ◉ this week, ◐ doing, ● done, or a habit ramp. */
  glyph?: string;
  /** Small accent dot in the top-left: picked for this week. */
  marker?: boolean;
  selected?: boolean;
  /** Accent outline: the highest-leverage pillar. */
  lever?: boolean;
  /** Done: quieter text. */
  muted?: boolean;
  /** Brief highlight after an update (e.g. synced from another device). */
  flash?: boolean;
  /** Not the current focus (e.g. while a different block is being edited). */
  dim?: boolean;
  label?: string;
  onClick?: () => void;
  onLongPress?: () => void;
  children?: ReactNode;
  className?: string;
}) {
  const { handlers, consumeClick } = useLongPress(onLongPress);
  const empty = !text.trim();
  const isMap = size === "map";

  return (
    <button
      type="button"
      aria-label={label ?? (empty ? `Empty ${role}` : text)}
      aria-pressed={selected || undefined}
      onClick={() => {
        if (consumeClick()) return;
        onClick?.();
      }}
      {...handlers}
      className={cn(
        "no-callout relative flex aspect-square w-full min-w-0 flex-col overflow-hidden text-left transition-[background-color,box-shadow,opacity,transform] duration-150 active:scale-[0.97]",
        isMap ? "items-center justify-center rounded-[5px]" : "rounded-[10px]",
        size === "grid" && "p-2 text-[12px] leading-[1.25]",
        size === "focus" && "p-2.5 text-[14.5px] leading-[1.28] sm:p-3 sm:text-[15px]",
        role === "goal" && "bg-fg text-white",
        role === "pillar" && (empty ? "border border-dashed border-line-strong bg-softer" : "bg-soft font-semibold"),
        role === "action" && (empty ? "border border-dashed border-line bg-bg" : "border border-line bg-bg hover:border-line-strong"),
        role === "goal" && !isMap && "font-semibold",
        role === "goal" && size === "focus" && "text-[15.5px] sm:text-[16.5px]",
        lever && !selected && "shadow-[0_0_0_1.5px_var(--accent)]",
        selected && (role === "goal" ? "shadow-[0_0_0_2px_var(--bg),0_0_0_4px_var(--fg)]" : "shadow-[0_0_0_2px_var(--fg)]"),
        flash && "animate-flash",
        dim && "opacity-40",
        className,
      )}
    >
      {isMap ? (
        <span className={cn("font-mono text-[12px] leading-none", role === "goal" ? "text-white" : empty ? "text-line-strong" : "text-fg")}>
          {role === "goal" ? "◎" : glyph ?? (empty ? "·" : "○")}
        </span>
      ) : (
        <>
          {marker && <span className="absolute top-1.5 left-1.5 size-1.5 rounded-full bg-accent" aria-hidden />}
          {glyph && (
            <span
              className={cn(
                "absolute top-1 right-1.5 font-mono text-[10.5px] leading-none",
                role === "goal" ? "text-white/60" : "text-faint",
              )}
              aria-hidden
            >
              {glyph}
            </span>
          )}
          <span
            className={cn(
              "flex min-h-0 flex-1 overflow-hidden break-words",
              empty
                ? "items-center justify-center text-center font-normal text-faint"
                : role === "action"
                  ? "items-start pt-1.5"
                  : "items-center justify-center text-center",
              size === "grid" ? "line-clamp-4" : "line-clamp-5",
              muted && "text-faint",
            )}
          >
            {empty ? (placeholder ?? (role === "action" ? "+" : "")) : text}
          </span>
          {children}
        </>
      )}
    </button>
  );
}

/** Lays out 9 squares (row-major) as a 3x3 block. Pass null to leave a gap. */
export function Block3x3({
  children,
  gap = "focus",
  className,
}: {
  children: ReactNode[];
  gap?: SquareSize;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-3",
        gap === "map" && "gap-[3px]",
        gap === "grid" && "gap-1",
        gap === "focus" && "gap-2",
        className,
      )}
    >
      {children}
    </div>
  );
}
