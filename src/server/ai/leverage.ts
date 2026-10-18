import "server-only";
import { z } from "zod";
import { HttpError } from "@/server/http";
import { actionLever, dayKey, pillarCell } from "@/domain/mandala";
import type { Cell, GoalWithCells, LeverageAnalysis } from "@/domain/types";
import type { AiPrompt } from "./inputs";
import { LEVERAGE_TASK, METHOD } from "./coach";
import { clamp, fit, list, obj, phrase, rating, sentence, str } from "./format";
import { actionKey, goalLines, namedPillars, outline, pillarFromRef, pillarRef } from "./chart";
import { run } from "./run";

// Leverage: rates pillars and actions and proposes this week's picks.

const rawLeverage = z.object({
  pillars: z.array(z.unknown()).catch([]),
  actions: z.array(z.unknown()).catch([]),
  picks: z.array(z.unknown()).catch([]),
  insight: z.string().catch(""),
});
const rawPillarRating = z.object({
  ref: z.string(),
  reason: z.string().catch(""),
  impact: z.coerce.number(),
  helps: z.array(z.unknown()).catch([]),
});
const rawActionRating = z.object({
  ref: z.string(),
  reason: z.string().catch(""),
  impact: z.coerce.number(),
  effort: z.coerce.number(),
  helps: z.array(z.unknown()).catch([]),
});

/**
 * Where the weekly rollout stands, counted from the earliest pick on the chart (the Leverage
 * view's "Week N"). In the first 7 days picks are the week's full set; after that they are the
 * 5-8 new actions to add, as the method says.
 */
interface Rollout {
  mode: "start" | "same" | "next";
  week: number;
  /** Open actions already on this week. */
  onWeek: Cell[];
  /** Where picks come from, and which side to fill from first when the model picked too few. */
  pool: Cell[];
  prefer: "new" | "current";
}

/** The user's local calendar day for a stored timestamp (the server itself runs in UTC). */
function userDay(iso: string, tzOffset: number): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso.slice(0, 10) : new Date(time - tzOffset * 60_000).toISOString().slice(0, 10);
}

function rollout(actions: Cell[], today: string, tzOffset: number): Rollout {
  const open = actions.filter((c) => c.status !== "done");
  const onWeek = open.filter((c) => c.active);
  const fresh = open.filter((c) => !c.active);
  const started = actions
    .filter((c) => c.active && c.activatedAt)
    .map((c) => userDay(c.activatedAt!, tzOffset))
    .sort()[0];
  const elapsed = started ? Math.round((Date.parse(today) - Date.parse(started)) / 86_400_000) : 0;
  const days = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  const week = Math.floor(days / 7) + 1;
  if (!onWeek.length) return { mode: "start", week, onWeek, pool: open, prefer: "new" };
  if (days < 7) return { mode: "same", week, onWeek, pool: open, prefer: "current" };
  // A new week: add new actions. The current ones count only when there are not enough new ones.
  return { mode: "next", week, onWeek, pool: fresh.length >= 5 ? fresh : open, prefer: "new" };
}

function weekNote(r: Rollout): string {
  const n = r.onWeek.length;
  const actions = `${n} open action${n === 1 ? "" : "s"}`;
  if (r.mode === "start") {
    return r.week > 1
      ? `Week ${r.week}: everything picked so far is done. Pick the next set.`
      : "Week 1: nothing is on this week yet. Pick the set to start with.";
  }
  if (r.mode === "same") {
    return `Week ${r.week}: ${actions} already on this week. Picks are this week's full set: keep the ones already on this week that earn their place and add new ones to reach 5-8 in total.`;
  }
  return `Week ${r.week}: the ${actions} already on this week stay on. Picks are the new ones to add this week, from actions not on this week yet.`;
}

export function leveragePrompt(goal: GoalWithCells, today = dayKey(), tzOffset = 0): AiPrompt<LeverageAnalysis> {
  const pillars = namedPillars(goal);
  if (!pillars.length) throw new HttpError(400, "Name at least one pillar first.");
  const refs = new Map<string, Cell>();
  const chart = outline(goal, refs);
  const actions = [...refs.values()];
  const plan = rollout(actions, today, tzOffset);
  const pillarRefs = pillars.map((x) => pillarRef(x.pillar));
  const fewest = Math.min(5, plan.pool.length);
  const most = Math.min(8, plan.pool.length);
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

  const lines = [
    ...goalLines(goal, today),
    "",
    "The chart (ref, text, details):",
    ...chart,
    "",
    ...(plan.pool.length
      ? [
          weekNote(plan),
          `Rate the ${plural(pillars.length, "named pillar")} and all ${plural(actions.length, "action")}, then pick ${fewest === most ? most : `${fewest}-${most}`}.`,
        ]
      : [`Rate the ${plural(pillars.length, "named pillar")}. There are no open actions, so return no picks.`]),
  ];

  const helps = list({ type: "string", enum: pillarRefs }, { maxItems: 7, description: "Other pillars, by ref" });
  return {
    task: "leverage",
    system: `${METHOD}\n\n${LEVERAGE_TASK}`,
    text: lines.join("\n"),
    schema: obj({
      pillars: list(
        obj({
          ref: { type: "string", enum: pillarRefs },
          reason: str("Why, 12 words at most"),
          impact: rating("How much it moves the goal"),
          helps,
        }),
        { minItems: pillars.length, maxItems: pillars.length },
      ),
      actions: list(
        obj({
          ref: str("Action ref, e.g. A3.5"),
          reason: str("Why, 12 words at most"),
          impact: rating("How much it moves its pillar and the goal"),
          effort: rating("1 easy, 2 medium, 3 hard"),
          helps,
        }),
      ),
      picks: list(str("Action ref"), plan.pool.length ? { minItems: fewest, maxItems: most } : {}),
      insight: str("One sentence naming the lever pillar and why, 25 words at most"),
    }),
    temperature: 0.3,
    parse: (data) => finishLeverage(data, goal, refs, plan),
  };
}

type Rated = { impact: number; effort: number; helps: number[] };

function finishLeverage(data: unknown, goal: GoalWithCells, refs: Map<string, Cell>, plan: Rollout): LeverageAnalysis {
  const raw = rawLeverage.parse(data);
  const named = new Set(namedPillars(goal).map((x) => x.pillar));
  const helpsOf = (values: unknown[], own: number) =>
    [...new Set(values.map(pillarFromRef))]
      .filter((p): p is number => p !== null && p !== own && named.has(p))
      .sort((a, b) => a - b);

  const pillars: LeverageAnalysis["pillars"] = [];
  for (const entry of raw.pillars) {
    const parsed = rawPillarRating.safeParse(entry);
    if (!parsed.success || !Number.isFinite(parsed.data.impact)) continue;
    const pillar = pillarFromRef(parsed.data.ref);
    if (pillar === null || !named.has(pillar) || pillars.some((x) => x.pillar === pillar)) continue;
    pillars.push({
      pillar,
      impact: clamp(Math.round(parsed.data.impact), 1, 3),
      helps: helpsOf(parsed.data.helps, pillar),
      reason: phrase(parsed.data.reason, 100),
    });
  }

  const actions: LeverageAnalysis["actions"] = [];
  const rated = new Map<string, Rated>();
  for (const entry of raw.actions) {
    const parsed = rawActionRating.safeParse(entry);
    if (!parsed.success || !Number.isFinite(parsed.data.impact) || !Number.isFinite(parsed.data.effort)) continue;
    const cell = refs.get(actionKey(parsed.data.ref));
    if (!cell || rated.has(cell.id)) continue;
    const rating: Rated = {
      impact: clamp(Math.round(parsed.data.impact), 1, 3),
      effort: clamp(Math.round(parsed.data.effort), 1, 3),
      helps: helpsOf(parsed.data.helps, cell.pillar),
    };
    rated.set(cell.id, rating);
    actions.push({ cellId: cell.id, ...rating, reason: phrase(parsed.data.reason, 100) });
  }

  const modelPicks: Cell[] = [];
  for (const ref of raw.picks) {
    const cell = refs.get(actionKey(ref));
    if (cell && plan.pool.includes(cell) && !modelPicks.includes(cell)) modelPicks.push(cell);
  }
  const picks = repairPicks(modelPicks, plan, rated);

  return { pillars, actions, picks, insight: fit(sentence(raw.insight), 220) || fallbackInsight(goal, pillars) };
}

/**
 * Keeps the model's picks but guarantees the contract: 5-8 open actions (fewer only when fewer
 * exist), filled up from the preferred side of the week first, then new pillars, then lever
 * score, and trimmed to 8 without losing pillars.
 */
function repairPicks(picked: Cell[], plan: Rollout, rated: Map<string, Rated>): string[] {
  const score = (cell: Cell) => {
    const r = rated.get(cell.id);
    return r ? r.impact * (4 - r.effort) * (1 + r.helps.length) : (actionLever(cell) ?? 0);
  };
  const picks = [...picked];
  const target = Math.min(5, plan.pool.length);
  const covered = new Set(picks.map((c) => c.pillar));
  while (picks.length < target) {
    let best: Cell | undefined;
    let bestValue = -1;
    for (const cell of plan.pool) {
      if (picks.includes(cell)) continue;
      // Scores are at most 72, so these weights order by: preferred side, new pillar, then score.
      const preferred = plan.prefer === "current" ? cell.active : !cell.active;
      const value = (preferred ? 1000 : 0) + (covered.has(cell.pillar) ? 0 : 100) + score(cell);
      if (value > bestValue) {
        best = cell;
        bestValue = value;
      }
    }
    if (!best) break;
    picks.push(best);
    covered.add(best.pillar);
  }
  if (picks.length > 8) {
    const firstPerPillar = picks.filter((c, i) => picks.findIndex((o) => o.pillar === c.pillar) === i);
    const keep = new Set([...new Set([...firstPerPillar, ...picks])].slice(0, 8));
    return picks.filter((c) => keep.has(c)).map((c) => c.id);
  }
  return picks.map((c) => c.id);
}

function fallbackInsight(goal: GoalWithCells, pillars: LeverageAnalysis["pillars"]): string {
  const top = [...pillars].sort((a, b) => b.impact * (1 + b.helps.length) - a.impact * (1 + a.helps.length))[0];
  const name = top ? pillarCell(goal, top.pillar)?.text.trim() : "";
  if (!top || !name) return "";
  return top.helps.length
    ? `${name} is the lever: it makes ${top.helps.length} other pillar${top.helps.length === 1 ? "" : "s"} easier.`
    : `${name} moves the goal most.`;
}

export function leverage(
  goal: GoalWithCells,
  where: { today?: string; tzOffset?: number } = {},
): () => Promise<LeverageAnalysis> {
  const prompt = leveragePrompt(goal, where.today ?? dayKey(), where.tzOffset ?? 0);
  return () => run(prompt, [{ text: prompt.text }], { budgetMs: 55_000, attemptMs: 42_000 });
}
