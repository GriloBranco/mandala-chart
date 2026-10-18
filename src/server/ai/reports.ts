import "server-only";
import { z } from "zod";
import type { Cell, GoalWithCells, ProposedUpdate, ReportAnalysis } from "@/domain/types";
import type { AiPrompt, ReportScope } from "./inputs";
import { analyzeTask, METHOD } from "./coach";
import { clamp, fit, list, obj, oneLine, overlaps, phrase, type Schema, sentence, str, text, textKey } from "./format";
import { actionKey, outline } from "./chart";

// Report analysis: reads a day's report and proposes updates to the chart.

const rawAnalysis = z.object({
  transcript: z.string().catch(""),
  summary: z.string().catch(""),
  updates: z.array(z.unknown()).catch([]),
});
const rawUpdate = z.object({
  ref: z.string(),
  quote: z.string().catch(""),
  change: z.enum(["done", "doing", "checkin", "note"]).catch("note"),
  note: z.string().catch(""),
  confidence: z.coerce.number().catch(0.5),
});

function weekday(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
}

/**
 * The most chart text one report prompt carries, about 3 full goals. The daily limits count
 * calls, not size, so this is what keeps each call's cost bounded.
 */
const REPORT_CHART_BUDGET = 40_000;

/** One goal's part of a report prompt. The label ("G2") is set when the report covers several goals. */
function goalChart(goal: GoalWithCells, refs: Map<string, Cell>, checked: Set<string>, label = ""): string[] {
  const lines = outline(goal, refs, { prefix: label ? `${label}.` : "", checked });
  return [`${label || "Goal"}: ${oneLine(goal.title, 200)}`, ...(lines.length ? lines : ["  (no pillars yet)"])];
}

/**
 * The goals a report prompt includes: whole goals, in the scope's order (most recently active
 * first for a general report), while their charts fit the budget. The first one always fits.
 */
function goalsWithin(goals: GoalWithCells[], checked: Set<string>, budget: number): GoalWithCells[] {
  const kept: GoalWithCells[] = [];
  let size = 0;
  for (const goal of goals) {
    // Measured with the longest label in use, so the real chart is never bigger.
    const length = goalChart(goal, new Map(), checked, `G${goals.length}`).join("\n").length + 2;
    if (kept.length && size + length > budget) break;
    kept.push(goal);
    size += length;
  }
  return kept;
}

export function analyzePrompt(
  scope: ReportScope,
  report: { text: string } | { audio: true },
  budget = REPORT_CHART_BUDGET,
): AiPrompt<ReportAnalysis> {
  const audio = "audio" in report;
  const refs = new Map<string, Cell>();
  const checked = new Set(scope.checkins.filter((c) => c.day === scope.day).map((c) => c.cellId));
  const goals = goalsWithin(scope.goals, checked, budget);
  const multi = goals.length > 1;

  const chart: string[] = [];
  goals.forEach((goal, i) => {
    if (chart.length) chart.push("");
    chart.push(...goalChart(goal, refs, checked, multi ? `G${i + 1}` : ""));
  });

  const lines = [
    `Report day: ${scope.day}${weekday(scope.day) ? ` (${weekday(scope.day)})` : ""}`,
    "",
    multi ? "Charts (ref, action, details):" : "Chart (ref, action, details):",
    ...(chart.length ? chart : ["(no goals yet)"]),
  ];
  if (!refs.size) lines.push("", "There are no actions yet, so return no updates.");
  lines.push(
    "",
    ...(audio
      ? ["The report is the attached audio recording."]
      : ["The report (typed):", '"""', report.text.trim().replace(/"""/g, '"'), '"""']),
  );

  const properties: Record<string, Schema> = {};
  if (audio) properties.transcript = str("The words as spoken, filler words removed; empty if there is no speech");
  properties.summary = str("One short first-person sentence");
  properties.updates = list(
    obj(
      {
        ref: str(multi ? "Action ref, e.g. G1.A3.5" : "Action ref, e.g. A3.5"),
        quote: str("Their own words, 100 characters at most"),
        change: { type: "string", enum: ["done", "doing", "checkin", "note"] },
        note: str("Optional detail worth keeping, 120 characters at most"),
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      ["ref", "quote", "change", "confidence"],
    ),
    { maxItems: 30 },
  );

  return {
    task: audio ? "analyze voice" : "analyze text",
    system: `${METHOD}\n\n${analyzeTask(audio, multi ? "G1.A3.5" : "A3.5")}`,
    text: lines.join("\n"),
    schema: obj(properties),
    temperature: 0.2,
    parse: (data) => {
      const raw = rawAnalysis.parse(data);
      const transcript = audio
        ? raw.transcript.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
        : (report as { text: string }).text.trim();
      const lookup = (ref: string) => {
        const key = actionKey(ref);
        return refs.get(key) ?? (multi ? undefined : refs.get(key.replace(/^G1\./, "")));
      };
      return {
        transcript,
        summary: fit(sentence(raw.summary), 200) || oneLine(transcript, 120),
        updates: finishUpdates(raw.updates, lookup, checked, transcript),
      };
    },
  };
}

/**
 * Turns the model's updates into ProposedUpdates the review can show as is: one per square,
 * shaped by the square's kind (habits get a check-in, never "done"), no-ops dropped, and
 * confidence capped when the quote cannot be found in what the person said.
 */
function finishUpdates(
  entries: unknown[],
  lookup: (ref: string) => Cell | undefined,
  checked: Set<string>,
  transcript: string,
): ProposedUpdate[] {
  const byCell = new Map<string, ProposedUpdate[]>();
  for (const entry of entries) {
    const parsed = rawUpdate.safeParse(entry);
    if (!parsed.success) continue;
    const cell = lookup(parsed.data.ref);
    if (!cell) continue;
    const { change } = parsed.data;
    const update: ProposedUpdate = {
      cellId: cell.id,
      quote: fit(text(parsed.data.quote).replace(/^["“]|["”]$/g, ""), 100),
      confidence: clamp(Number.isFinite(parsed.data.confidence) ? parsed.data.confidence : 0.5, 0, 1),
    };
    if (cell.kind === "habit") {
      if ((change === "checkin" || change === "done") && !checked.has(cell.id)) update.checkin = true;
    } else if ((change === "done" || change === "checkin") && cell.status !== "done") {
      update.status = "done";
    } else if (change === "doing" && cell.status === "todo") {
      update.status = "doing";
    }
    const note = phrase(parsed.data.note, 120);
    if (note && !overlaps(note, cell.text)) update.note = note;
    if (!update.status && !update.checkin && !update.note) continue;
    if (!quoteHeard(update.quote, transcript)) update.confidence = Math.min(update.confidence, 0.5);
    update.confidence = Math.round(update.confidence * 100) / 100;

    const list = byCell.get(cell.id);
    if (list) list.push(update);
    else byCell.set(cell.id, [update]);
  }
  return [...byCell.values()].slice(0, 30).map(mergeUpdates);
}

/**
 * One update per square: "done" beats "doing" and notes are joined. Confidence and quote come
 * from the updates behind the change that is kept (status, else check-in), so a sure note cannot
 * lend its confidence to a stray check-in and have the review pre-check it.
 */
function mergeUpdates(updates: ProposedUpdate[]): ProposedUpdate {
  if (updates.length === 1) return updates[0];
  const status = updates.some((u) => u.status === "done") ? "done" : updates.find((u) => u.status)?.status;
  const checkin = updates.some((u) => u.checkin);
  const backing = updates.filter((u) => (status ? u.status === status : checkin ? u.checkin : true));
  const best = backing.reduce((a, b) => (b.confidence > a.confidence ? b : a));
  const notes = [...new Set(updates.map((u) => u.note).filter((note) => note !== undefined))];
  const merged: ProposedUpdate = { cellId: updates[0].cellId, quote: best.quote, confidence: best.confidence };
  if (status) merged.status = status;
  if (checkin) merged.checkin = true;
  if (notes.length) merged.note = fit(notes.join("; "), 120);
  return merged;
}

/** True when most words of the quote are in the transcript (the model may trim or tidy a little). */
function quoteHeard(quote: string, transcript: string): boolean {
  const q = textKey(quote.replace(/…$/, ""));
  if (!q) return false;
  const t = textKey(transcript);
  if (t.includes(q)) return true;
  const words = new Set(t.split(" "));
  const quoteWords = q.split(" ");
  return quoteWords.filter((w) => words.has(w)).length / quoteWords.length >= 0.7;
}
