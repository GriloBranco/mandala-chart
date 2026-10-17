"use client";

import { useRef } from "react";

/** Drops a click that arrives right after the finger lifts, wherever it lands. */
function swallowNextClick() {
  const stop = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 400);
}

/**
 * Long-press without breaking normal taps or scrolling. Returns handlers to spread on the
 * element and `consumeClick()`: call it first in onClick, and skip the click when it
 * returns true (the press already ran the long-press action).
 */
export function useLongPress(onLongPress: (() => void) | undefined, delay = 450) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };

  return {
    handlers: onLongPress
      ? {
          onPointerDown: (event: React.PointerEvent) => {
            if (event.button !== 0) return;
            fired.current = false;
            start.current = { x: event.clientX, y: event.clientY };
            timer.current = setTimeout(() => {
              fired.current = true;
              timer.current = null;
              onLongPress();
            }, delay);
          },
          onPointerMove: (event: React.PointerEvent) => {
            if (!start.current) return;
            if (Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y) > 8) cancel();
          },
          onPointerUp: cancel,
          onPointerCancel: cancel,
          onPointerLeave: cancel,
          // After a long press, the click sent on release would land on whatever opened under the
          // finger (a menu row, a chip, the backdrop). touchend still targets this element, and
          // cancelling it stops that click; the catch-all is extra safety for WebKit.
          onTouchEnd: (event: React.TouchEvent) => {
            if (!fired.current) return;
            if (event.cancelable) event.preventDefault();
            swallowNextClick();
          },
          onContextMenu: (event: React.MouseEvent) => event.preventDefault(),
        }
      : {},
    consumeClick: () => {
      const was = fired.current;
      fired.current = false;
      return was;
    },
  };
}
