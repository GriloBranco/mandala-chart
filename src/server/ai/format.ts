import "server-only";

// Small helpers for the answer schemas (only keywords Gemini supports) and for cleaning text.

export type Schema = Record<string, unknown>;

export function str(description?: string): Schema {
  return description ? { type: "string", description } : { type: "string" };
}

export function rating(description: string): Schema {
  return { type: "integer", minimum: 1, maximum: 3, description };
}

export function list(items: Schema, extra: { minItems?: number; maxItems?: number; description?: string } = {}): Schema {
  return { type: "array", items, ...extra };
}

export function obj(properties: Record<string, Schema>, required = Object.keys(properties)): Schema {
  return { type: "object", properties, required, propertyOrdering: Object.keys(properties) };
}

export function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/** Cuts at a word boundary and adds an ellipsis. */
export function fit(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, "")}…`;
}

export function oneLine(value: string, max: number): string {
  return fit(text(value), max);
}

const EMOJI = /[\p{Extended_Pictographic}\u200d\ufe0f]/gu;
const QUOTE_PAIRS: Record<string, string> = { '"': '"', "'": "'", "“": "”", "‘": "’", "«": "»", "„": "“" };

/** A short item the model wrote: no list marker, wrapping quotes, emoji or end punctuation. */
export function item(value: unknown): string {
  let out = text(value).replace(EMOJI, "").replace(/^(?:[-*•·]|\d+[.)])\s+/, "").trim();
  const close = QUOTE_PAIRS[out[0]];
  if (close && out.length > 2 && out.endsWith(close)) out = out.slice(1, -1).trim();
  out = out.replace(/!+/g, "").trim();
  // Keep "p.m." intact; drop a plain trailing period.
  if (!/\b\p{L}\.\p{L}\.$/u.test(out)) out = out.replace(/\.+$/, "");
  return out.trim();
}

/** A sentence the model wrote: calm punctuation, no emoji. */
export function sentence(value: unknown): string {
  return text(value).replace(EMOJI, "").replace(/!+/g, ".").replace(/\s+([.,;:])/g, "$1").trim();
}

/** A short phrase (reason, note, issue): a sentence without the final period. */
export function phrase(value: unknown, max: number): string {
  return fit(sentence(value).replace(/\.+$/, ""), max);
}

/** Lowercase words without accents or punctuation, for spotting duplicates. */
export function textKey(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Same words, or one is the other plus a word or two ("Sleep" and "Sleep quality"). */
export function overlaps(a: string, b: string): boolean {
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

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
