import { describe, expect, it } from "vitest";
import { HttpError } from "@/domain/errors";
import { leveragePrompt } from "@/server/ai/leverage";
import { analyzePrompt } from "@/server/ai/reports";
import { sharpenPrompt } from "@/server/ai/sharpen";
import { suggestPrompt } from "@/server/ai/suggest";
import { sampleGoal } from "../support/goal";

// Prompt builders are pure: these run without a Gemini key.

const day = "2026-03-10";

describe("prompts", () => {
  it("show the model the goal and the pillar being filled", () => {
    const prompt = suggestPrompt(sampleGoal(), { goalId: "goal-1", target: "actions", pillar: 1 }, day);
    expect(prompt.text).toContain("read 20 books");
    expect(prompt.text).toContain("Book list");
  });

  it("keep only usable suggestions from an answer", () => {
    const prompt = suggestPrompt(sampleGoal(), { goalId: "goal-1", target: "actions", pillar: 2 }, day);
    const parsed = prompt.parse({ suggestions: [{ text: "Read 10 pages a day", kind: "habit" }, { text: "" }, 42] });
    expect(parsed.map((s) => s.text)).toEqual(["Read 10 pages a day"]);
  });

  it("refuse what cannot be worked on", () => {
    const empty = { ...sampleGoal(), cells: sampleGoal().cells.map((c) => ({ ...c, text: "" })) };
    expect(() => leveragePrompt(empty, day)).toThrow(HttpError);
    expect(() => sharpenPrompt({ role: "action", text: "  ", pillar: 0, goalId: null, deadline: null }, null, day)).toThrow(
      HttpError,
    );
  });

  it("never put square ids in a report prompt", () => {
    const goal = sampleGoal();
    const prompt = analyzePrompt({ goals: [goal], checkins: [], day }, { text: "Read 30 pages today" });
    expect(prompt.text).not.toContain("cell-0-1");
    expect(prompt.text).toContain("Read 30 pages today");
  });
});
