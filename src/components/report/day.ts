import { addDays, dayKey } from "@/domain/mandala";

/** A "." after one of these, or after a lone letter ("J.", "p.m.", "e.g."), does not end a sentence. */
const NOT_AN_END = /(?:^|[^\p{L}\p{N}])(?:dr|mr|mrs|ms|st|vs|etc|jr|sr|prof|approx|no|\p{L})\.$/iu;

/** A report's summary: its first sentence, or the first line when none fits. */
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
