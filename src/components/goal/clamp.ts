"use client";

import { useEffect, type RefObject } from "react";
import type { SquareRole } from "@/components/shared/Square";

// Square's text box is a flex item that stretches and is itself a flex container, which switches
// off its own line clamp: long words spill past the edge, and long text is cut mid-line (top and
// bottom when centered). These classes make that box a clamped block sized to its lines, as many
// as the square can show; the square then centers it for the goal and pillars.
const BOX =
  "[&>span.flex-1]:flex-none [&>span.flex-1]:[display:-webkit-box] [&>span.flex-1]:[-webkit-box-orient:vertical] [&>span.flex-1]:text-[length:var(--square-font,1em)]";
const ACTION = `${BOX} [&>span.flex-1]:[-webkit-line-clamp:var(--action-lines,3)]`;
// Centered labels get a little more width, and a word that still does not fit is hyphenated
// rather than broken at a random letter.
const CENTER = `${BOX} justify-center [&>span.flex-1]:-mx-1 [&>span.flex-1]:hyphens-auto [&>span.flex-1]:[-webkit-line-clamp:var(--center-lines,4)]`;
// An empty action's "+" gets both Square's top alignment and its centering; center it.
const EMPTY_ACTION = "[&>span.flex-1]:items-center [&>span.flex-1]:pt-0";

/** Classes for a square's text: a clamp sized to the square, or a centered "+" when empty. */
export function clampClass(role: SquareRole, text: string): string | undefined {
  if (!text.trim()) return role === "action" ? EMPTY_ACTION : undefined;
  return role === "action" ? ACTION : CENTER;
}

/** Action text sits 6px lower than centered text in Square (its pt-1.5). */
const ACTION_TOP = 6;

/** Smaller squares (a smaller window) get slightly smaller text, so short labels still fit. */
function fontFor(width: number): number | null {
  if (width >= 74) return null;
  return width >= 64 ? 11 : 10.5;
}

/**
 * Measures the first square inside `ref` and sets, on `ref`: --center-lines and --action-lines
 * (how many whole lines fit) and, with `scaleFont`, --square-font. Runs again on resize.
 */
export function useSquareLines(ref: RefObject<HTMLElement | null>, options: { scaleFont?: boolean } = {}) {
  const { scaleFont = false } = options;
  useEffect(() => {
    const root = ref.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const square = root.querySelector<HTMLElement>("button");
      const text = square?.querySelector<HTMLElement>(":scope > span.flex-1");
      if (!square || !text) return;
      const box = getComputedStyle(square);
      const style = getComputedStyle(text);
      const ratio = parseFloat(style.lineHeight) / parseFloat(style.fontSize);
      const font = scaleFont ? fontFor(square.clientWidth) : null;
      if (scaleFont) {
        if (font) root.style.setProperty("--square-font", `${font}px`);
        else root.style.removeProperty("--square-font");
      }
      const line = ratio * (font ?? parseFloat(box.fontSize));
      if (!line) return;
      const inner = square.clientHeight - parseFloat(box.paddingTop) - parseFloat(box.paddingBottom);
      root.style.setProperty("--center-lines", String(Math.max(1, Math.floor(inner / line))));
      root.style.setProperty("--action-lines", String(Math.max(1, Math.floor((inner - ACTION_TOP) / line))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [ref, scaleFont]);
}
