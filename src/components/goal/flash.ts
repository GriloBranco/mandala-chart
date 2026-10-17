"use client";

import { useEffect, useRef, type RefObject } from "react";
import type { Checkin, GoalWithCells } from "@/lib/types";
import { wasTouched } from "./edits";
import { squareSignature } from "./model";

const FLASH_MS = 1400;

/**
 * Briefly lights up squares (by cell id) inside a chart, like the shared `flash` animation.
 * Runs on the DOM so a flash can replay without re-rendering the chart. Squares sit in
 * wrappers marked `data-cell`.
 */
export function flashSquares(root: HTMLElement | null, ids: Iterable<string>) {
  if (!root || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const styles = getComputedStyle(document.documentElement);
  const soft = styles.getPropertyValue("--accent-soft").trim() || "#fff1ea";
  const accent = styles.getPropertyValue("--accent").trim() || "#ff4f00";
  const lit = { backgroundColor: soft, boxShadow: `0 0 0 2px ${accent}` };
  for (const id of ids) {
    for (const square of root.querySelectorAll<HTMLElement>(`[data-cell="${CSS.escape(id)}"] > button`)) {
      if (typeof square.animate !== "function") continue;
      // No end keyframe: it eases back to the square's own look.
      square.animate(
        [
          { ...lit, offset: 0 },
          { ...lit, offset: 0.3 },
        ],
        { duration: FLASH_MS, easing: "ease-out" },
      );
    }
  }
}

/**
 * Flashes squares whose text, status or glyph changed while the chart was open, unless this
 * screen made the change (or it is the square being edited). In practice: updates applied
 * from a report, or synced from another device.
 */
export function useChangeFlash(
  rootRef: RefObject<HTMLElement | null>,
  goal: GoalWithCells,
  checkins: Checkin[],
  glyphs: Map<string, string | undefined>,
  today: string,
  skipId: string | null,
) {
  const previous = useRef<{ today: string; signatures: Map<string, string> } | null>(null);

  useEffect(() => {
    // A habit checked off today counts as a change even when its strength glyph stays the same.
    const doneToday = new Set(checkins.filter((c) => c.day === today && c.goalId === goal.id).map((c) => c.cellId));
    const signatures = new Map<string, string>();
    for (const cell of goal.cells) {
      signatures.set(cell.id, squareSignature(cell, glyphs.get(cell.id), doneToday.has(cell.id)));
    }
    const before = previous.current;
    previous.current = { today, signatures };
    // A new day changes every habit glyph; that is not news.
    if (!before || before.today !== today) return;
    const changed: string[] = [];
    for (const [id, signature] of signatures) {
      const old = before.signatures.get(id);
      if (old !== undefined && old !== signature && id !== skipId && !wasTouched(id)) changed.push(id);
    }
    if (changed.length) flashSquares(rootRef.current, changed);
  }, [rootRef, goal, checkins, glyphs, today, skipId]);
}
