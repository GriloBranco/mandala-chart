"use client";

// Tiny client router: the whole app is one page, and the view lives in the query string,
// so back/forward and deep links work and switching views never waits on the server.

import { useSyncExternalStore } from "react";

export type View =
  | { name: "today" }
  | { name: "reports"; goalId?: string }
  | { name: "goal"; goalId: string; pillar: number | null; map: boolean }
  | { name: "lever"; goalId: string }
  | { name: "new"; goalId?: string; step?: number };

const NAV_EVENT = "mandala:navigate";

export function viewToUrl(view: View): string {
  const params = new URLSearchParams();
  switch (view.name) {
    case "today":
      break;
    case "reports":
      params.set("v", "reports");
      if (view.goalId) params.set("g", view.goalId);
      break;
    case "goal":
      params.set("g", view.goalId);
      if (view.pillar !== null) params.set("p", String(view.pillar));
      if (view.map) params.set("map", "1");
      break;
    case "lever":
      params.set("v", "lever");
      params.set("g", view.goalId);
      break;
    case "new":
      params.set("v", "new");
      if (view.goalId) params.set("g", view.goalId);
      if (view.step) params.set("step", String(view.step));
      break;
  }
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

export function urlToView(search: string): View {
  const params = new URLSearchParams(search);
  const v = params.get("v");
  const g = params.get("g") ?? undefined;
  if (v === "reports") return { name: "reports", goalId: g };
  if (v === "new") {
    const step = Number(params.get("step"));
    return { name: "new", goalId: g, step: Number.isInteger(step) && step > 0 ? step : undefined };
  }
  if (v === "lever" && g) return { name: "lever", goalId: g };
  if (g) {
    const p = params.get("p");
    const pillar = p !== null && /^[0-7]$/.test(p) ? Number(p) : null;
    return { name: "goal", goalId: g, pillar, map: params.get("map") === "1" };
  }
  return { name: "today" };
}

let cachedSearch: string | null = null;
let cachedView: View = { name: "today" };

function snapshot(): View {
  const search = window.location.search;
  if (search !== cachedSearch) {
    cachedSearch = search;
    cachedView = urlToView(search);
  }
  return cachedView;
}

const SERVER_VIEW: View = { name: "today" };

function subscribe(listener: () => void) {
  window.addEventListener("popstate", listener);
  window.addEventListener(NAV_EVENT, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(NAV_EVENT, listener);
  };
}

export function useView(): View {
  return useSyncExternalStore(subscribe, snapshot, () => SERVER_VIEW);
}

/** The goal a report recorded from this view belongs to, or null for a general report. */
export function viewGoalId(view: View): string | null {
  if (view.name === "goal" || view.name === "lever" || view.name === "reports") return view.goalId ?? null;
  return null;
}

/** How many entries we pushed, so Back can stay inside the app. */
let depth = 0;

export function navigate(view: View, options: { replace?: boolean } = {}) {
  const url = viewToUrl(view);
  if (url === window.location.pathname + window.location.search) return;
  if (options.replace) {
    window.history.replaceState(window.history.state, "", url);
  } else {
    window.history.pushState(window.history.state, "", url);
    depth++;
  }
  window.dispatchEvent(new Event(NAV_EVENT));
}

/** Goes back if we came from inside the app, otherwise to the given fallback view. */
export function goBack(fallback: View) {
  if (depth > 0) {
    depth--;
    window.history.back();
  } else {
    navigate(fallback, { replace: true });
  }
}
