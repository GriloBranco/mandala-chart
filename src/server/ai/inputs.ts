import "server-only";
import { z } from "zod";
import type { Checkin, GoalWithCells } from "@/domain/types";
import { daySchema } from "@/domain/validators";

// What the routes accept for each AI feature, and the shape every prompt builder returns.

const id = z.string().trim().min(1).max(64);
const pillarIndex = z.number().int().min(0).max(7);

export const suggestInputSchema = z.object({
  goalId: id,
  target: z.enum(["pillars", "actions"]),
  pillar: pillarIndex.nullish(),
  hint: z.string().max(4000).nullish(),
});
export type SuggestInput = z.infer<typeof suggestInputSchema>;

// Context fields never fail a sharpen: an empty date input or an odd pillar index is just ignored.
export const sharpenInputSchema = z.object({
  goalId: z.string().max(64).nullish(),
  role: z.enum(["goal", "pillar", "action"]),
  text: z.string().max(1000),
  pillar: z
    .number()
    .nullish()
    .transform((p) => (p !== null && p !== undefined && Number.isInteger(p) && p >= 0 && p < 8 ? p : null)),
  /** Optional: the date picked in the new-goal flow before the goal exists. */
  deadline: z
    .string()
    .nullish()
    .transform((d) => (d && daySchema.safeParse(d).success ? d : null)),
});
export type SharpenInput = z.infer<typeof sharpenInputSchema>;

export const leverageInputSchema = z.object({
  goalId: id,
  /** The user's local day and time zone (minutes, as Date.getTimezoneOffset), so week math matches the app. */
  today: daySchema.optional(),
  tzOffset: z.number().int().min(-900).max(900).optional(),
});

export const analyzeTextSchema = z.object({
  text: z.string().max(20_000),
  day: daySchema,
  goalId: id.nullish(),
});

/** What a report is matched against: one goal, or the active goals, most recently active first. */
export interface ReportScope {
  goals: GoalWithCells[];
  checkins: Checkin[];
  day: string;
}

export interface AiPrompt<T> {
  task: string;
  system: string;
  /** The user turn: the person's chart and the request. */
  text: string;
  schema: object;
  temperature: number;
  parse: (data: unknown) => T;
}
