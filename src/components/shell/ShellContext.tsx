"use client";

import { createContext, useContext } from "react";

export interface Shell {
  /** Opens the goals drawer on phones (the sidebar is always visible on desktop). */
  openDrawer: () => void;
  isDesktop: boolean;
}

export const ShellContext = createContext<Shell>({ openDrawer: () => {}, isDesktop: false });

export function useShell(): Shell {
  return useContext(ShellContext);
}
