import { describe, expect, it } from "vite-plus/test";

import { insertTranscriptAtCaret } from "./fieldDictation";

describe("insertTranscriptAtCaret", () => {
  it("puts the transcript at the caret with one space on each side, and the caret after it", () => {
    expect(insertTranscriptAtCaret("Looks good merge", 10, "after tests")).toEqual({
      text: "Looks good after tests merge",
      caret: "Looks good after tests".length,
    });
  });

  it("adds no space at either edge or beside existing whitespace", () => {
    expect(insertTranscriptAtCaret("", 0, "hola")).toEqual({ text: "hola", caret: 4 });
    expect(insertTranscriptAtCaret("Hi ", 3, "there")).toEqual({ text: "Hi there", caret: 8 });
  });

  it("clamps a caret past the end", () => {
    expect(insertTranscriptAtCaret("Hi", 99, "there").text).toBe("Hi there");
  });
});
