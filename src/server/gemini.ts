import "server-only";
import { GoogleGenAI, ThinkingLevel, type GenerateContentResponse, type Part } from "@google/genai";
import { aiAllowed } from "./quota";

// Server-only Gemini access. The key never reaches the browser. Every call is one stateless
// generateContent request with any audio inline (never the Files API), so Google keeps no file.
// Nothing here logs prompts, transcripts or audio: only the model, the status and Google's error text.

const DEFAULT_MODELS = ["gemini-3.8-flash", "gemini-flash-latest", "gemini-3.6-flash", "gemini-3.5-flash-lite"];

/** No new attempt starts with less time than this left; it would only time out. */
const MIN_ATTEMPT_MS = 6_000;
/**
 * Unusable answers (cut off, broken, nothing usable) one call takes before it gives up. Each one
 * is billed for the whole prompt, so the fallback models get one more try, not three.
 */
const MAX_UNUSABLE_ANSWERS = 2;
/** A model that answered 404 is skipped for this long instead of costing a round trip on every call. */
const MISSING_MODEL_MS = 30 * 60_000;

// Per server instance, to save round trips on later calls.
const missingSince = new Map<string, number>();
const noThinkingLevel = new Set<string>();

const MESSAGES = {
  off: "AI is off. Add GEMINI_API_KEY to turn it on.",
  busy: "AI is busy right now. Try again in a minute.",
  timeout: "AI took too long to answer. Try again.",
  unavailable: "AI is not answering right now. Try again in a moment.",
  auth: "The Gemini key was rejected. Check GEMINI_API_KEY.",
  region: "Gemini is not available from this server's region.",
  input: "AI could not read that. Try again.",
  tooBig: "That is too much to send in one go. Try a shorter one.",
  blocked: "AI could not answer this one. Try rewording it.",
  output: "AI sent back something unexpected. Try again.",
  models: "No Gemini model is available. Set GEMINI_MODEL.",
  paused: "AI is off for now.",
};

let client: GoogleGenAI | undefined;

function apiKey(): string | undefined {
  return (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    undefined
  );
}

/** False without a key, or when AI_GLOBAL_DAILY_LIMIT is 0; the app then hides AI. */
export function aiEnabled(): boolean {
  return Boolean(apiKey()) && aiAllowed();
}

export type AiErrorReason = "off" | "busy" | "timeout" | "unavailable" | "auth" | "input" | "blocked" | "output";

export class AiError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly reason: AiErrorReason = "unavailable",
    /** Google's own error text, for retry decisions and logs. Never sent to the browser. */
    readonly detail = "",
  ) {
    super(message);
  }
}

/** Fails fast with the friendly 503 before any slow work (reading uploads, the database). */
export function requireAi(): void {
  if (!apiKey()) throw new AiError(MESSAGES.off, 503, "off");
  if (!aiAllowed()) throw new AiError(MESSAGES.paused, 503, "off");
}

function getClient(): GoogleGenAI {
  const key = apiKey();
  if (!key) throw new AiError(MESSAGES.off, 503, "off");
  client ??= new GoogleGenAI({ apiKey: key });
  return client;
}

/** GEMINI_MODEL (one name, or a comma list) replaces the primary; the fallbacks stay behind it. */
function modelChain(): string[] {
  const preferred = (process.env.GEMINI_MODEL ?? "")
    .split(",")
    .map((m) => m.trim().replace(/^models\//, ""))
    .filter(Boolean);
  const all = [...new Set(preferred.length ? [...preferred, ...DEFAULT_MODELS.slice(1)] : DEFAULT_MODELS)];
  const now = Date.now();
  const live = all.filter((m) => (missingSince.get(m) ?? 0) < now - MISSING_MODEL_MS);
  return live.length ? live : all;
}

/**
 * Gemini 3 takes a thinking level (low keeps answers fast) and wants its default temperature.
 * The -latest aliases point at Gemini 3 too; if one ever rejects the level, we drop it.
 */
function isGemini3(model: string): boolean {
  return /^gemini-3/.test(model) || /-latest$/.test(model);
}

export interface JsonRequest<T> {
  /** Short label for logs, e.g. "leverage". */
  task: string;
  system: string;
  parts: Part[];
  /** Plain JSON Schema for structured output. */
  schema: object;
  /** Validates and repairs the parsed answer. Throwing marks it unusable, so the next model gets a try. */
  parse: (data: unknown) => T;
  /** Absolute time (ms) after which no new attempt starts. */
  deadline: number;
  /** Longest single attempt, so one stuck model still leaves time for the next. */
  attemptMs?: number;
  /** Only sent to models before Gemini 3. */
  temperature?: number;
  maxOutputTokens?: number;
}

/**
 * One JSON answer from the first model that gives a usable one.
 * 404 (model gone), 429 (each model has its own quota), 5xx, timeouts and broken answers move on
 * to the next model; a 400 about the thinking config retries the same model without it; other
 * 400s and key problems stop at once, because another model would fail the same way. A second
 * unusable answer also stops, so one call never pays for the whole prompt more than twice.
 */
export async function generateJson<T>(request: JsonRequest<T>): Promise<T> {
  const ai = getClient();
  let failure: AiError | undefined;
  let unusable = 0;

  for (const model of modelChain()) {
    let thinking = isGemini3(model) && !noThinkingLevel.has(model);
    for (;;) {
      const remaining = request.deadline - Date.now();
      if (remaining < MIN_ATTEMPT_MS) throw failure ?? new AiError(MESSAGES.timeout, 504, "timeout");

      let response: GenerateContentResponse;
      try {
        response = await ai.models.generateContent({
          model,
          contents: [{ role: "user", parts: request.parts }],
          config: {
            systemInstruction: request.system,
            responseMimeType: "application/json",
            responseJsonSchema: request.schema,
            maxOutputTokens: request.maxOutputTokens ?? 16_384,
            ...(isGemini3(model) ? {} : { temperature: request.temperature }),
            ...(thinking ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
            httpOptions: { timeout: Math.min(remaining, request.attemptMs ?? remaining) },
          },
        });
      } catch (error) {
        const status = upstreamStatus(error);
        const detail = upstreamMessage(error);
        if (status === 400 && thinking && /thinking/i.test(detail)) {
          noThinkingLevel.add(model);
          thinking = false;
          continue;
        }
        warn(request.task, model, status ?? errorName(error), detail);
        if (status === 404) {
          missingSince.set(model, Date.now());
          break;
        }
        const problem = toAiError(error, status, detail);
        if (problem.status === 400 && problem.reason === "input" && /schema|json|thinking/i.test(detail)) {
          // This model does not take our config; another one may.
          failure = new AiError(MESSAGES.unavailable, 502, "unavailable", detail);
          break;
        }
        if (problem.reason === "input" || problem.reason === "auth") throw problem;
        failure = problem;
        break;
      }

      try {
        return request.parse(readAnswer(response));
      } catch (error) {
        const problem = error instanceof AiError ? error : new AiError(MESSAGES.output, 502, "output");
        warn(request.task, model, problem.reason, problem.detail || errorName(error));
        if (problem.reason === "blocked") throw problem;
        unusable += 1;
        if (unusable >= MAX_UNUSABLE_ANSWERS) throw problem;
        failure = problem;
        break;
      }
    }
  }
  throw failure ?? new AiError(MESSAGES.models, 502, "unavailable");
}

const BLOCKED = new Set<string>(["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"]);

function readAnswer(response: GenerateContentResponse): unknown {
  const finish = response.candidates?.[0]?.finishReason;
  if (response.promptFeedback?.blockReason || (finish && BLOCKED.has(finish))) {
    throw new AiError(MESSAGES.blocked, 422, "blocked", `blocked (${response.promptFeedback?.blockReason ?? finish})`);
  }
  const text = response.text?.trim();
  if (!text) throw new AiError(MESSAGES.output, 502, "output", `empty answer (${finish ?? "no candidate"})`);
  try {
    // Structured output is plain JSON, but a stray code fence costs nothing to strip.
    return JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch {
    throw new AiError(MESSAGES.output, 502, "output", `broken JSON (${finish ?? "no finish reason"})`);
  }
}

function toAiError(error: unknown, status: number | undefined, detail: string): AiError {
  if (status === 400 && /api[ _-]?key/i.test(detail)) return new AiError(MESSAGES.auth, 502, "auth", detail);
  if (status === 400 && /location is not supported/i.test(detail)) return new AiError(MESSAGES.region, 502, "auth", detail);
  if (status === 413 || (status === 400 && /payload size|too large|exceeds the (maximum|limit)/i.test(detail))) {
    return new AiError(MESSAGES.tooBig, 413, "input", detail);
  }
  if (status === 400) return new AiError(MESSAGES.input, 400, "input", detail);
  if (status === 401 || status === 403) return new AiError(MESSAGES.auth, 502, "auth", detail);
  if (status === 429) return new AiError(MESSAGES.busy, 429, "busy", detail);
  if (status === 408 || status === 504 || /abort|timeout/i.test(errorName(error))) {
    return new AiError(MESSAGES.timeout, 504, "timeout", detail);
  }
  // 5xx, network failures and anything unexpected.
  return new AiError(MESSAGES.unavailable, 502, "unavailable", detail);
}

function upstreamStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/** The SDK puts Google's JSON error body in the message; this pulls out the readable part. */
function upstreamMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") return parsed.error.message;
  } catch {
    // Not JSON: use it as is.
  }
  return raw;
}

function errorName(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : "Error";
}

function warn(task: string, model: string, what: string | number, detail: string) {
  console.warn(`[ai] ${task} on ${model}: ${what}${detail ? ` (${detail.slice(0, 180)})` : ""}`);
}
