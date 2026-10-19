// Local calendar days as YYYY-MM-DD strings. Shared by the chart rules and the routine schedule.

/** Local calendar day as YYYY-MM-DD. */
export function dayKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function dayDate(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(day: string, delta: number): string {
  const date = dayDate(day);
  date.setDate(date.getDate() + delta);
  return dayKey(date);
}
