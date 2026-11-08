import { describe, expect, it } from "@effect/vitest";

import { messageModeAnswerText } from "./messageModeAnswers.ts";

// Ported from the fork's v1 decider.questionAttachments.test.ts (5c61984ca6).
describe("messageModeAnswerText", () => {
  const question = {
    options: [{ label: "Keep", description: "Keep it", value: "Keep" }],
  };

  it("sends a choice and its note on separate lines of one answer", () => {
    expect(messageModeAnswerText(question, ["Keep", "Add a migration note"])).toBe(
      "Keep\nAdd a migration note",
    );
  });

  it("still sends a plain text answer, trimmed like upstream", () => {
    expect(messageModeAnswerText(question, "Keep")).toBe("Keep");
    expect(messageModeAnswerText(question, "  Blue  ")).toBe("Blue");
    expect(messageModeAnswerText(question, ["Keep", "  a note  "])).toBe("Keep\na note");
  });

  it("requires the exact provider value for a choice-only question", () => {
    const value = " Keep\t";
    const choiceOnly = {
      allowCustomAnswer: false,
      options: [{ label: "Keep", description: "Keep", value }],
    };
    for (const answer of ["Keep", [value, "A note"], "unknown"]) {
      expect(messageModeAnswerText(choiceOnly, answer)).toBeNull();
    }
    expect(messageModeAnswerText(choiceOnly, value)).toBe(value);
  });

  it("refuses blank, empty-array and non-string answers", () => {
    for (const answer of ["", "   ", [], [1], undefined, null, 3]) {
      expect(messageModeAnswerText(question, answer)).toBeNull();
    }
  });

  it("matches a choice by label when the option carries no value", () => {
    const byLabel = { allowCustomAnswer: false, options: [{ label: "Yes", description: "Y" }] };
    expect(messageModeAnswerText(byLabel, "Yes")).toBe("Yes");
    expect(messageModeAnswerText(byLabel, "No")).toBeNull();
  });
});
