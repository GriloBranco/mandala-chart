// Light helpers for the new goal flow. They suggest; they never block.

import { actionHints, dayKey } from "@/lib/mandala";
import { localKey } from "@/lib/store";

// ---------- kind ----------

export { guessKind } from "@/lib/kind";

// ---------- hints ----------

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function pillarHints(text: string, others: string[]): string[] {
  const t = text.trim();
  if (!t) return [];
  const hints: string[] = [];
  if (others.some((other) => same(other, t))) hints.push("You already have this pillar.");
  if (t.length > 28 || t.split(/\s+/).length > 4) hints.push("Keep it short: 1-3 words. Details go in the actions.");
  return hints;
}

export function actionNudges(text: string, others: string[]): string[] {
  const t = text.trim();
  if (!t) return [];
  const hints = actionHints(t);
  if (others.some((other) => same(other, t))) hints.unshift("Already in this chart.");
  return hints;
}

// ---------- dates ----------

export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const first = new Date(y, m - 1 + months, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return dayKey(new Date(first.getFullYear(), first.getMonth(), Math.min(d, last)));
}

export function formatDay(day: string, weekday = false): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: weekday ? "short" : undefined,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const MONTHS: Record<string, number> = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3, may: 4, june: 5, jun: 5,
  july: 6, jul: 6, august: 7, aug: 7, september: 8, sept: 8, sep: 8, october: 9, oct: 9, november: 10,
  nov: 10, december: 11, dec: 11,
  janeiro: 0, fevereiro: 1, fev: 1, "março": 2, marco: 2, abril: 3, abr: 3, maio: 4, mai: 4, junho: 5,
  julho: 6, agosto: 7, ago: 7, setembro: 8, set: 8, outubro: 9, out: 9, novembro: 10, dezembro: 11, dez: 11,
};
const byLength = (a: string, b: string) => b.length - a.length;
const MONTH = Object.keys(MONTHS).sort(byLength).join("|");
// "out", "set" and "ago" are also everyday English words ("sell out 2027 tickets"). Trust them
// as months only next to a day number, after a date word ("até out 2027") or with a dot.
const AMBIGUOUS = new Set(["out", "set", "ago"]);
const SAFE_MONTH = Object.keys(MONTHS)
  .filter((m) => !AMBIGUOUS.has(m))
  .sort(byLength)
  .join("|");
const MONTH_DAY_YEAR = new RegExp(`\\b(${SAFE_MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`, "i");
const DAY_MONTH_YEAR = new RegExp(`\\b(\\d{1,2})\\s+(?:de\\s+)?(${MONTH})\\.?,?\\s+(?:de\\s+)?(20\\d{2})\\b`, "i");
const MONTH_YEAR = new RegExp(`\\b(${SAFE_MONTH})\\.?,?\\s+(?:de\\s+|of\\s+)?(20\\d{2})\\b`, "i");
const AMBIGUOUS_MONTH_YEAR =
  /\b(?:(?:de|em|até|ate|by|in|until|before)\s+(out|set|ago)\.?|(out|set|ago)\.)\s*,?\s*(?:de\s+)?(20\d{2})\b/i;
const YEAR_ONLY = /\b(?:by|before|until|in|end of|até|ate|em|fim de)\s+(20\d{2})\b/i;
// Year first only: 03/04/2027 could be March or April, so it is left alone.
const ISO_DAY = /\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/;

function makeDay(year: number, month: number, day: number | null): string | null {
  if (month < 0 || month > 11) return null;
  const last = new Date(year, month + 1, 0).getDate();
  const d = day ?? last;
  if (d < 1 || d > last) return null;
  return dayKey(new Date(year, month, d));
}

/** A deadline written in the goal itself ("By June 2027, I will…"), if it is in the future. */
export function deadlineFromText(text: string, today: string): string | null {
  let day: string | null = null;
  const iso = ISO_DAY.exec(text);
  const mdy = MONTH_DAY_YEAR.exec(text);
  const dmy = DAY_MONTH_YEAR.exec(text);
  const my = MONTH_YEAR.exec(text);
  const amy = AMBIGUOUS_MONTH_YEAR.exec(text);
  const y = YEAR_ONLY.exec(text);
  // An invalid ISO date gives no deadline, not the end of its year.
  if (iso) day = makeDay(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  else if (mdy) day = makeDay(Number(mdy[3]), MONTHS[mdy[1].toLowerCase()], Number(mdy[2]));
  else if (dmy) day = makeDay(Number(dmy[3]), MONTHS[dmy[2].toLowerCase()], Number(dmy[1]));
  else if (my) day = makeDay(Number(my[2]), MONTHS[my[1].toLowerCase()], null);
  else if (amy) day = makeDay(Number(amy[3]), MONTHS[(amy[1] ?? amy[2]).toLowerCase()], null);
  else if (y) day = makeDay(Number(y[1]), 11, 31);
  return day && day > today ? day : null;
}

// ---------- local drafts (this device only) ----------
// Kept under the signed-in account, so the next person on a shared device never sees them.

export interface GoalDraft {
  title: string;
  why: string;
  deadline: string | null;
  /** The date was cleared on purpose: do not take it from the goal's words. */
  noDate?: boolean;
  /** Sent when creating the goal, so a retry after a lost response gets the same goal back. */
  id?: string;
}

const DRAFT = "new-goal-draft";

export function readDraft(): GoalDraft | null {
  if (typeof window === "undefined") return null;
  const where = localKey(DRAFT);
  if (!where) return null;
  try {
    const raw = window.localStorage.getItem(where.key);
    const draft = raw ? (JSON.parse(raw) as Partial<GoalDraft> & { owner?: unknown }) : null;
    // The draft names its account too: one saved for anyone else is never shown.
    if (!draft || draft.owner !== where.account) return null;
    return {
      title: typeof draft.title === "string" ? draft.title : "",
      why: typeof draft.why === "string" ? draft.why : "",
      deadline: typeof draft.deadline === "string" ? draft.deadline : null,
      noDate: draft.noDate === true,
      id: typeof draft.id === "string" ? draft.id : undefined,
    };
  } catch {
    return null;
  }
}

export function writeDraft(draft: GoalDraft | null) {
  const where = localKey(DRAFT);
  if (!where) return;
  try {
    if (!draft || (!draft.title.trim() && !draft.why.trim() && !draft.deadline)) {
      window.localStorage.removeItem(where.key);
    } else {
      window.localStorage.setItem(where.key, JSON.stringify({ ...draft, owner: where.account }));
    }
  } catch {
    // Private mode or full storage: the draft just is not kept.
  }
}

const dumpKey = (goalId: string) => localKey(`brain-dump:${goalId}`)?.key ?? null;

export function readDump(goalId: string): string {
  if (typeof window === "undefined") return "";
  const key = dumpKey(goalId);
  if (!key) return "";
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function writeDump(goalId: string, text: string) {
  const key = dumpKey(goalId);
  if (!key) return;
  try {
    if (text.trim()) window.localStorage.setItem(key, text);
    else window.localStorage.removeItem(key);
  } catch {
    // Not kept; fine.
  }
}

/** Week-1 picks not saved yet, and the actions that were active when they were made. */
export interface WeekPicks {
  active: string[];
  picks: string[];
}

const picksKey = (goalId: string) => localKey(`week1-picks:${goalId}`)?.key ?? null;

export function readWeekPicks(goalId: string): WeekPicks | null {
  if (typeof window === "undefined") return null;
  const key = picksKey(goalId);
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    const saved = raw ? (JSON.parse(raw) as Partial<WeekPicks> | null) : null;
    if (!saved || !Array.isArray(saved.active) || !Array.isArray(saved.picks)) return null;
    return { active: saved.active.map(String), picks: saved.picks.map(String) };
  } catch {
    return null;
  }
}

export function writeWeekPicks(goalId: string, saved: WeekPicks | null) {
  const key = picksKey(goalId);
  if (!key) return;
  try {
    if (saved) window.localStorage.setItem(key, JSON.stringify(saved));
    else window.localStorage.removeItem(key);
  } catch {
    // Not kept; fine.
  }
}

/** Brain-dump lines as ideas: list markers stripped, duplicates and placed ones left out. */
export function dumpIdeas(text: string, taken: string[]): string[] {
  const used = new Set(taken.map((t) => t.trim().toLowerCase()).filter(Boolean));
  const seen = new Set<string>();
  const ideas: string[] = [];
  for (const line of text.split("\n")) {
    const idea = line.replace(/^\s*(?:[-*•·]\s+|\d+[.)]\s+)/, "").trim().slice(0, 200);
    const key = idea.toLowerCase();
    if (!idea || used.has(key) || seen.has(key)) continue;
    seen.add(key);
    ideas.push(idea);
  }
  return ideas;
}
