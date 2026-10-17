"use client";

// The visible part of the screen. On a phone the keyboard shrinks the visual viewport but
// not the page, so the flow sizes itself to what is visible and keeps the input in view.

import { useSyncExternalStore } from "react";

function subscribe(listener: () => void) {
  const viewport = window.visualViewport;
  viewport?.addEventListener("resize", listener);
  viewport?.addEventListener("scroll", listener);
  window.addEventListener("resize", listener);
  return () => {
    viewport?.removeEventListener("resize", listener);
    viewport?.removeEventListener("scroll", listener);
    window.removeEventListener("resize", listener);
  };
}

const coarse = () => window.matchMedia("(pointer: coarse)").matches;
const height = () => Math.round(window.visualViewport?.height ?? window.innerHeight);
const top = () => Math.round(window.visualViewport?.offsetTop ?? 0);
const keyboard = () => {
  const viewport = window.visualViewport;
  if (!viewport || !coarse() || viewport.scale > 1.01) return false;
  return window.innerHeight - viewport.height > 120;
};

export interface Viewport {
  /** Touch screen: size to the visual viewport. */
  coarse: boolean;
  height: number;
  top: number;
  /** The on-screen keyboard is up. */
  keyboard: boolean;
}

export function useViewport(): Viewport {
  return {
    coarse: useSyncExternalStore(subscribe, coarse, () => false),
    height: useSyncExternalStore(subscribe, height, () => 0),
    top: useSyncExternalStore(subscribe, top, () => 0),
    keyboard: useSyncExternalStore(subscribe, keyboard, () => false),
  };
}
