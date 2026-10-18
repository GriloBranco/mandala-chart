import "server-only";
import { z } from "zod";
import { AiError } from "./gemini";
import { HttpError } from "@/server/http";
import { actionCells, dayKey, isFilled, pillarCell } from "@/domain/mandala";
import type { GoalWithCells } from "@/domain/types";
import type { AiPrompt, SharpenInput } from "./inputs";
import { METHOD, SHARPEN_TASKS } from "./coach";
import { item, list, obj, oneLine, phrase, sentence, str, textKey } from "./format";
import { namedPillars, timeLeft } from "./chart";
import { run } from "./run";

// Sharpen: turns a vague square into something you can tick off.

const rawSharpen = z.object({
  issues: z.array(z.unknown()).catch([]),
  options: z.array(z.unknown()),
});

const SHARPEN_LIMITS = { goal: 140, pillar: 24, action: 60 };

export function sharpenPrompt(
  input: SharpenInput,
  goal: GoalWithCells | null,
  today = dayKey(),
): AiPrompt<{ issues: string[]; options: string[] }> {
  const original = oneLine(input.text, 300);
  if (!original) throw new HttpError(400, "Type something first, then sharpen it.");
  const p = input.pillar ?? null;
  const lines: string[] = [];

  if (input.role === "goal") {
    const deadline = input.deadline ?? goal?.deadline ?? null;
    lines.push(deadline ? `Deadline picked: ${deadline} (${timeLeft(today, deadline)})` : "Deadline: none picked yet");
    if (goal?.why.trim()) lines.push(`Why it matters: ${oneLine(goal.why, 280)}`);
  } else if (goal) {
    lines.push(`Goal: ${oneLine(goal.title, 200)}`);
    if (input.role === "pillar") {
      const others = namedPillars(goal).filter((x) => x.pillar !== p && textKey(x.text) !== textKey(original));
      lines.push(others.length ? `Other pillars: ${others.map((x) => x.text).join("; ")}` : "No other pillars yet.");
    } else if (p !== null) {
      const pillar = pillarCell(goal, p);
      if (isFilled(pillar)) lines.push(`Pillar: ${oneLine(pillar.text, 60)}`);
      const siblings = actionCells(goal, p)
        .filter((c) => isFilled(c) && textKey(c.text) !== textKey(original))
        .map((c) => oneLine(c.text, 100));
      if (siblings.length) lines.push(`Other actions under this pillar: ${siblings.join("; ")}`);
    }
  }
  lines.push(`Today: ${today}`, "", `Sharpen this ${input.role}: "${original}"`);

  const limit = SHARPEN_LIMITS[input.role];
  return {
    task: `sharpen ${input.role}`,
    system: `${METHOD}\n\n${SHARPEN_TASKS[input.role]}`,
    text: lines.join("\n"),
    schema: obj({
      issues: list(str("What keeps it from passing, 8 words at most"), { maxItems: 3 }),
      options: list(str("A rewrite that passes"), { minItems: 3, maxItems: 3 }),
    }),
    temperature: 0.7,
    parse: (data) => {
      const raw = rawSharpen.parse(data);
      const issues = raw.issues.map((i) => phrase(i, 70)).filter(Boolean);
      const options: string[] = [];
      for (const option of raw.options) {
        const value = input.role === "goal" ? sentence(option).replace(/\.+$/, "") : item(option);
        if (!value || value.length > limit) continue;
        if (textKey(value) === textKey(original) || options.some((o) => textKey(o) === textKey(value))) continue;
        options.push(value);
      }
      // No usable option is a bad answer: let the next model try.
      if (!options.length) throw new AiError("AI sent back something unexpected. Try again.", 502, "output", "no usable options");
      return { issues: [...new Set(issues)].slice(0, 3), options: options.slice(0, 3) };
    },
  };
}

export function sharpen(input: SharpenInput, goal: GoalWithCells | null) {
  const prompt = sharpenPrompt(input, goal);
  return () => run(prompt, [{ text: prompt.text }], { budgetMs: 30_000, attemptMs: 18_000 });
}
