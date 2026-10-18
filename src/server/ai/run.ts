import "server-only";
import type { Part } from "@google/genai";
import { generateJson } from "./gemini";
import type { AiPrompt } from "./inputs";

// Sends one prompt with the time limits of its route.

export function run<T>(
  prompt: AiPrompt<T>,
  parts: Part[],
  timing: { budgetMs?: number; deadline?: number; attemptMs: number; maxOutputTokens?: number },
): Promise<T> {
  return generateJson({
    task: prompt.task,
    system: prompt.system,
    parts,
    schema: prompt.schema,
    parse: prompt.parse,
    temperature: prompt.temperature,
    deadline: timing.deadline ?? Date.now() + (timing.budgetMs ?? 30_000),
    attemptMs: timing.attemptMs,
    maxOutputTokens: timing.maxOutputTokens,
  });
}
