import "server-only";
import { actionCells, isFilled, pillarCell } from "@/domain/mandala";
import type { Cell, GoalWithCells } from "@/domain/types";
import { item, oneLine, text } from "./format";

// How a goal is shown to the model: short refs (P3, A3.5) instead of ids, and a sketch of the chart.

export const pillarRef = (pillar: number) => `P${pillar + 1}`;
const actionRef = (cell: Cell, prefix = "") => `${prefix}A${cell.pillar + 1}.${cell.slot + 1}`;

/** "a3.5", "A3-5" or "G2.A3.5" in canonical form; "" when it is not an action ref. */
export function actionKey(raw: unknown): string {
  const match = text(raw)
    .toUpperCase()
    .replace(/\s+/g, "")
    .match(/^(?:G(\d{1,2})[.:\-_/]?)?A([1-8])[.:\-_/]?([1-8])$/);
  if (!match) return "";
  return `${match[1] ? `G${Number(match[1])}.` : ""}A${match[2]}.${match[3]}`;
}

export function pillarFromRef(raw: unknown): number | null {
  const match = text(raw).toUpperCase().match(/^P?([1-8])$/);
  return match ? Number(match[1]) - 1 : null;
}

export function namedPillars(goal: GoalWithCells): { pillar: number; text: string }[] {
  const named: { pillar: number; text: string }[] = [];
  for (let p = 0; p < 8; p++) {
    const cell = pillarCell(goal, p);
    if (isFilled(cell)) named.push({ pillar: p, text: oneLine(cell.text, 60) });
  }
  return named;
}

export function timeLeft(today: string, deadline: string): string {
  const days = Math.round((Date.parse(deadline) - Date.parse(today)) / 86_400_000);
  if (!Number.isFinite(days)) return "";
  if (days < 0) return "already passed";
  if (days === 0) return "today";
  if (days < 21) return `${days} days left`;
  if (days < 120) return `about ${Math.round(days / 7)} weeks left`;
  return `about ${Math.round(days / 30.4)} months left`;
}

export function goalLines(goal: GoalWithCells, today: string): string[] {
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
export function outline(goal: GoalWithCells, refs: Map<string, Cell>, options: { prefix?: string; checked?: Set<string> } = {}) {
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
export function chartSketch(goal: GoalWithCells, focus: number): string[] {
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
export function readHint(hint: string | null | undefined): { already: string[]; note: string } {
  const value = text(hint);
  const match = value.match(/^different from:\s*/i);
  if (!match) return { already: [], note: oneLine(value, 400) };
  return { already: value.slice(match[0].length).split(";").map(item).filter(Boolean).slice(0, 40), note: "" };
}
