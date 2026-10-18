import { ApiError } from "@/client/api";
import { addDays, dayKey, isFilled, PILLAR_SLOT, pillarCell } from "@/domain/mandala";
import type { Cell, Checkin, GoalWithCells, ProposedUpdate, ReportSource } from "@/domain/types";
import type { MicProblem } from "./useVoiceRecorder";

export interface CellInfo {
  goal: GoalWithCells;
  pillar: Cell | undefined;
  cell: Cell;
}

export function indexCells(goals: GoalWithCells[]): Map<string, CellInfo> {
  const map = new Map<string, CellInfo>();
  for (const goal of goals) {
    for (const cell of goal.cells) map.set(cell.id, { goal, pillar: pillarCell(goal, cell.pillar), cell });
  }
  return map;
}

export interface ReviewItem {
  update: ProposedUpdate;
  checked: boolean;
}

/**
 * Two proposals for one square. As on the server, confidence and quote come from the side behind
 * the change that is kept (status, else check-in), so a sure note cannot pre-check a stray change.
 */
function merge(a: ProposedUpdate, b: ProposedUpdate): ProposedUpdate {
  const status = b.status ?? a.status;
  const checkin = a.checkin || b.checkin;
  const backing = [a, b].filter((u) => (status ? u.status === status : checkin ? u.checkin : true));
  const best = backing.reduce((x, y) => ((y.confidence ?? 1) > (x.confidence ?? 1) ? y : x));
  return {
    cellId: a.cellId,
    status,
    checkin,
    note: [a.note, b.note].filter(Boolean).join(" · ") || undefined,
    quote: best.quote,
    confidence: best.confidence ?? 1,
  };
}

/**
 * Checks the proposals against the chart as it is now: one row per square, unknown squares
 * and changes the chart already has are dropped, and unsure ones start unchecked.
 */
export function reviewItems(
  updates: ProposedUpdate[],
  cells: Map<string, CellInfo>,
  checkins: Checkin[],
  day: string,
): ReviewItem[] {
  const merged = new Map<string, ProposedUpdate>();
  for (const update of updates) {
    const info = cells.get(update.cellId);
    if (!info || info.cell.slot === PILLAR_SLOT || !isFilled(info.cell)) continue;
    const previous = merged.get(update.cellId);
    merged.set(update.cellId, previous ? merge(previous, update) : update);
  }

  const items: ReviewItem[] = [];
  for (const update of merged.values()) {
    const cell = cells.get(update.cellId)!.cell;
    const habit = cell.kind === "habit";
    const checkedAlready = checkins.some((c) => c.cellId === cell.id && c.day === day);
    // A report never finishes a habit: "done" on a habit means it was done that day.
    const checkin = habit && (update.checkin || update.status === "done") && !checkedAlready;
    const status = !habit && update.status && update.status !== cell.status ? update.status : undefined;
    const note = update.note?.trim().slice(0, 500) || undefined;
    if (!checkin && !status && !note) continue;
    // Missing means sure, as in the save schema; a broken number means unsure.
    const raw: unknown = update.confidence;
    const confidence = typeof raw !== "number" ? 1 : Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
    items.push({
      update: {
        cellId: cell.id,
        status,
        checkin: checkin || undefined,
        note,
        quote: (update.quote ?? "").trim().slice(0, 500),
        confidence,
      },
      checked: confidence >= 0.6,
    });
  }
  return items;
}

export function changeLabel(update: ProposedUpdate, day: string, today: string): string {
  if (update.checkin) return day === today ? "Done today" : day === addDays(today, -1) ? "Done yesterday" : "Done";
  if (update.status === "done") return "Done";
  if (update.status === "doing") return "Doing";
  if (update.status === "todo") return "To do";
  return "Note";
}

export interface Failure {
  message: string;
  /** Sending the same thing again may work (offline, busy). */
  retry: boolean;
}

export function analyzeFailure(error: unknown, source: ReportSource): Failure {
  if (!(error instanceof ApiError)) return { message: "Something went wrong. Try again.", retry: true };
  if (error.offline) {
    return {
      message:
        source === "voice"
          ? "You're offline. Your recording is kept here, so try again when you're back."
          : "You're offline. Try again when you're back.",
      retry: true,
    };
  }
  // The server's messages are written for people, so show them. Sending the same thing again
  // cannot fix a recording that is too long (413), not audio (415), silent, unreadable or
  // blocked (422), or AI being off (503).
  const message = error.message || "Something went wrong. Try again.";
  return { message, retry: ![413, 415, 422, 503].includes(error.status) };
}

export function micMessage(problem: MicProblem): { message: string; hint?: string } {
  switch (problem) {
    case "denied":
      return { message: "The microphone is blocked.", hint: "Allow it for this site in your browser settings, then tap again." };
    case "missing":
      return { message: "No microphone found.", hint: "Connect one and tap again." };
    case "busy":
      return { message: "The microphone is busy.", hint: "Another app may be using it. Tap to try again." };
    case "insecure":
      return { message: "Voice needs a secure (https) connection." };
    case "unsupported":
      return { message: "This browser can't record audio." };
    default:
      return { message: "Could not start the microphone.", hint: "Tap to try again." };
  }
}

/** Why voice is off, or null when it is available. */
export function voiceOffReason(aiEnabled: boolean, support: "ok" | "insecure" | "unsupported"): string | null {
  if (!aiEnabled) return "Voice reports are off right now.";
  if (support === "insecure") return "Voice needs a secure (https) connection.";
  if (support === "unsupported") return "This browser can't record audio.";
  return null;
}

/** A "." after one of these, or after a lone letter ("J.", "p.m.", "e.g."), does not end a sentence. */
const NOT_AN_END = /(?:^|[^\p{L}\p{N}])(?:dr|mr|mrs|ms|st|vs|etc|jr|sr|prof|approx|no|\p{L})\.$/iu;

/** A summary for a report saved without AI: its first sentence, or the first line when none fits. */
export function quickSummary(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  let sentence = line;
  for (const match of line.matchAll(/[.!?](?=\s|$)/g)) {
    const head = line.slice(0, match.index + 1);
    // Too short to say much on its own ("Done."), or an abbreviation: keep reading.
    if (head.length < 20 || (match[0] === "." && NOT_AN_END.test(head))) continue;
    sentence = head;
    break;
  }
  return sentence.length > 160 ? `${sentence.slice(0, 157).trimEnd()}…` : sentence;
}

/** Reports made late at night (before 3 am) are about the day that just ended. */
export function defaultReportDay(): string {
  const now = new Date();
  const today = dayKey(now);
  return now.getHours() < 3 ? addDays(today, -1) : today;
}

export function clock(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
