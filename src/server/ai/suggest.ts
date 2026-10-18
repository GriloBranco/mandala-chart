import "server-only";
import { z } from "zod";
import { HttpError } from "@/server/http";
import { dayKey, isFilled, pillarCell } from "@/domain/mandala";
import type { GoalWithCells, Suggestion } from "@/domain/types";
import { guessKind } from "@/domain/kind";
import type { AiPrompt, SuggestInput } from "./inputs";
import { ACTIONS_TASK, METHOD, PILLARS_TASK } from "./coach";
import { item, list, obj, oneLine, overlaps, phrase, str } from "./format";
import { chartSketch, goalLines, namedPillars, pillarRef, readHint } from "./chart";
import { run } from "./run";

// Suggest: ideas for empty pillars or actions.

const rawSuggestions = z.object({ suggestions: z.array(z.unknown()) });
const rawSuggestion = z.object({
  text: z.string(),
  kind: z.string().optional().catch(undefined),
  note: z.string().optional().catch(undefined),
});

export function suggestPrompt(goal: GoalWithCells, input: SuggestInput, today = dayKey()): AiPrompt<Suggestion[]> {
  const pillars = namedPillars(goal);
  const { already, note } = readHint(input.hint);
  const extra = [
    ...(already.length ? ["", `Already suggested, give different ones: ${already.join("; ")}`] : []),
    ...(note ? ["", `Note from the person: ${note}`] : []),
  ];

  if (input.target === "pillars") {
    const avoid = [goal.title, ...pillars.map((p) => p.text), ...already];
    const lines = [
      ...goalLines(goal, today),
      "",
      pillars.length
        ? `Pillars so far (${pillars.length} of 8): ${pillars.map((p) => p.text).join("; ")}`
        : "No pillars yet.",
      ...extra,
      "",
      "Suggest 12 pillars.",
    ];
    return {
      task: "suggest pillars",
      system: `${METHOD}\n\n${PILLARS_TASK}`,
      text: lines.join("\n"),
      schema: obj({
        suggestions: list(
          obj({
            text: str("The pillar: 1-3 words, 20 characters at most"),
            note: str("Why it matters for this goal, 10 words at most"),
          }),
          { minItems: 10, maxItems: 12 },
        ),
      }),
      temperature: 0.9,
      parse: (data) => finishSuggestions(data, avoid, "pillar"),
    };
  }

  const p = input.pillar;
  if (p === null || p === undefined) throw new HttpError(400, "Pick a pillar first.");
  const pillar = pillarCell(goal, p);
  if (!isFilled(pillar)) throw new HttpError(400, "Name this pillar first, then ask for actions.");
  const avoid = [...goal.cells.filter((c) => c.slot >= 0 && isFilled(c)).map((c) => c.text), ...already];
  const lines = [
    ...goalLines(goal, today),
    "",
    "The chart so far:",
    ...chartSketch(goal, p),
    ...extra,
    "",
    `Suggest 12 actions for ${pillarRef(p)} "${oneLine(pillar.text, 60)}".`,
  ];
  return {
    task: "suggest actions",
    system: `${METHOD}\n\n${ACTIONS_TASK}`,
    text: lines.join("\n"),
    schema: obj({
      suggestions: list(
        obj({
          text: str("The action: starts with a verb, has a number or frequency, 60 characters at most"),
          kind: { type: "string", enum: ["habit", "task"], description: "habit if it repeats, task if done once" },
          note: str("Why it helps, 10 words at most"),
        }),
        { minItems: 10, maxItems: 12 },
      ),
    }),
    temperature: 0.9,
    parse: (data) => finishSuggestions(data, avoid, "action"),
  };
}

function finishSuggestions(data: unknown, avoid: string[], role: "pillar" | "action"): Suggestion[] {
  // The square's limits: longer text would not fit, so it is dropped instead of cut.
  const max = role === "pillar" ? 24 : 60;
  const kept: Suggestion[] = [];
  for (const entry of rawSuggestions.parse(data).suggestions) {
    const parsed = rawSuggestion.safeParse(entry);
    if (!parsed.success) continue;
    const value = item(parsed.data.text);
    if (!value || value.length > max) continue;
    if (avoid.some((other) => overlaps(value, other)) || kept.some((s) => overlaps(value, s.text))) continue;
    const suggestion: Suggestion = { text: value };
    if (role === "action") {
      const kind = parsed.data.kind?.toLowerCase();
      suggestion.kind = kind === "habit" || kind === "task" ? kind : guessKind(value);
    }
    const note = phrase(parsed.data.note, 90);
    if (note) suggestion.note = note;
    kept.push(suggestion);
    if (kept.length === 12) break;
  }
  return kept;
}

export function suggest(goal: GoalWithCells, input: SuggestInput): () => Promise<{ suggestions: Suggestion[] }> {
  const prompt = suggestPrompt(goal, input);
  return async () => ({
    suggestions: await run(prompt, [{ text: prompt.text }], { budgetMs: 40_000, attemptMs: 25_000 }),
  });
}
