import { describe, expect, it } from "vite-plus/test";

import { projectBufferLines, sentenceSpans, tableMotionColumn } from "./chatBuffer";

describe("chat buffer sentences", () => {
  const sentences = (line: string) =>
    sentenceSpans(line).map(({ start, end }) => line.slice(start, end + 1));

  it("splits a block at end punctuation followed by a space", () => {
    expect(sentences("It builds. Does it pass? Yes!")).toEqual([
      "It builds.",
      "Does it pass?",
      "Yes!",
    ]);
  });

  it("keeps closing quotes and emphasis with the sentence they end", () => {
    expect(sentences('He said "stop." Then (it ran.) Done')).toEqual([
      'He said "stop."',
      "Then (it ran.)",
      "Done",
    ]);
  });

  it("does not end a sentence inside a number or a file name", () => {
    expect(sentences("Version 3.5 reads a.ts first. Next")).toEqual([
      "Version 3.5 reads a.ts first.",
      "Next",
    ]);
  });

  it("reads a block without end punctuation as one sentence, without its edge spaces", () => {
    expect(sentenceSpans("  a heading  ")).toEqual([{ start: 2, end: 10 }]);
    expect(sentenceSpans("   ")).toEqual([]);
  });
});

describe("chat line projection", () => {
  it("preserves leading, interior, whitespace-only and trailing preformatted lines", () => {
    expect(projectBufferLines("\nalpha\n\n  \nbeta\n", () => true)).toEqual([
      { text: "", start: 0 },
      { text: "alpha", start: 1 },
      { text: "", start: 7 },
      { text: "  ", start: 8 },
      { text: "beta", start: 11 },
      { text: "", start: 16 },
    ]);
  });

  it("drops incidental blank prose lines", () => {
    expect(projectBufferLines("first\n \n\nlast", () => false)).toEqual([
      { text: "first", start: 0 },
      { text: "last", start: 9 },
    ]);
  });
});

describe("table motion columns", () => {
  it("keeps the cell and character column across uneven table rows", () => {
    expect(tableMotionColumn("Long header\tValue\tStatus", "x\t42\tok", 14)).toBe(3);
    expect(tableMotionColumn("Long header\tValue\tStatus", "x\t4\tok", 15)).toBe(2);
    expect(tableMotionColumn("a\tb\tc", "only", 4)).toBe(0);
  });
});
