"use client";

// Browser-side wrappers for the AI endpoints. The Gemini key stays on the server.
// Each call first sends any edits still waiting to sync, because the server reads the
// chart from the database: a just-typed action must be there before the AI looks.

import { api } from "./api-client";
import { dayKey } from "./mandala";
import { synced } from "./store";
import type { LeverageAnalysis, ReportAnalysis, Suggestion } from "./types";

export const ai = {
  /** Candidate pillars for a goal, or candidate actions for one pillar. Never auto-filled. */
  async suggest(input: { goalId: string; target: "pillars" | "actions"; pillar?: number; hint?: string }) {
    await synced();
    return api.post<{ suggestions: Suggestion[] }>("/api/ai/suggest", input);
  },

  /** Rewrites one line so it passes the method's tests: can you tick it off, do you control it? */
  async sharpen(input: {
    goalId?: string;
    role: "goal" | "pillar" | "action";
    text: string;
    pillar?: number;
    /** A deadline picked before the goal exists (new goal flow). */
    deadline?: string | null;
  }) {
    await synced();
    return api.post<{ issues: string[]; options: string[] }>("/api/ai/sharpen", input);
  },

  /** Impact, effort and synergy for every filled square, plus 5-8 picks for this week. */
  async leverage(input: { goalId: string }) {
    await synced();
    // Local day and time zone, so the server counts weeks the way this device does.
    const local = { today: dayKey(), tzOffset: new Date().getTimezoneOffset() };
    return api.post<LeverageAnalysis>("/api/ai/leverage", { ...input, ...local });
  },

  /** Transcribes a voice report and proposes chart updates. Audio is never stored. */
  async analyzeAudio(input: { audio: Blob; goalId: string | null; day: string }) {
    await synced();
    const form = new FormData();
    const type = input.audio.type || "audio/webm";
    const extension = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
    form.set("audio", input.audio, `report.${extension}`);
    form.set("day", input.day);
    if (input.goalId) form.set("goalId", input.goalId);
    return api.post<ReportAnalysis>("/api/reports/analyze", form);
  },

  /** Same as analyzeAudio, for a typed report. */
  async analyzeText(input: { text: string; goalId: string | null; day: string }) {
    await synced();
    return api.post<ReportAnalysis>("/api/reports/analyze", input);
  },
};
