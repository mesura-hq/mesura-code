import { describe, expect, it } from "vite-plus/test";

import { editsForLinesEvent, editsForSnapshot, type MonacoEdit } from "./nvimModelSync.ts";

/**
 * Turning Neovim's view of the text into Monaco edit operations.
 *
 * Pure on purpose. The driver that applies these owns a live editor and is
 * awkward to test; the arithmetic is where the mistakes are, and it is all
 * here. Two coordinate systems meet in this file and they disagree about
 * everything: Neovim counts lines from zero and gives half-open ranges,
 * Monaco counts from one and gives closed ones.
 *
 * The other rule these encode is that an edit which changes nothing must not
 * be produced at all. Monaco moves every decoration, every marker and the
 * caret for an applied edit, so replacing a line with itself is visible.
 *
 * **Every case here asserts the text that comes out, not only the range that
 * goes in.** The first version of this file asserted ranges alone and agreed
 * with an off-by-one that a real Neovim found in a minute: a replacement
 * reaching the last line produced a range ending on line `lineCount + 1`,
 * which Monaco clamps to the end of the text, which left a blank line behind.
 * A range is a claim; the text after applying it is the behaviour.
 */

/**
 * Monaco's `applyEdits`, as far as these edits use it.
 *
 * The clamping is the part that matters and the part that has to be honest: a
 * line number past the end of the text resolves to the end of the text, and a
 * column past the end of its line resolves to the end of that line. That is
 * what turns an over-reaching range into a silently wrong edit rather than an
 * error, so a helper that threw instead would hide the very defect these
 * tests exist to catch.
 */
function applyEdits(lines: ReadonlyArray<string>, edits: ReadonlyArray<MonacoEdit>): Array<string> {
  const text = lines.join("\n");
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") lineStarts.push(index + 1);
  }

  const offsetAt = (lineNumber: number, column: number) => {
    if (lineNumber > lineStarts.length) return text.length;
    const line = Math.max(1, lineNumber);
    const start = lineStarts[line - 1] ?? 0;
    const end = line < lineStarts.length ? (lineStarts[line] ?? text.length) - 1 : text.length;
    return Math.min(start + Math.max(1, column) - 1, end);
  };

  // Back to front, so an earlier edit's offsets still describe the text the
  // later one was computed against — which is how Monaco applies a batch.
  const ordered = [...edits].sort(
    (left, right) =>
      offsetAt(right.range.startLineNumber, right.range.startColumn) -
      offsetAt(left.range.startLineNumber, left.range.startColumn),
  );

  let result = text;
  for (const edit of ordered) {
    const start = offsetAt(edit.range.startLineNumber, edit.range.startColumn);
    const end = offsetAt(edit.range.endLineNumber, edit.range.endColumn);
    result = result.slice(0, start) + edit.text + result.slice(end);
  }
  return result.split("\n");
}

describe("editsForLinesEvent", () => {
  it("replaces one line in the middle", () => {
    const before = ["one", "two", "three"];
    const edits = editsForLinesEvent(before.length, { first: 1, last: 2, lines: ["changed"] });
    expect(edits).toEqual([
      {
        range: { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 1 },
        text: "changed\n",
      },
    ]);
    expect(applyEdits(before, edits)).toEqual(["one", "changed", "three"]);
  });

  it("replaces the buffer's last line without leaving a blank one behind", () => {
    // Measured, not imagined: `G` `A` `!` on a two-line buffer in a real
    // Neovim sends exactly this event, and the range that ends on line 3 of a
    // two-line model produced `["one", "two!", ""]`.
    const before = ["one", "two"];
    const edits = editsForLinesEvent(before.length, { first: 1, last: 2, lines: ["two!"] });
    expect(applyEdits(before, edits)).toEqual(["one", "two!"]);
  });

  it("replaces a run of lines that reaches the last one", () => {
    const before = ["one", "two", "three", "four"];
    const edits = editsForLinesEvent(before.length, {
      first: 1,
      last: 4,
      lines: ["second", "third"],
    });
    expect(applyEdits(before, edits)).toEqual(["one", "second", "third"]);
  });

  it("replaces every line at once", () => {
    const before = ["one", "two"];
    const edits = editsForLinesEvent(before.length, { first: 0, last: 2, lines: ["only"] });
    expect(applyEdits(before, edits)).toEqual(["only"]);
  });

  it("replaces the whole buffer when Neovim says so", () => {
    // `last === -1` is Neovim's whole-buffer reset, and it is the shape an
    // agent's rewrite of a file arrives in.
    const before = ["one", "two"];
    const edits = editsForLinesEvent(before.length, {
      first: 0,
      last: -1,
      lines: ["one", "two", "three"],
    });
    expect(edits).toHaveLength(1);
    expect(edits[0]?.text).toBe("one\ntwo\nthree");
    expect(edits[0]?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: Number.MAX_SAFE_INTEGER,
    });
    expect(applyEdits(before, edits)).toEqual(["one", "two", "three"]);
  });

  it("deletes a run of lines", () => {
    const before = ["one", "two", "three", "four"];
    const edits = editsForLinesEvent(before.length, { first: 1, last: 3, lines: [] });
    expect(edits).toEqual([
      { range: { startLineNumber: 2, startColumn: 1, endLineNumber: 4, endColumn: 1 }, text: "" },
    ]);
    expect(applyEdits(before, edits)).toEqual(["one", "four"]);
  });

  it("deletes a run that reaches the end, taking the newline before it", () => {
    // The newline that has to go is the one *above* the first deleted line.
    // Taking the one below instead leaves the line above as an empty line,
    // which is a line the developer never typed.
    const before = ["one", "two", "three"];
    const edits = editsForLinesEvent(before.length, { first: 1, last: 3, lines: [] });
    expect(applyEdits(before, edits)).toEqual(["one"]);
  });

  it("leaves one empty line when every line is deleted, as Neovim does", () => {
    const before = ["one", "two"];
    const edits = editsForLinesEvent(before.length, { first: 0, last: 2, lines: [] });
    expect(applyEdits(before, edits)).toEqual([""]);
  });

  it("inserts without replacing anything", () => {
    const before = ["one", "two"];
    const edits = editsForLinesEvent(before.length, { first: 1, last: 1, lines: ["inserted"] });
    expect(edits).toEqual([
      {
        range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 },
        text: "inserted\n",
      },
    ]);
    expect(applyEdits(before, edits)).toEqual(["one", "inserted", "two"]);
  });

  it("appends past the last line without reaching for a line that is not there", () => {
    // `first` equal to the line count is an append. Monaco has no line to
    // anchor to, so the edit has to hang off the end of the last one.
    const before = ["one", "two"];
    const edits = editsForLinesEvent(before.length, { first: 2, last: 2, lines: ["appended"] });
    expect(edits).toEqual([
      {
        range: {
          startLineNumber: 2,
          startColumn: Number.MAX_SAFE_INTEGER,
          endLineNumber: 2,
          endColumn: Number.MAX_SAFE_INTEGER,
        },
        text: "\nappended",
      },
    ]);
    expect(applyEdits(before, edits)).toEqual(["one", "two", "appended"]);
  });
});

describe("editsForSnapshot", () => {
  it("produces nothing when the model already agrees", () => {
    expect(editsForSnapshot(["one", "two"], ["one", "two"])).toEqual([]);
  });

  it("touches only the lines that differ", () => {
    const before = ["one", "two", "three"];
    const edits = editsForSnapshot(before, ["one", "CHANGED", "three"]);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.text).toBe("CHANGED");
    expect(edits[0]?.range.startLineNumber).toBe(2);
    expect(applyEdits(before, edits)).toEqual(["one", "CHANGED", "three"]);
  });

  it("adds the lines a longer snapshot has", () => {
    const before = ["one"];
    const edits = editsForSnapshot(before, ["one", "two", "three"]);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.text).toBe("\ntwo\nthree");
    expect(applyEdits(before, edits)).toEqual(["one", "two", "three"]);
  });

  it("removes the lines a shorter snapshot does not have", () => {
    const before = ["one", "two", "three"];
    const edits = editsForSnapshot(before, ["one"]);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.text).toBe("");
    expect(edits[0]?.range).toEqual({
      startLineNumber: 1,
      startColumn: Number.MAX_SAFE_INTEGER,
      endLineNumber: 3,
      endColumn: Number.MAX_SAFE_INTEGER,
    });
    expect(applyEdits(before, edits)).toEqual(["one"]);
  });

  it("reconciles a model that shares nothing with the snapshot", () => {
    const before = ["a", "b"];
    const edits = editsForSnapshot(before, ["x", "y"]);
    expect(edits.map((edit) => edit.text)).toEqual(["x", "y"]);
    expect(applyEdits(before, edits)).toEqual(["x", "y"]);
  });

  it("handles an empty buffer, which Neovim reports as one empty line", () => {
    expect(editsForSnapshot([""], [""])).toEqual([]);
    const before = ["one", "two"];
    const edits = editsForSnapshot(before, [""]);
    expect(edits).toHaveLength(2);
    expect(applyEdits(before, edits)).toEqual([""]);
  });

  it("treats a target with no lines as the empty document", () => {
    // Neither Neovim nor Monaco can hold a buffer with zero lines in it.
    // Before this, the per-line loop ran zero times and the tail delete began
    // at the end of line 1, so line 1's old text stayed on screen.
    const before = ["one", "two", "three"];
    expect(applyEdits(before, editsForSnapshot(before, []))).toEqual([""]);
    expect(editsForSnapshot([""], [])).toEqual([]);
  });

  it("grows a model that was empty", () => {
    const before = [""];
    const edits = editsForSnapshot(before, ["one", "two"]);
    expect(applyEdits(before, edits)).toEqual(["one", "two"]);
  });
});
