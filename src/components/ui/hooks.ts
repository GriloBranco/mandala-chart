"use client";

import { useSyncExternalStore } from "react";

/** Live CSS media query match. False during server rendering. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", listener);
      return () => list.removeEventListener("change", listener);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Desktop layout: full 9x9 chart, sidebar and inspector. */
export function useIsDesktop(): boolean {
  return useMediaQuery("(min-width: 1024px)");
}

export function useReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}

function subscribeViewport(listener: () => void) {
  const viewport = window.visualViewport;
  viewport?.addEventListener("resize", listener);
  viewport?.addEventListener("scroll", listener);
  return () => {
    viewport?.removeEventListener("resize", listener);
    viewport?.removeEventListener("scroll", listener);
  };
}

function keyboardInset(): number {
  const viewport = window.visualViewport;
  if (!viewport) return 0;
  return Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
}

/** Height the on-screen keyboard covers (iOS), so bottom sheets can sit above it. */
export function useKeyboardInset(): number {
  return useSyncExternalStore(subscribeViewport, keyboardInset, () => 0);
}

function visibleHeight(): number {
  return Math.round(window.visualViewport?.height ?? window.innerHeight);
}

/** Height of the visible area (shrinks when the iOS keyboard is up). */
export function useVisualViewportHeight(): number {
  return useSyncExternalStore(subscribeViewport, visibleHeight, () => 0);
}
