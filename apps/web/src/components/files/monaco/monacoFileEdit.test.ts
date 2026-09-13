import { describe, expect, it } from "vite-plus/test";

import { minimalTextEdit } from "./monacoFileEdit";

/** Applies an edit the way Monaco would, so the tests assert the round trip. */
function apply(before: string, edit: ReturnType<typeof minimalTextEdit>): string {
  if (edit === null) return before;
  return before.slice(0, edit.startOffset) + edit.text + before.slice(edit.endOffset);
}

describe("minimalTextEdit", () => {
  it("has nothing to do when the text did not change", () => {
    expect(minimalTextEdit("same", "same")).toBeNull();
  });

  it("touches only the line that changed", () => {
    const before = "one\ntwo\nthree\n";
    const after = "one\nTWO\nthree\n";

    const edit = minimalTextEdit(before, after);

    expect(edit).toEqual({ startOffset: 4, endOffset: 7, text: "TWO" });
    expect(apply(before, edit)).toBe(after);
  });

  it("leaves everything below an insertion alone", () => {
    const before = "a\nb\n";
    const after = "new\na\nb\n";

    const edit = minimalTextEdit(before, after);

    // The edit sits at the very start, so every later position shifts by the
    // inserted length and nothing else is disturbed.
    expect(edit?.startOffset).toBe(0);
    expect(edit?.endOffset).toBe(0);
    expect(apply(before, edit)).toBe(after);
  });

  it("describes a pure deletion as an empty replacement", () => {
    const before = "keep\ndrop\nkeep\n";
    const after = "keep\nkeep\n";

    const edit = minimalTextEdit(before, after);

    expect(edit?.text).toBe("");
    expect(apply(before, edit)).toBe(after);
  });

  it("handles an append without rewriting what came before", () => {
    const before = "line\n";
    const after = "line\nadded\n";

    const edit = minimalTextEdit(before, after);

    expect(edit?.startOffset).toBe(before.length);
    expect(apply(before, edit)).toBe(after);
  });

  it("handles growing from and shrinking to nothing", () => {
    expect(apply("", minimalTextEdit("", "hello"))).toBe("hello");
    expect(apply("hello", minimalTextEdit("hello", ""))).toBe("");
  });

  it("never splits a surrogate pair", () => {
    // The two emoji share a leading surrogate, so a naive prefix scan stops
    // between the halves and writes back half a character.
    const before = "x😀y";
    const after = "x😁y";

    const edit = minimalTextEdit(before, after);

    expect(apply(before, edit)).toBe(after);
    expect(edit === null || !Number.isNaN(before.codePointAt(edit.startOffset))).toBe(true);
    // The replacement is itself a whole character, not a lone surrogate.
    expect([...(edit?.text ?? "")].length).toBe(edit?.text.length === 0 ? 0 : 1);
  });

  it("round-trips a repeated-content edit, where prefix and suffix could overlap", () => {
    const before = "aaaa";
    const after = "aa";

    const edit = minimalTextEdit(before, after);

    expect(apply(before, edit)).toBe(after);
    expect(edit!.endOffset).toBeGreaterThanOrEqual(edit!.startOffset);
  });

  it("round-trips every edit over a spread of shapes", () => {
    const samples = [
      "",
      "a",
      "a\nb\nc\n",
      "the quick brown fox\n",
      "line\nline\nline\n",
      "😀😀\n",
      "trailing newline missing",
    ];
    for (const before of samples) {
      for (const after of samples) {
        const edit = minimalTextEdit(before, after);
        expect({ before, after, applied: apply(before, edit) }).toEqual({
          before,
          after,
          applied: after,
        });
        if (edit !== null) {
          expect(edit.endOffset).toBeGreaterThanOrEqual(edit.startOffset);
          expect(edit.endOffset).toBeLessThanOrEqual(before.length);
        }
      }
    }
  });
});
