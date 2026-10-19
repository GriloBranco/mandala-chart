import { describe, expect, it } from "vitest";
import { guessKind, guessRepeat } from "@/domain/kind";
import { periodStart, periodStrength, repeatLabel, routineToday } from "@/domain/repeat";
import type { Cell, Checkin } from "@/domain/types";

function habit(overrides: Partial<Cell> = {}): Cell {
  return {
    id: "h",
    goalId: "g1",
    pillar: 0,
    slot: 0,
    text: "Cut my nails",
    notes: "",
    kind: "habit",
    repeat: "week",
    repeatOn: 0,
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

describe("guessing how often", () => {
  it("reads weekly and monthly wording", () => {
    expect(guessRepeat("cut my nails every week")).toEqual({ repeat: "week", repeatOn: null });
    expect(guessRepeat("Cut my hair every month")).toEqual({ repeat: "month", repeatOn: null });
    expect(guessRepeat("Call mom every Sunday")).toEqual({ repeat: "week", repeatOn: 0 });
    expect(guessRepeat("Pay rent monthly on the 5th")).toEqual({ repeat: "month", repeatOn: 5 });
    expect(guessRepeat("Cortar o cabelo todo mês")).toEqual({ repeat: "month", repeatOn: null });
    expect(guessRepeat("Faxina aos sábados")).toEqual({ repeat: "week", repeatOn: 6 });
  });

  it("keeps daily and several-times-a-week habits daily", () => {
    expect(guessRepeat("Read 20 pages every day").repeat).toBe("day");
    expect(guessRepeat("Gym 3x a week").repeat).toBe("day");
    expect(guessRepeat("Meditate daily").repeat).toBe("day");
  });

  it("makes weekly and monthly wording a habit", () => {
    expect(guessKind("Review budget monthly")).toBe("habit");
    expect(guessKind("cut my nails every week")).toBe("habit");
    expect(guessKind("Ship the landing page")).toBe("task");
  });
});

describe("weekly and monthly periods", () => {
  it("starts a period on the latest due day", () => {
    // 2026-10-18 is a Sunday.
    expect(periodStart({ repeat: "week", on: 0 }, "2026-10-21")).toBe("2026-10-18");
    expect(periodStart({ repeat: "week", on: 3 }, "2026-10-20")).toBe("2026-10-14");
    expect(periodStart({ repeat: "month", on: 5 }, "2026-10-04")).toBe("2026-09-05");
    expect(periodStart({ repeat: "month", on: 31 }, "2026-11-30")).toBe("2026-11-30");
  });

  it("shows a weekly routine from its due day until it is checked", () => {
    expect(routineToday(habit(), [], "2026-10-18").show).toBe(true);
    expect(routineToday(habit(), [], "2026-10-20")).toMatchObject({ show: true, lateSince: "2026-10-18" });
    expect(routineToday(habit(), check("2026-10-20"), "2026-10-20")).toMatchObject({ show: true, lateSince: null });
    expect(routineToday(habit(), check("2026-10-18"), "2026-10-20")).toMatchObject({ show: false, next: "2026-10-25" });
  });

  it("waits for the first due day when picked after it", () => {
    const fresh = habit({ activatedAt: new Date(2026, 9, 20, 12).toISOString() });
    expect(routineToday(fresh, [], "2026-10-21")).toMatchObject({ show: false, next: "2026-10-25" });
  });

  it("builds strength per period", () => {
    const weekly = check("2026-09-20", "2026-09-27", "2026-10-04", "2026-10-11");
    expect(periodStrength(habit(), weekly, "2026-10-17")).toBeGreaterThan(0.95);
    expect(periodStrength(habit(), [], "2026-10-17")).toBe(0);
  });

  it("labels the schedule", () => {
    expect(repeatLabel(habit())).toBe("Every Sunday");
    expect(repeatLabel(habit({ repeat: "month", repeatOn: 2 }))).toBe("Monthly on the 2nd");
    expect(repeatLabel(habit({ repeat: "day", repeatOn: null }))).toBe("Daily");
  });
});
