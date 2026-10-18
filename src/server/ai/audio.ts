import "server-only";
import { AiError } from "./gemini";
import { HttpError } from "@/server/http";
import type { ReportAnalysis } from "@/domain/types";
import type { ReportScope } from "./inputs";
import { analyzePrompt } from "./reports";
import { run } from "./run";

// Voice reports: checks the audio and sends it inline to Gemini. Audio is never stored.

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
