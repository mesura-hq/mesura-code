import { describe, expect, it } from "vite-plus/test";

import { resolveRevealLine } from "./monacoFileReveal";

describe("resolveRevealLine", () => {
  it("returns a line that exists as it is", () => {
    expect(resolveRevealLine(5, 40)).toBe(5);
  });

  it("clamps a line past the end to the last line", () => {
    // A link can name a line the file no longer has, after an agent shortened
    // it. Landing on the last line beats landing nowhere.
    expect(resolveRevealLine(999, 40)).toBe(40);
  });

  it("clamps zero and negatives to the first line", () => {
    expect(resolveRevealLine(0, 40)).toBe(1);
    expect(resolveRevealLine(-3, 40)).toBe(1);
  });

  it("handles a one-line file", () => {
    expect(resolveRevealLine(1, 1)).toBe(1);
    expect(resolveRevealLine(9, 1)).toBe(1);
  });

  it("never returns less than one, even for an empty model", () => {
    // Monaco reports a line count of 1 for an empty document, but a caller
    // computing a count itself could hand over 0.
    expect(resolveRevealLine(1, 0)).toBe(1);
    expect(resolveRevealLine(7, 0)).toBe(1);
  });

  it("rejects a non-integer request rather than revealing a fractional line", () => {
    expect(resolveRevealLine(3.7, 40)).toBe(3);
  });
});
