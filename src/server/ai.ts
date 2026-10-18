import "server-only";
import type { Part } from "@google/genai";
import { z } from "zod";
import { AiError, generateJson } from "./gemini";
import { HttpError } from "./http";
import { actionCells, actionLever, dayKey, isFilled, pillarCell } from "@/domain/mandala";
import type {
  Cell,
  Checkin,
  GoalWithCells,
  LeverageAnalysis,
  ProposedUpdate,
  ReportAnalysis,
  Suggestion,
} from "@/domain/types";
import { guessKind } from "@/domain/kind";
import { daySchema } from "@/domain/validators";

// Prompts and answers for the four AI features: suggest, sharpen, leverage and report analysis.
// The model sees short refs instead of ids (P3 = pillar 3, A3.5 = its 5th action, G2.A3.5 when a
// report covers several goals). Every answer is validated, clamped and mapped back to real ids
// here; unknown refs are dropped. Prompt builders are pure so they can be checked without a key.
// suggest, sharpen and leverage build their prompt first and return the call that sends it, so
// the routes use quota only for input that passed (a 400 never counts).

// ---------- inputs ----------

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

// ---------- the coach ----------

const METHOD = `You are a calm, practical coach who knows the Mandala chart (the Harada method, made famous by Shohei Ohtani's high-school chart) and helps one person use it every day.

How the chart works
- Center: one goal, best written "By [date], I will [result + number]".
- Around it, 8 pillars: the key drivers that must be true for the goal to happen. Short (1-3 words), distinct from each other, and together covering the whole person: mind, skill, body and daily life. Ohtani's chart had four pillars that were not skills: body, mental, character and luck.
- Each pillar gets 8 actions, so the full chart has 64.

The rules you coach by
1. Every action is tick-off-able: it fits in a calendar, and at the end of the day the person either did it or didn't.
2. Every action is in the person's control: an input, not an outcome. Bad: "ask more questions", "get 10M views". Good: "ask one question when stuck", "post 2 videos a day".
3. 64 actions at once overwhelm. Start with the 5-8 with the most leverage: one per pillar where possible, and first the ones that help two pillars at once. Add 5-8 more each week until the whole chart is live.
4. The chart is living: revising it is part of the method. A missed day is information, not failure.

How you write
- Plain, warm and direct, like a good coach texting a client. Specific to this person's goal, never generic.
- No hype, no jargon, no exclamation marks, no emojis. Sentence case. No period at the end of short items.
- Write in the person's language: if their goal is written in Portuguese, answer in Portuguese.`;

const PILLARS_TASK = `Your task: suggest pillars for the goal below.
- First think about what has to be true for this goal to happen. Brain dump widely (skill, practice, body, mind, environment, people, money, time, character), then keep the strongest and most distinct.
- Return 12 candidates, most important first.
- Each is a key driver of this specific goal, not a generic life area and not an action. For "run a half marathon under 2 hours", "Long runs" beats "Health".
- 1-3 words, 20 characters at most, sentence case.
- Together they cover mind, skill, body and daily life. Include at least one character, service or luck-style pillar (Ohtani's "luck" pillar meant picking up litter, greeting people, being someone others root for).
- No two candidates overlap, and none repeats or rephrases a pillar the person already has. If they have some already, favor what their mix is missing.
- note: why it matters for this goal, 10 words at most.`;

const ACTIONS_TASK = `Your task: suggest actions for one pillar of the goal below.
- Return 12 candidates, highest leverage first.
- Each passes both tests: the person can tick it off (it fits a calendar: done or not done) and it is in their control (an input, not an outcome).
- Start with a verb. Include a number, a frequency, a time or a clear finish line: "Lights out by 22:30", "Run 3x a week", "Book a gait analysis".
- Aim for 25-45 characters, 60 at most. Details go in the note.
- kind: "habit" if it repeats (daily or weekly), "task" if it is done once. Mostly habits, plus 2-4 one-off tasks that unlock progress (set up, book, buy, learn, ask someone).
- Small enough to start this week, and realistic for the deadline.
- Favor actions that also help another pillar, and name that pillar in the note.
- Nothing that repeats or rephrases an action already in the chart, under any pillar.
- note: why it helps, 10 words at most.`;

const SHARPEN_TASKS = {
  goal: `Your task: sharpen the goal (the center square).
A strong goal reads "By [date], I will [result + number]": one clear result, a number or a finish line, and a date. Ambitious is good; vague is not.
- issues: what keeps it from passing, e.g. "No date yet", "No number to measure", "Two goals in one". 0-3 items, 8 words at most each. None if it already passes.
- options: 3 rewrites that keep the person's intent and language, each in the "By [date], I will ..." form (said naturally in their language). Use the deadline if one is given; otherwise pick a realistic date. Make the 3 differ in a useful way (more or less ambitious, a different measure), not just in wording. 100 characters at most.
- If it already passes, return no issues and 3 tighter versions.`,
  pillar: `Your task: sharpen one pillar (a key driver around the goal).
A strong pillar is 1-3 words, a driver of this specific goal, distinct from the other pillars, and not an action or a vague life area.
- issues: what keeps it from passing, e.g. "Too long for a square", "Overlaps with Fitness", "An action, not a driver". 0-3 items, 8 words at most each. None if it already passes.
- options: 3 alternatives in the person's language, 1-3 words, 20 characters at most, distinct from the other pillars.
- If it already passes, return no issues and 3 close alternatives.`,
  action: `Your task: sharpen one action.
A strong action passes two tests: the person can tick it off (it fits a calendar: done or not done) and it is in their control (an input, not an outcome). It starts with a verb and has a number, a frequency or a time.
- issues: what keeps it from passing, e.g. "No number or frequency", "An outcome, not an input", "Too vague to tick off". 0-3 items, 8 words at most each. None if it already passes.
- options: 3 rewrites that keep the person's intent and language, start with a verb and pass both tests. 60 characters at most. Make them differ in a useful way (daily or weekly, a smaller or bigger step).
- If it already passes, return no issues and 3 tighter versions.`,
};

const LEVERAGE_TASK = `Your task: find the leverage in this chart and pick this week's actions.

Pillars (every named pillar):
- impact: how much it moves the goal. 3 = the goal fails without it, 2 = clearly helps, 1 = nice to have.
- helps: the other pillars it makes easier (the domino effect: better sleep makes training and focus easier). Only direct, real effects, usually 0-3.
- reason: why, 12 words at most.

Actions (every action listed):
- impact: how much it moves its pillar and the goal, 1-3. Use the whole scale; usually only about a third deserve 3.
- effort: 1 = easy (minutes, no setup), 2 = a real block of time or some discomfort, 3 = hard (lots of time, money, skill or willpower).
- helps: the other pillars this action also serves directly. Never its own pillar.
- reason: why, 12 words at most, specific to this person.

picks: the actions for this week, most important first.
1. One per pillar where possible, starting with pillars that have nothing on this week yet.
2. Actions that help two or more pillars come first: that is the highest leverage.
3. Then higher impact, then lower effort (easy wins build momentum).
4. Never pick a done action. For actions already on this week, follow the week note under the chart.

insight: one sentence that names the lever pillar (the one that makes the most other pillars easier) and says why, 25 words at most.

Use the refs exactly as listed (P2, A3.5).`;

function analyzeTask(audio: boolean, exampleRef: string): string {
  return `Your task: turn a daily report into proposed chart updates. The person reviews every update before anything changes, so only propose what they clearly said.

The report is a short diary entry about the report day: what they did, what got in the way, what's next.
${
  audio
    ? `
transcript: the words as spoken, in the language spoken, with filler words removed (um, uh, er, you know). Change nothing else: do not summarize, translate or fix grammar. If there is no speech, return an empty transcript.
`
    : ""
}
summary: one short sentence in the first person, plain, like a diary line. Lead with what went well; name what slipped without judgment. Example: "I ran 5k and finished the draft, but skipped meditation." Same language as the report.

updates: one per action the person actually reported on, pointing at it by its ref (exactly as listed, e.g. ${exampleRef}).
- Only what they said they did, started or could not do. Never invent progress. Plans and intentions are not progress: "I'll run tomorrow" is no update.
- Choose the most specific matching action. If nothing matches clearly, make no update. No updates for vague statements like "worked on my goals".
- habit: change "checkin" when they did it on the report day (not another day). A habit is never "done".
- task: change "done" when finished, "doing" when started or partly done.
- change "note" when they skipped it, could not do it or hit a blocker: put the reason in the note and change nothing else. Be kind: a missed day is information, not failure.
- note (optional, 120 characters at most): details worth keeping on that action, such as blockers, numbers, times, distances or names. Do not repeat the action text.
- quote: their own words that support the update, copied from the report, 100 characters at most.
- confidence 0-1: 0.9 or more when they clearly say they did this exact action; 0.6-0.8 when the match is clear but the extent is not; below 0.6 when you are inferring.
- Skip habits marked "already checked" and tasks marked "done", unless there is a useful note.
- If two actions fit equally, prefer the one marked "this week".`;
}

// ---------- JSON Schema helpers (only keywords Gemini supports) ----------

type Schema = Record<string, unknown>;

function str(description?: string): Schema {
  return description ? { type: "string", description } : { type: "string" };
}

function rating(description: string): Schema {
  return { type: "integer", minimum: 1, maximum: 3, description };
}

function list(items: Schema, extra: { minItems?: number; maxItems?: number; description?: string } = {}): Schema {
  return { type: "array", items, ...extra };
}

function obj(properties: Record<string, Schema>, required = Object.keys(properties)): Schema {
  return { type: "object", properties, required, propertyOrdering: Object.keys(properties) };
}

// ---------- text helpers ----------

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/** Cuts at a word boundary and adds an ellipsis. */
function fit(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, "")}…`;
}

function oneLine(value: string, max: number): string {
  return fit(text(value), max);
}

const EMOJI = /[\p{Extended_Pictographic}\u200d\ufe0f]/gu;
const QUOTE_PAIRS: Record<string, string> = { '"': '"', "'": "'", "“": "”", "‘": "’", "«": "»", "„": "“" };

/** A short item the model wrote: no list marker, wrapping quotes, emoji or end punctuation. */
function item(value: unknown): string {
  let out = text(value).replace(EMOJI, "").replace(/^(?:[-*•·]|\d+[.)])\s+/, "").trim();
  const close = QUOTE_PAIRS[out[0]];
  if (close && out.length > 2 && out.endsWith(close)) out = out.slice(1, -1).trim();
  out = out.replace(/!+/g, "").trim();
  // Keep "p.m." intact; drop a plain trailing period.
  if (!/\b\p{L}\.\p{L}\.$/u.test(out)) out = out.replace(/\.+$/, "");
  return out.trim();
}

/** A sentence the model wrote: calm punctuation, no emoji. */
function sentence(value: unknown): string {
  return text(value).replace(EMOJI, "").replace(/!+/g, ".").replace(/\s+([.,;:])/g, "$1").trim();
}

/** A short phrase (reason, note, issue): a sentence without the final period. */
function phrase(value: unknown, max: number): string {
  return fit(sentence(value).replace(/\.+$/, ""), max);
}

/** Lowercase words without accents or punctuation, for spotting duplicates. */
function textKey(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Same words, or one is the other plus a word or two ("Sleep" and "Sleep quality"). */
function overlaps(a: string, b: string): boolean {
  const ka = textKey(a);
  const kb = textKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const wa = new Set(ka.split(" "));
  const wb = new Set(kb.split(" "));
  const [small, large] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  if (large.size - small.size > 2) return false;
  for (const word of small) if (!large.has(word)) return false;
  return true;
}


function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---------- chart context ----------

const pillarRef = (pillar: number) => `P${pillar + 1}`;
const actionRef = (cell: Cell, prefix = "") => `${prefix}A${cell.pillar + 1}.${cell.slot + 1}`;

/** "a3.5", "A3-5" or "G2.A3.5" in canonical form; "" when it is not an action ref. */
function actionKey(raw: unknown): string {
  const match = text(raw)
    .toUpperCase()
    .replace(/\s+/g, "")
    .match(/^(?:G(\d{1,2})[.:\-_/]?)?A([1-8])[.:\-_/]?([1-8])$/);
  if (!match) return "";
  return `${match[1] ? `G${Number(match[1])}.` : ""}A${match[2]}.${match[3]}`;
}

function pillarFromRef(raw: unknown): number | null {
  const match = text(raw).toUpperCase().match(/^P?([1-8])$/);
  return match ? Number(match[1]) - 1 : null;
}

function namedPillars(goal: GoalWithCells): { pillar: number; text: string }[] {
  const named: { pillar: number; text: string }[] = [];
  for (let p = 0; p < 8; p++) {
    const cell = pillarCell(goal, p);
    if (isFilled(cell)) named.push({ pillar: p, text: oneLine(cell.text, 60) });
  }
  return named;
}

function timeLeft(today: string, deadline: string): string {
  const days = Math.round((Date.parse(deadline) - Date.parse(today)) / 86_400_000);
  if (!Number.isFinite(days)) return "";
  if (days < 0) return "already passed";
  if (days === 0) return "today";
  if (days < 21) return `${days} days left`;
  if (days < 120) return `about ${Math.round(days / 7)} weeks left`;
  return `about ${Math.round(days / 30.4)} months left`;
}

function goalLines(goal: GoalWithCells, today: string): string[] {
  const lines = [`Goal: ${oneLine(goal.title, 200)}`];
  lines.push(goal.deadline ? `Deadline: ${goal.deadline} (${timeLeft(today, goal.deadline)})` : "Deadline: none set");
  if (goal.why.trim()) lines.push(`Why it matters: ${oneLine(goal.why, 280)}`);
  lines.push(`Today: ${today}`);
  return lines;
}

function flags(cell: Cell, checked?: Set<string>): string {
  const list: string[] = [cell.kind];
  if (cell.status === "doing") list.push("in progress");
  if (cell.status === "done") list.push("done");
  if (cell.active) list.push("this week");
  if (cell.kind === "habit" && checked?.has(cell.id)) list.push("already checked");
  return list.join(", ");
}

/** The chart as compact lines with refs; fills `refs` with every listed action. */
function outline(goal: GoalWithCells, refs: Map<string, Cell>, options: { prefix?: string; checked?: Set<string> } = {}) {
  const lines: string[] = [];
  for (let p = 0; p < 8; p++) {
    const pillar = pillarCell(goal, p);
    const actions = actionCells(goal, p).filter(isFilled);
    if (!isFilled(pillar) && !actions.length) continue;
    lines.push(`${pillarRef(p)} ${isFilled(pillar) ? oneLine(pillar.text, 60) : "(pillar not named yet)"}`);
    for (const cell of actions) {
      const ref = actionRef(cell, options.prefix);
      refs.set(ref, cell);
      lines.push(`  ${ref} ${oneLine(cell.text, 140)} (${flags(cell, options.checked)})`);
    }
    if (!actions.length) lines.push("  (no actions yet)");
  }
  return lines;
}

/** The chart as plain text for suggestions: names only, no refs or ids. */
function chartSketch(goal: GoalWithCells, focus: number): string[] {
  const lines: string[] = [];
  for (let p = 0; p < 8; p++) {
    const pillar = pillarCell(goal, p);
    const actions = actionCells(goal, p).filter(isFilled);
    const name = isFilled(pillar) ? oneLine(pillar.text, 60) : "(empty)";
    lines.push(`${pillarRef(p)} ${name}${p === focus ? "   <- suggest actions for this pillar" : ""}`);
    for (const cell of actions) lines.push(`  - ${oneLine(cell.text, 140)} (${cell.kind})`);
  }
  return lines;
}

/** The SuggestionTray asks for more with "Different from: a; b; c". Those become hard exclusions. */
function readHint(hint: string | null | undefined): { already: string[]; note: string } {
  const value = text(hint);
  const match = value.match(/^different from:\s*/i);
  if (!match) return { already: [], note: oneLine(value, 400) };
  return { already: value.slice(match[0].length).split(";").map(item).filter(Boolean).slice(0, 40), note: "" };
}

// ---------- suggest ----------

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

// ---------- sharpen ----------

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

// ---------- leverage ----------

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

// ---------- report analysis ----------

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

// ---------- audio ----------

export const AUDIO_MAX_BYTES = 4 * 1024 * 1024;
export const AUDIO_MIN_BYTES = 1024;

/** Container from the first bytes. More reliable than the browser's label, which varies by version. */
function sniffAudio(head: Uint8Array): string | null {
  const ascii = (from: number, length: number) => String.fromCharCode(...Array.from(head.subarray(from, from + length)));
  if (ascii(0, 4) === "OggS") return "audio/ogg";
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "audio/webm";
  if (ascii(4, 4) === "ftyp") return "audio/mp4";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "audio/wav";
  if (ascii(0, 4) === "fLaC") return "audio/flac";
  if (ascii(0, 4) === "FORM" && /^AIF[FC]$/.test(ascii(8, 4))) return "audio/aiff";
  if (ascii(0, 3) === "ID3") return "audio/mp3";
  if (head[0] === 0xff && (head[1] & 0xf6) === 0xf0) return "audio/aac"; // ADTS
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && (head[1] & 0x06) !== 0) return "audio/mp3";
  return null;
}

// What to send Gemini for each container, best first. A 400 about the type moves to the next one.
const AUDIO_FAMILIES: [RegExp, string[]][] = [
  [/^(audio\/(mp4|x-m4a|m4a|mp4a-latm)|video\/mp4)$/, ["audio/mp4", "audio/m4a", "audio/aac"]],
  [/^(audio\/(webm|x-matroska)|video\/webm)$/, ["audio/webm", "audio/ogg"]],
  [/^audio\/(ogg|opus|x-opus)$/, ["audio/ogg"]],
  [/^audio\/(mpeg|mp3|mpeg3|x-mpeg|x-mp3)$/, ["audio/mp3", "audio/mpeg"]],
  [/^audio\/(wav|x-wav|wave|vnd\.wave)$/, ["audio/wav"]],
  [/^audio\/(aac|x-aac|aacp)$/, ["audio/aac"]],
  [/^audio\/(flac|x-flac)$/, ["audio/flac"]],
  [/^audio\/(aiff|x-aiff)$/, ["audio/aiff"]],
];

/** MIME types to try for an upload, best first; null when it is not audio. */
export function audioMimeTypes(declared: string, head: Uint8Array): string[] | null {
  const type = declared.split(";")[0].trim().toLowerCase();
  const sniffed = sniffAudio(head);
  if (!sniffed) {
    const labeledAudio = type.startsWith("audio/") || /^video\/(webm|mp4)$/.test(type);
    if (!labeledAudio) return null;
  }
  const base = sniffed ?? type;
  for (const [pattern, types] of AUDIO_FAMILIES) if (pattern.test(base)) return types;
  return [base];
}

// 422: sending the same audio again cannot help, so the client offers "Record again".
const NO_SPEECH = "No speech found in that recording. Record again, or type it instead.";
const UNREADABLE_AUDIO = "Could not read that recording. Record again, or type it instead.";

export async function analyzeReport(
  scope: ReportScope,
  report: { text: string } | { audio: Uint8Array; mimeTypes: string[] },
): Promise<ReportAnalysis> {
  if ("text" in report) {
    const prompt = analyzePrompt(scope, { text: report.text });
    return run(prompt, [{ text: prompt.text }], { budgetMs: 50_000, attemptMs: 35_000, maxOutputTokens: 8_192 });
  }

  const prompt = analyzePrompt(scope, { audio: true });
  const data = Buffer.from(report.audio).toString("base64");
  const deadline = Date.now() + 55_000;
  let rejected: AiError | undefined;
  for (const mimeType of report.mimeTypes) {
    try {
      // A 5-minute report usually takes 5-15 s; the cap leaves a fallback model real time.
      const result = await run(prompt, [{ inlineData: { mimeType, data } }, { text: prompt.text }], {
        deadline,
        attemptMs: 38_000,
        maxOutputTokens: 12_288,
      });
      if (!result.transcript) throw new HttpError(422, NO_SPEECH);
      return result;
    } catch (error) {
      // A 400 about the audio itself: the same bytes may pass under another label.
      const aboutAudio = error instanceof AiError && error.reason === "input" && error.status === 400;
      if (!aboutAudio) throw error;
      rejected = error;
    }
  }
  throw new AiError(UNREADABLE_AUDIO, 422, "input", rejected?.detail);
}

// ---------- running a prompt ----------

function run<T>(
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
