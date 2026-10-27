import { describe, expect, it } from "vitest";
import { addDays, PILLAR_SLOT } from "@/domain/mandala";
import {
  cellIdFrom,
  checkinMove,
  cleanText,
  completionDay,
  describe as withFooter,
  dueDay,
  dueTime,
  isTimeZone,
  localDay,
  notesFrom,
  repeatString,
  routineDueDay,
  scheduleFromDue,
  squareLink,
  taskPriority,
  TEXT_MAX,
  todoistShape,
  weekEnd,
} from "@/domain/todoist";
import type { Cell, Checkin, GoalWithCells, Repeat } from "@/domain/types";
import { todoistSyncSchema } from "@/domain/validators";
import { sampleGoal } from "../support/goal";

// Dates used below: 2026-10-25 is a Sunday, so 2026-10-28 is a Wednesday.

const APP = "https://mandaala.online";

function habit(overrides: Partial<Cell> = {}): Cell {
  return {
    id: "h",
    goalId: "g1",
    pillar: 0,
    slot: 0,
    text: "Stretch",
    notes: "",
    kind: "habit",
    repeat: "day",
    repeatOn: null,
    status: "todo",
    progress: 0,
    impact: null,
    effort: null,
    helps: [],
    active: true,
    activatedAt: "2026-09-01T12:00:00.000Z",
    doneAt: null,
    updatedAt: "2026-09-01T12:00:00.000Z",
    ...overrides,
  };
}

const check = (...days: string[]): Checkin[] => days.map((day) => ({ cellId: "h", goalId: "g1", day }));

/** A square of the sample goal, changed by `patch`. */
function square(goal: GoalWithCells, id: string, patch: Partial<Cell> = {}): Cell {
  const cell = goal.cells.find((c) => c.id === id);
  if (!cell) throw new Error(`No square ${id}`);
  return Object.assign(cell, patch);
}

describe("a square in Todoist", () => {
  it("sends a picked routine as a repeating task with the footer", () => {
    const goal = sampleGoal();
    const cell = square(goal, "cell-0-0", { text: "  Action 1.1  " });
    expect(todoistShape(goal, cell, APP)).toEqual({
      content: "Action 1.1",
      description:
        "Reading habit · By June 2027, I will read 20 books · [Open in Mandaala](https://mandaala.online/?g=goal-1&p=0&c=cell-0-0)",
      priority: 1,
      repeat: "every day",
      completed: false,
    });
  });

  it("sends a picked task with its notes and priority, completed once done", () => {
    const goal = sampleGoal();
    const cell = square(goal, "cell-1-1", { active: true, notes: "  Chapters 1-3 ", status: "done" });
    expect(todoistShape(goal, cell, APP)).toEqual({
      content: "Action 2.2",
      description:
        "Chapters 1-3\n\n---\nBook list · By June 2027, I will read 20 books · [Open in Mandaala](https://mandaala.online/?g=goal-1&p=1&c=cell-1-1)",
      priority: 2,
      repeat: null,
      completed: true,
    });
  });

  it("writes the routine's repeat and marks a routine done for good as completed", () => {
    const goal = sampleGoal();
    const cell = square(goal, "cell-0-0", { repeat: "week", repeatOn: 2, status: "done" });
    expect(todoistShape(goal, cell, APP)).toMatchObject({ repeat: "every tuesday", completed: true });
  });

  it("leaves out what is not on Today", () => {
    const goal = sampleGoal();
    // Not picked, a pillar, an empty square, a blank one.
    expect(todoistShape(goal, square(goal, "cell-0-1"), APP)).toBeNull();
    expect(todoistShape(goal, square(goal, `cell-0-${PILLAR_SLOT}`, { active: true }), APP)).toBeNull();
    expect(todoistShape(goal, square(goal, "cell-0-5", { active: true }), APP)).toBeNull();
    expect(todoistShape(goal, square(goal, "cell-0-6", { active: true, text: "   " }), APP)).toBeNull();
    for (const status of ["achieved", "archived"] as const) {
      expect(todoistShape({ ...goal, status }, square(goal, "cell-0-0"), APP)).toBeNull();
    }
  });

  it("names an unnamed pillar by its number", () => {
    const goal = sampleGoal();
    const cell = square(goal, "cell-4-0", { text: "Walk" });
    expect(todoistShape(goal, cell, APP)?.description).toMatch(/^Pillar 5 · By June 2027/);
  });
});

describe("repeat strings", () => {
  const repeatOf = (repeat: Repeat, repeatOn: number | null) => repeatString({ repeat, repeatOn });

  it("writes daily and weekly repeats in English", () => {
    expect(repeatOf("day", null)).toBe("every day");
    expect([0, 1, 2, 3, 4, 5, 6].map((on) => repeatOf("week", on))).toEqual([
      "every sunday",
      "every monday",
      "every tuesday",
      "every wednesday",
      "every thursday",
      "every friday",
      "every saturday",
    ]);
    // A weekly routine saved without a day counts as Sunday, as everywhere else.
    expect(repeatOf("week", null)).toBe("every sunday");
  });

  it("writes month days as ordinals and the 31st as the last day", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 29, 30].map((on) => repeatOf("month", on))).toEqual([
      "every 1st",
      "every 2nd",
      "every 3rd",
      "every 4th",
      "every 11th",
      "every 12th",
      "every 13th",
      "every 21st",
      "every 22nd",
      "every 23rd",
      "every 29th",
      "every 30th",
    ]);
    expect(repeatOf("month", 31)).toBe("every last day");
    expect(repeatOf("month", null)).toBe("every 1st");
  });
});

describe("priority from leverage", () => {
  const priority = (impact: number | null, effort: number | null, helps: number[] = []) =>
    taskPriority(habit({ impact, effort, helps }));

  it("stays normal until rated", () => {
    expect(priority(null, null)).toBe(1);
    expect(priority(null, 1, [1, 2])).toBe(1);
  });

  it("gives p3 from a third of the scale and p2 from two thirds, never p1", () => {
    expect(priority(1, 3)).toBe(1); // 1
    expect(priority(2, 2, [1])).toBe(1); // 8
    expect(priority(3, 1)).toBe(2); // 9
    expect(priority(2, 2, [1, 2, 3])).toBe(2); // 16
    expect(priority(3, 1, [1])).toBe(3); // 18
    expect(priority(3, 1, [1, 2, 3, 4, 5, 6, 7])).toBe(3); // 72
  });
});

describe("square text from Todoist", () => {
  it("keeps one trimmed line", () => {
    expect(cleanText("  Run 5 km  ")).toBe("Run 5 km");
    expect(cleanText("Run\n5 km")).toBe("Run 5 km");
    expect(cleanText("Run \r\n\r\n 5 km\n")).toBe("Run 5 km");
  });

  it("cuts at the square's limit without splitting an emoji", () => {
    expect(TEXT_MAX).toBe(200);
    expect(cleanText("x".repeat(250))).toBe("x".repeat(200));
    expect(cleanText("x".repeat(199) + " tail")).toBe("x".repeat(199));
    expect(cleanText("x".repeat(199) + "🏃 run")).toBe("x".repeat(199));
  });
});

describe("the footer", () => {
  const link = squareLink(APP, "goal-1", 2, "cell-2-0");
  const context = { pillar: "Skin", goal: "LOOKSMAXXING", link };
  const footer = "Skin · LOOKSMAXXING · [Open in Mandaala](https://mandaala.online/?g=goal-1&p=2&c=cell-2-0)";
  const room = 16000 - footer.length - "\n\n---\n".length;

  it("links back to the square", () => {
    expect(link).toBe("https://mandaala.online/?g=goal-1&p=2&c=cell-2-0");
  });

  it("puts the notes above a separator and the footer", () => {
    expect(withFooter("", context)).toBe(footer);
    expect(withFooter("  \n ", context)).toBe(footer);
    expect(withFooter("  Morning routine  ", context)).toBe(`Morning routine\n\n---\n${footer}`);
  });

  it("gives back the notes it was given", () => {
    const notes = [
      "",
      "Morning routine",
      "  padded  ",
      "line 1\nline 2\n\nline 4",
      "ends with a rule\n---",
      "---",
      "- [ ] open\n- [x] done",
      `quotes [another square](${squareLink(APP, "goal-9", 1, "cell-9")}) here`,
      "\n\nleading blank lines",
      "trailing blank lines\n\n\n",
      "Corrida 🏃 às 6h, café ☕",
    ];
    for (const note of notes) expect(notesFrom(withFooter(note, context), APP), note).toBe(note.trim());
  });

  it("reads notes the person edited in Todoist", () => {
    expect(notesFrom(`New notes\n\n---\n${footer}`, APP)).toBe("New notes");
    // The separator removed, Windows line ends, or the rule written another way.
    expect(notesFrom(`New notes\n${footer}`, APP)).toBe("New notes");
    expect(notesFrom(`New notes\r\n\r\n---\r\n${footer}`, APP)).toBe("New notes");
    expect(notesFrom(`New notes\n\n***\n${footer}`, APP)).toBe("New notes");
    expect(notesFrom(footer, APP)).toBe("");
    // No footer: it is all notes.
    expect(notesFrom("  Just notes\n---  ", APP)).toBe("Just notes\n---");
  });

  it("keeps notes typed below the footer in Todoist", () => {
    expect(notesFrom(`Warm light\n\n---\n${footer}\nAsk Ana which brand`, APP)).toBe(
      "Warm light\n\nAsk Ana which brand",
    );
    expect(notesFrom(`Warm light\n\n---\n${footer}\n\nLine 1\nLine 2\n`, APP)).toBe("Warm light\n\nLine 1\nLine 2");
    // A square without notes has only the footer, so a first note lands below it.
    expect(notesFrom(`${footer}\nFirst note`, APP)).toBe("First note");
  });

  it("keeps notes typed after the footer's link, on its line", () => {
    expect(notesFrom(`Warm light\n\n---\n${footer} ask Ana`, APP)).toBe("Warm light\n\nask Ana");
    expect(notesFrom(`${footer}ask Ana\nand Bia`, APP)).toBe("ask Ana\nand Bia");
    expect(notesFrom(`Warm light\r\n\r\n---\r\n${footer} ask Ana\r\n`, APP)).toBe("Warm light\n\nask Ana");
  });

  it("reads a description without our footer as all notes", () => {
    expect(notesFrom("", APP)).toBe("");
    expect(notesFrom("  Warm light\n\nAsk Ana which brand \n", APP)).toBe("Warm light\n\nAsk Ana which brand");
    // The person deleted the footer and wrote below the separator.
    expect(notesFrom("Warm light\n\n---\nAsk Ana", APP)).toBe("Warm light\n\n---\nAsk Ana");
  });

  it("sends notes typed below the footer back above it, and reads them the same", () => {
    const typed = notesFrom(`Warm light\n\n---\n${footer}\nAsk Ana which brand`, APP);
    const sent = withFooter(typed, context);
    expect(sent).toBe(`Warm light\n\nAsk Ana which brand\n\n---\n${footer}`);
    expect(notesFrom(sent, APP)).toBe(typed);
    // Text the person edited above the footer comes back exactly as it was.
    const edited = `Warm light\n- [ ] bulbs\n\n---\n${footer}`;
    expect(withFooter(notesFrom(edited, APP), context)).toBe(edited);
  });

  it("only knows the footer of its own app", () => {
    const other = withFooter("Notes", { ...context, link: squareLink("https://other.app", "goal-1", 2, "cell-2-0") });
    expect(notesFrom(other, APP)).toBe(other);
    expect(cellIdFrom(other, APP)).toBeNull();
  });

  it("finds the square id in the footer", () => {
    expect(cellIdFrom(withFooter("Notes", context), APP)).toBe("cell-2-0");
    expect(cellIdFrom(withFooter("", context), APP)).toBe("cell-2-0");
    expect(cellIdFrom(`Edited in Todoist\n\n---\n${footer}\n`, APP)).toBe("cell-2-0");
    expect(cellIdFrom("No footer here", APP)).toBeNull();
    // The footer is the last link: one quoted in the notes does not count.
    const quoted = withFooter(`See [this](${squareLink(APP, "goal-9", 1, "cell-9")})`, context);
    expect(cellIdFrom(quoted, APP)).toBe("cell-2-0");
    const odd = squareLink(APP, "goal 1", 0, "cell/1 & 2");
    expect(cellIdFrom(withFooter("", { ...context, link: odd }), APP)).toBe("cell/1 & 2");
  });

  it("keeps the footer on one line", () => {
    const text = withFooter("Notes", { pillar: "Skin\ncare", goal: "Glow\r\nup", link });
    expect(text).toBe(`Notes\n\n---\nSkin care · Glow up · [Open in Mandaala](${link})`);
    expect(notesFrom(text, APP)).toBe("Notes");
  });

  it("stays within 16000 characters by shortening the notes, never the footer", () => {
    const long = withFooter("a".repeat(20000), context);
    expect(long).toHaveLength(16000);
    expect(long.endsWith(`\n\n---\n${footer}`)).toBe(true);
    expect(notesFrom(long, APP)).toBe("a".repeat(room));
    expect(cellIdFrom(long, APP)).toBe("cell-2-0");
    // Notes that just fit are kept whole.
    const fits = "b".repeat(room);
    expect(notesFrom(withFooter(fits, context), APP)).toBe(fits);
  });

  it("never splits an emoji when it shortens the notes", () => {
    const text = withFooter("a".repeat(room - 1) + "🙂" + "b".repeat(100), context);
    expect(text.length).toBeLessThanOrEqual(16000);
    expect(notesFrom(text, APP)).toBe("a".repeat(room - 1));
  });
});

describe("days in the person's time zone", () => {
  it("reads the local day of an instant", () => {
    const late = "2026-10-25T02:30:00Z";
    expect(localDay(late, "UTC")).toBe("2026-10-25");
    expect(localDay(late, "America/Sao_Paulo")).toBe("2026-10-24");
    expect(localDay(late, "Asia/Tokyo")).toBe("2026-10-25");
    expect(localDay(new Date("2026-10-25T20:00:00Z"), "Asia/Tokyo")).toBe("2026-10-26");
    expect(localDay("2026-10-25T11:00:00Z", "Pacific/Kiritimati")).toBe("2026-10-26");
    expect(localDay("2026-10-25T10:00:00Z", "Pacific/Pago_Pago")).toBe("2026-10-24");
  });

  it("follows daylight saving time", () => {
    // New York leaves summer time on 2026-11-01 at 06:00 UTC.
    expect(localDay("2026-11-01T03:59:00Z", "America/New_York")).toBe("2026-10-31");
    expect(localDay("2026-11-01T04:00:00Z", "America/New_York")).toBe("2026-11-01");
    expect(localDay("2026-11-02T04:30:00Z", "America/New_York")).toBe("2026-11-01");
  });

  it("falls back to UTC for an unknown zone", () => {
    // Just after and just before midnight UTC, so a zone on either side would give another day.
    expect(localDay("2026-10-25T00:30:00Z", "Mars/Olympus")).toBe("2026-10-25");
    expect(localDay("2026-10-25T23:30:00Z", "Mars/Olympus")).toBe("2026-10-25");
    expect(localDay("2026-10-25T00:30:00Z", "")).toBe("2026-10-25");
    expect(localDay("2026-10-25T23:30:00Z", "")).toBe("2026-10-25");
  });

  it("knows real time zones", () => {
    expect(isTimeZone("America/Sao_Paulo")).toBe(true);
    expect(isTimeZone("Europe/Lisbon")).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    expect(isTimeZone("")).toBe(false);
    expect(isTimeZone("not a zone")).toBe(false);
  });
});

describe("the end of the week", () => {
  it("is Sunday when weeks start on Monday", () => {
    expect(weekEnd("2026-10-25", 1)).toBe("2026-10-25");
    expect(weekEnd("2026-10-26", 1)).toBe("2026-11-01");
    expect(weekEnd("2026-10-28", 1)).toBe("2026-11-01");
    expect(weekEnd("2026-10-31", 1)).toBe("2026-11-01");
  });

  it("is Saturday when weeks start on Sunday", () => {
    expect(weekEnd("2026-10-25", 7)).toBe("2026-10-31");
    expect(weekEnd("2026-10-28", 7)).toBe("2026-10-31");
    expect(weekEnd("2026-10-31", 7)).toBe("2026-10-31");
  });

  it("works for any start day and across years", () => {
    expect(weekEnd("2026-10-31", 6)).toBe("2026-11-06");
    expect(weekEnd("2026-10-30", 6)).toBe("2026-10-30");
    expect(weekEnd("2026-12-30", 1)).toBe("2027-01-03");
  });
});

describe("Todoist due dates", () => {
  it("splits the day and the time", () => {
    expect([dueDay("2026-10-25"), dueTime("2026-10-25")]).toEqual(["2026-10-25", ""]);
    expect([dueDay("2026-10-25T10:00:00"), dueTime("2026-10-25T10:00:00")]).toEqual(["2026-10-25", "T10:00:00"]);
    expect(dueTime("2026-10-25T10:00:00.000000")).toBe("T10:00:00.000000");
    expect(dueTime("2026-10-25T13:00:00.000000Z")).toBe("T13:00:00.000000Z");
  });

  it("keeps the time when an occurrence moves", () => {
    const due = "2026-10-25T07:30:00";
    expect(addDays(dueDay(due), 7) + dueTime(due)).toBe("2026-11-01T07:30:00");
  });
});

describe("where a routine sits in Todoist", () => {
  it("puts a daily routine on today, or tomorrow once checked today", () => {
    const daily = habit();
    expect(routineDueDay(daily, [], "2026-10-28", null)).toBe("2026-10-28");
    expect(routineDueDay(daily, check("2026-10-27"), "2026-10-28", null)).toBe("2026-10-28");
    expect(routineDueDay(daily, check("2026-10-28"), "2026-10-28", null)).toBe("2026-10-29");
    // Another square's check-in does not count, and being picked today changes nothing.
    const other: Checkin[] = [{ cellId: "other", goalId: "g1", day: "2026-10-28" }];
    expect(routineDueDay(daily, other, "2026-10-28", "2026-10-28")).toBe("2026-10-28");
  });

  it("keeps a late weekly routine on its due day until it is checked", () => {
    const sunday = habit({ repeat: "week", repeatOn: 0 });
    expect(routineDueDay(sunday, [], "2026-10-25", "2026-10-01")).toBe("2026-10-25");
    expect(routineDueDay(sunday, [], "2026-10-28", "2026-10-01")).toBe("2026-10-25");
    expect(routineDueDay(sunday, check("2026-10-24"), "2026-10-28", null)).toBe("2026-10-25");
    expect(routineDueDay(sunday, check("2026-10-27"), "2026-10-28", null)).toBe("2026-11-01");
    expect(routineDueDay(sunday, check("2026-10-25"), "2026-10-25", null)).toBe("2026-11-01");
    const wednesday = habit({ repeat: "week", repeatOn: 3 });
    expect(routineDueDay(wednesday, [], "2026-10-25", null)).toBe("2026-10-21");
  });

  it("waits for the next due day when picked after this one", () => {
    const sunday = habit({ repeat: "week", repeatOn: 0 });
    expect(routineDueDay(sunday, [], "2026-10-28", "2026-10-26")).toBe("2026-11-01");
    expect(routineDueDay(sunday, [], "2026-10-28", "2026-10-25")).toBe("2026-10-25");
    const fifth = habit({ repeat: "month", repeatOn: 5 });
    expect(routineDueDay(fifth, [], "2026-10-10", "2026-10-07")).toBe("2026-11-05");
    expect(routineDueDay(fifth, [], "2026-10-10", "2026-09-30")).toBe("2026-10-05");
  });

  it("handles month ends, the 31st and February", () => {
    const fifth = habit({ repeat: "month", repeatOn: 5 });
    expect(routineDueDay(fifth, [], "2026-10-04", null)).toBe("2026-09-05");
    expect(routineDueDay(fifth, check("2026-09-20"), "2026-10-04", null)).toBe("2026-10-05");
    const last = habit({ repeat: "month", repeatOn: 31 });
    expect(routineDueDay(last, [], "2026-11-15", null)).toBe("2026-10-31");
    expect(routineDueDay(last, check("2026-11-01"), "2026-11-15", null)).toBe("2026-11-30");
    expect(routineDueDay(last, check("2027-02-01"), "2027-02-10", null)).toBe("2027-02-28");
    expect(routineDueDay(last, [], "2028-02-29", null)).toBe("2028-02-29");
    const thirtieth = habit({ repeat: "month", repeatOn: 30 });
    expect(routineDueDay(thirtieth, [], "2027-03-01", null)).toBe("2027-02-28");
    expect(routineDueDay(thirtieth, check("2027-02-28"), "2027-03-01", null)).toBe("2027-03-30");
  });
});

describe("moving the Todoist occurrence after a Mandaala check-in", () => {
  const today = "2026-10-28";

  it("moves a daily routine to tomorrow and back", () => {
    const daily = habit();
    expect(checkinMove(daily, check(today), today, true, today, today)).toEqual({ forward: true, to: "2026-10-29" });
    // Late in Todoist: it still lands on tomorrow.
    expect(checkinMove(daily, check(today), today, true, "2026-10-26", today)).toEqual({ forward: true, to: "2026-10-29" });
    expect(checkinMove(daily, check(today), today, true, "2026-10-29", today)).toBeNull();
    expect(checkinMove(daily, [], today, false, "2026-10-29", today)).toEqual({ forward: false, to: today });
    expect(checkinMove(daily, [], today, false, today, today)).toBeNull();
  });

  it("moves a weekly routine to its next due day and back", () => {
    const sunday = habit({ repeat: "week", repeatOn: 0 });
    expect(checkinMove(sunday, check(today), today, true, "2026-10-25", today)).toEqual({
      forward: true,
      to: "2026-11-01",
    });
    expect(checkinMove(sunday, check("2026-10-26"), "2026-10-26", true, "2026-10-25", today)).toEqual({
      forward: true,
      to: "2026-11-01",
    });
    expect(checkinMove(sunday, check("2026-10-26", today), today, true, "2026-11-01", today)).toBeNull();
    expect(checkinMove(sunday, [], today, false, "2026-11-01", today)).toEqual({ forward: false, to: "2026-10-25" });
    // Another check-in still counts for this week.
    expect(checkinMove(sunday, check("2026-10-26"), today, false, "2026-11-01", today)).toBeNull();
    // The person moved it further in Todoist: leave it there.
    expect(checkinMove(sunday, [], today, false, "2026-11-08", today)).toBeNull();
  });

  it("moves nothing for a tick whose check-in is gone, as when its undo went out first", () => {
    const daily = habit();
    expect(checkinMove(daily, [], today, true, today, today)).toBeNull();
    const sunday = habit({ repeat: "week", repeatOn: 0 });
    expect(checkinMove(sunday, [], today, true, "2026-10-25", today)).toBeNull();
    // A check-in in last week does not count for this one.
    expect(checkinMove(sunday, check("2026-10-24"), today, true, "2026-10-25", today)).toBeNull();
    // Another check-in this week still does.
    expect(checkinMove(sunday, check("2026-10-26"), today, true, "2026-10-25", today)).toEqual({
      forward: true,
      to: "2026-11-01",
    });
  });

  it("judges the period by the day the change was made, so a tick sent late still moves Todoist", () => {
    // Checked on Wednesday, the last day of a Thursday week; sent on Thursday after a failed try.
    const thursday = habit({ repeat: "week", repeatOn: 4 });
    expect(checkinMove(thursday, check(today), today, true, "2026-10-22", today)).toEqual({
      forward: true,
      to: "2026-10-29",
    });
    // A change made today about an earlier period is still history.
    expect(checkinMove(thursday, check("2026-10-21"), "2026-10-21", true, "2026-10-15", today)).toBeNull();
  });

  it("only moves Todoist for check-ins in the current period", () => {
    const sunday = habit({ repeat: "week", repeatOn: 0 });
    expect(checkinMove(sunday, check("2026-10-24"), "2026-10-24", true, "2026-10-25", today)).toBeNull();
    expect(checkinMove(sunday, [], "2026-10-24", false, "2026-10-25", today)).toBeNull();
    expect(checkinMove(sunday, check("2026-11-02"), "2026-11-02", true, "2026-10-25", today)).toBeNull();
    const daily = habit();
    expect(checkinMove(daily, check("2026-10-27"), "2026-10-27", true, today, today)).toBeNull();
    expect(checkinMove(daily, [], "2026-10-27", false, "2026-10-29", today)).toBeNull();
  });

  it("uses the month's last day for the 31st", () => {
    const last = habit({ repeat: "month", repeatOn: 31 });
    expect(checkinMove(last, check("2026-11-15"), "2026-11-15", true, "2026-10-31", "2026-11-15")).toEqual({
      forward: true,
      to: "2026-11-30",
    });
    expect(checkinMove(last, [], "2026-11-15", false, "2026-11-30", "2026-11-15")).toEqual({
      forward: false,
      to: "2026-10-31",
    });
    expect(checkinMove(last, check("2027-02-03"), "2027-02-03", true, "2027-01-31", "2027-02-10")).toEqual({
      forward: true,
      to: "2027-02-28",
    });
    expect(checkinMove(last, check("2026-10-30"), "2026-10-30", true, "2026-10-31", "2026-11-15")).toBeNull();
  });
});

describe("the check-in day for a Todoist completion", () => {
  it("uses the completion's day, or the occurrence's day when done early", () => {
    expect(completionDay("2026-10-28", "2026-10-25")).toBe("2026-10-28");
    expect(completionDay("2026-10-24", "2026-10-25")).toBe("2026-10-25");
    expect(completionDay("2026-10-28", "2026-10-28")).toBe("2026-10-28");
    expect(completionDay("2026-10-28", null)).toBe("2026-10-28");
  });
});

describe("reading a Todoist repeat", () => {
  const due = (string: string, date = "2026-10-28") => scheduleFromDue({ string, date, is_recurring: true });
  const daily = { repeat: "day", repeatOn: null };
  const weekly = (repeatOn: number) => ({ repeat: "week", repeatOn });
  const monthly = (repeatOn: number) => ({ repeat: "month", repeatOn });

  it("treats no due or a one-time due as a task", () => {
    expect(scheduleFromDue(null)).toBeNull();
    expect(scheduleFromDue({ string: "oct 28", date: "2026-10-28", is_recurring: false })).toBeNull();
  });

  it("reads back every repeat Mandaala sends", () => {
    const schedules: { repeat: Repeat; repeatOn: number | null }[] = [
      { repeat: "day", repeatOn: null },
      ...[0, 1, 2, 3, 4, 5, 6].map((on) => ({ repeat: "week" as const, repeatOn: on })),
      ...Array.from({ length: 31 }, (_, i) => ({ repeat: "month" as const, repeatOn: i + 1 })),
    ];
    for (const schedule of schedules) {
      expect(due(repeatString(schedule)), repeatString(schedule)).toEqual(schedule);
    }
  });

  it("reads Todoist's English wording, with times and start dates", () => {
    const cases: [string, unknown][] = [
      ["every day", daily],
      ["Every Day", daily],
      ["daily", daily],
      ["everyday", daily],
      ["ev day", daily],
      ["each day", daily],
      ["every morning", daily],
      ["every evening", daily],
      ["every day at 9:30 AM", daily],
      ["every day at 10am", daily],
      ["every day @ 10am", daily],
      ["every day at 20:00", daily],
      ["every day at noon", daily],
      ["every day 7pm", daily],
      ["every day at 9", daily],
      ["everyday starting on aug 3", daily],
      ["everyday from aug 3", daily],
      ["every day at 10am starting tomorrow", daily],
      ["every sun", weekly(0)],
      ["every Monday", weekly(1)],
      ["every tues", weekly(2)],
      ["ev wed", weekly(3)],
      ["every thurs at 8pm", weekly(4)],
      ["every fri at noon", weekly(5)],
      ["every saturday", weekly(6)],
      ["every week", weekly(3)],
      ["weekly", weekly(3)],
      ["every 5th", monthly(5)],
      ["every 5", monthly(5)],
      ["ev 5th", monthly(5)],
      ["every 27th at 9am", monthly(27)],
      ["every 31st", monthly(31)],
      ["every last day", monthly(31)],
      ["every month", monthly(28)],
      ["monthly", monthly(28)],
    ];
    for (const [string, schedule] of cases) expect(due(string), string).toEqual(schedule);
  });

  it("reads Portuguese, with or without accents", () => {
    const cases: [string, unknown][] = [
      ["todo dia", daily],
      ["todos os dias", daily],
      ["diariamente", daily],
      ["cada dia", daily],
      ["Todo dia às 9:00", daily],
      ["todo dia às 22h", daily],
      ["toda manhã", daily],
      ["toda noite", daily],
      ["todos os dias a partir de 3 de ago", daily],
      ["todos os dias começando em 3 de ago", daily],
      ["todo domingo", weekly(0)],
      ["toda segunda", weekly(1)],
      ["toda segunda-feira", weekly(1)],
      ["toda segunda feira", weekly(1)],
      ["toda seg de manhã", weekly(1)],
      ["todas as segundas-feiras", weekly(1)],
      ["toda terça", weekly(2)],
      ["toda terca", weekly(2)],
      ["toda quarta à noite", weekly(3)],
      ["toda quinta-feira", weekly(4)],
      ["toda sex ao meio-dia", weekly(5)],
      ["aos sábados", weekly(6)],
      ["aos sabados", weekly(6)],
      ["toda semana", weekly(3)],
      ["semanal", weekly(3)],
      ["semanalmente", weekly(3)],
      ["todo mês", monthly(28)],
      ["todo mes", monthly(28)],
      ["mensal", monthly(28)],
      ["mensalmente", monthly(28)],
      ["todo dia 5", monthly(5)],
      ["todo 27", monthly(27)],
      ["todo último dia", monthly(31)],
    ];
    for (const [string, schedule] of cases) expect(due(string), string).toEqual(schedule);
  });

  it("repeats 'every week' and 'every month' on the occurrence's day", () => {
    expect(due("every week", "2026-11-01")).toEqual(weekly(0));
    expect(due("todo mês", "2026-10-31T09:00:00")).toEqual(monthly(31));
  });

  it("calls repeats Mandaala cannot show custom", () => {
    const custom = [
      "every other day",
      "every 2 days",
      "every 2 weeks",
      "every other week",
      "every other fri",
      "every weekday",
      "every workday",
      "every weekend",
      "every mon, fri",
      "every monday, friday",
      "every mon, fri at 20:00",
      "every 2, 15, 27",
      "every year",
      "every jan 5",
      "every 3rd friday",
      "every! day",
      "every! week",
      "every day until aug 3",
      "everyday ending aug 3",
      "everyday for 3 weeks",
      "everyday from 10 may until 20 may",
      "every hour",
      "every 12 hours starting at 9pm",
      "every 2 days at 10am starting tomorrow",
      "every last workday",
      "every 15th day",
      "every 32nd",
      "every 0",
      "every quarter",
      "todo dia útil",
      "todo dia de semana",
      "todo fim de semana",
      "a cada 3 dias",
      "toda seg,sex",
      "todo dia alternado",
      "toda semana alternada",
      "todo último dia útil às 15h",
      "todo ano",
      "a cada! 5 dias",
      "todo dia por 3 semanas",
      "todos os dias até 3 de agosto",
      "toda hora",
      "",
    ];
    for (const string of custom) expect(due(string), string).toBe("custom");
  });
});

describe("the sync request", () => {
  it("takes the browser's time zone and two switches", () => {
    expect(todoistSyncSchema.parse({})).toEqual({});
    expect(todoistSyncSchema.parse({ timezone: "America/Sao_Paulo", force: true, rebuild: false })).toEqual({
      timezone: "America/Sao_Paulo",
      force: true,
      rebuild: false,
    });
    expect(todoistSyncSchema.safeParse({ timezone: "x".repeat(65) }).success).toBe(false);
    expect(todoistSyncSchema.safeParse({ force: "yes" }).success).toBe(false);
  });
});
