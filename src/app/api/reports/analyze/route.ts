import { NextResponse, type NextRequest } from "next/server";
import {
  analyzeReport,
  analyzeTextSchema,
  AUDIO_MAX_BYTES,
  AUDIO_MIN_BYTES,
  audioMimeTypes,
  type ReportScope,
} from "@/server/ai";
import { requireAi } from "@/server/ai/gemini";
import { HttpError, readJson, route } from "@/server/http";
import { dayKey } from "@/domain/mandala";
import { useQuota } from "@/server/quota";
import { loadState } from "@/server/repo";
import type { GoalWithCells } from "@/domain/types";
import { daySchema } from "@/domain/validators";

// A voice report can take a while: upload, transcription and matching in one Gemini call.
export const maxDuration = 60;

const TOO_BIG = "That recording is too long to send. Try a shorter one, or type it instead.";

// Transcribes a voice report (multipart: audio, day, goalId?) or reads a typed one
// (JSON: text, day, goalId?) and proposes chart updates. Nothing is saved here: the client
// reviews the proposal and saves it through /api/reports. Audio is never stored or logged.
// The input is checked first and the quota next, so neither bad input nor a refused call
// costs a read of the whole chart.
export const POST = route(async (request, _context, user) => {
  requireAi();
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const upload = await readUpload(request);
    await useQuota(user.id, "report");
    const scope = await reportScope(user.id, upload.goalId, upload.day);
    return NextResponse.json(await analyzeReport(scope, { audio: upload.audio, mimeTypes: upload.mimeTypes }));
  }

  if (contentType.includes("application/json")) {
    const input = await readJson(request, analyzeTextSchema);
    const text = input.text.trim();
    if (!text) throw new HttpError(400, "Write a few words first.");
    await useQuota(user.id, "report");
    const scope = await reportScope(user.id, input.goalId ?? null, input.day);
    return NextResponse.json(await analyzeReport(scope, { text }));
  }

  throw new HttpError(415, "Send a recording or some text.");
});

async function readUpload(request: NextRequest) {
  // Refuse big uploads before reading them (multipart adds a little on top of the file).
  if (Number(request.headers.get("content-length")) > AUDIO_MAX_BYTES + 64 * 1024) {
    throw new HttpError(413, TOO_BIG);
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(400, "The recording did not arrive in one piece. Try again.");
  }
  const file = form.get("audio");
  if (!file || typeof file === "string") throw new HttpError(400, "No recording came through. Try again.");
  if (file.size > AUDIO_MAX_BYTES) throw new HttpError(413, TOO_BIG);
  if (file.size < AUDIO_MIN_BYTES) throw new HttpError(400, "That recording is too short. Try again.");

  const audio = new Uint8Array(await file.arrayBuffer());
  const mimeTypes = audioMimeTypes(file.type, audio.subarray(0, 16));
  if (!mimeTypes) throw new HttpError(415, "That file is not audio. Record again, or type it instead.");

  const day = daySchema.safeParse(form.get("day"));
  const goalId = form.get("goalId");
  return {
    audio,
    mimeTypes,
    // The client always sends its local day; the server's day is only a fallback.
    day: day.success ? day.data : dayKey(),
    goalId: typeof goalId === "string" && goalId.trim() ? goalId.trim() : null,
  };
}

/**
 * One goal, or every active goal when the report is general (or its goal was just deleted),
 * most recently active first: the prompt takes only as many whole goals as fit its size budget.
 */
async function reportScope(userId: string, goalId: string | null, day: string): Promise<ReportScope> {
  const state = await loadState(userId, day); // check-ins from the report day on: enough to know what is already checked
  const scoped = goalId ? state.goals.find((goal) => goal.id === goalId) : undefined;
  return {
    goals: scoped ? [scoped] : byRecentActivity(state.goals.filter((goal) => goal.status === "active")),
    checkins: state.checkins,
    day,
  };
}

/** Goals with open actions on this week first, then the most recently edited (the goal or any square). */
function byRecentActivity(goals: GoalWithCells[]): GoalWithCells[] {
  const ranked = goals.map((goal) => ({
    goal,
    onWeek: goal.cells.some((cell) => cell.active && cell.status !== "done"),
    edited: goal.cells.reduce((latest, cell) => (cell.updatedAt > latest ? cell.updatedAt : latest), goal.updatedAt),
  }));
  ranked.sort((a, b) => Number(b.onWeek) - Number(a.onWeek) || b.edited.localeCompare(a.edited));
  return ranked.map((entry) => entry.goal);
}
