import { describe, expect, it } from "vite-plus/test";

import type { FileCommentAnnotationEntry } from "../fileCommentAnnotations";
import {
  anchorForLines,
  entryAfterModelChange,
  groupEntriesByEndLine,
  type CommentAnchor,
} from "./monacoFileCommentAnchors";

const entry = (
  id: string,
  startLine: number,
  endLine: number,
  kind: "draft" | "comment" = "comment",
): FileCommentAnnotationEntry => ({ id, kind, startLine, endLine, text: `text ${id}` });

const range = (
  startLineNumber: number,
  endLineNumber: number,
  startColumn = 1,
  endColumn = 10,
) => ({ startLineNumber, startColumn, endLineNumber, endColumn });

/** A document of `lines`, each of the given length, for `maxColumnOf`. */
const document_ = (lengths: readonly number[]) => ({
  lineCount: lengths.length,
  maxColumnOf: (line: number) => (lengths[line - 1] ?? 0) + 1,
});

describe("groupEntriesByEndLine", () => {
  it("puts comments that end on the same line in one group", () => {
    const groups = groupEntriesByEndLine([entry("a", 1, 4), entry("b", 3, 4)]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.endLine).toBe(4);
    expect(groups[0]?.entries.map((each) => each.id)).toEqual(["a", "b"]);
  });

  it("orders the groups down the file, whatever order the comments arrived in", () => {
    const groups = groupEntriesByEndLine([entry("a", 40, 42), entry("b", 1, 2), entry("c", 9, 9)]);

    expect(groups.map((group) => group.endLine)).toEqual([2, 9, 42]);
  });

  it("keeps the order comments were made in within a group", () => {
    const groups = groupEntriesByEndLine([entry("first", 5, 5), entry("second", 5, 5)]);

    expect(groups[0]?.entries.map((each) => each.id)).toEqual(["first", "second"]);
  });

  it("has no groups for no comments", () => {
    expect(groupEntriesByEndLine([])).toEqual([]);
  });
});

describe("anchorForLines", () => {
  const doc = document_([10, 10, 10, 10, 10]);

  it("reaches into the line below, so the anchor covers a newline", () => {
    const anchor = anchorForLines(2, 3, doc.lineCount, doc.maxColumnOf);

    expect(anchor.range).toEqual({
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 4,
      endColumn: 1,
    });
    expect(anchor.endLineOffset).toBe(-1);
  });

  it("is never empty for a blank line in the middle of a file", () => {
    const blank = document_([10, 0, 10]);
    const anchor = anchorForLines(2, 2, blank.lineCount, blank.maxColumnOf);

    // The bug this guards: a blank line has no characters, so the obvious range
    // is empty at creation and the next keystroke anywhere reads as a deletion.
    expect(isEmpty(anchor)).toBe(false);
  });

  it("uses the line's own text at the end of the file", () => {
    const anchor = anchorForLines(5, 5, doc.lineCount, doc.maxColumnOf);

    expect(anchor.range).toEqual({
      startLineNumber: 5,
      startColumn: 1,
      endLineNumber: 5,
      endColumn: 11,
    });
    expect(anchor.endLineOffset).toBe(0);
  });

  it("reaches backwards for a blank last line, and is still not empty", () => {
    const trailing = document_([10, 10, 0]);
    const anchor = anchorForLines(3, 3, trailing.lineCount, trailing.maxColumnOf);

    expect(isEmpty(anchor)).toBe(false);
    expect(anchor.startLineOffset).toBe(1);
  });

  it("round-trips the commented lines back out of every placement it makes", () => {
    for (const lengths of [
      [10, 10, 10],
      [10, 0, 10],
      [10, 10, 0],
      [0, 0, 0],
    ]) {
      const model = document_(lengths);
      for (let start = 1; start <= model.lineCount; start += 1) {
        for (let end = start; end <= model.lineCount; end += 1) {
          const anchor = anchorForLines(start, end, model.lineCount, model.maxColumnOf);
          const read = entryAfterModelChange(entry("a", start, end), anchor, anchor.range);
          expect({ lengths, start, end, read }).toEqual({
            lengths,
            start,
            end,
            read: entry("a", start, end),
          });
        }
      }
    }
  });
});

describe("entryAfterModelChange", () => {
  const plain: CommentAnchor = {
    range: range(10, 12),
    startLineOffset: 0,
    endLineOffset: 0,
  };

  it("moves the comment down when lines were inserted above it", () => {
    const moved = entryAfterModelChange(entry("a", 10, 12), plain, range(13, 15));

    expect(moved).toEqual({ ...entry("a", 13, 15) });
  });

  it("undoes the reach into the line below when reading the range back", () => {
    const widened = { startLineOffset: 0, endLineOffset: -1 };

    // The decoration covers lines 13 to 16; the comment is on 13 to 15.
    expect(entryAfterModelChange(entry("a", 10, 12), widened, range(13, 16))).toEqual({
      ...entry("a", 13, 15),
    });
  });

  it("returns the very same object when nothing moved", () => {
    const original = entry("a", 10, 12);

    // Identity, not just equality: the zone and its React tree are keyed off
    // these entries, so a new object for an unchanged comment would rebuild a
    // form the user may be typing in.
    expect(entryAfterModelChange(original, plain, range(10, 12))).toBe(original);
  });

  it("ends the comment when its decoration is gone from the model", () => {
    expect(entryAfterModelChange(entry("a", 10, 12), plain, null)).toBeNull();
  });

  it("ends the comment when the lines it covered were deleted", () => {
    // Monaco keeps the decoration and collapses it to one position rather than
    // removing it, so an empty range is what a deletion looks like.
    expect(entryAfterModelChange(entry("a", 10, 12), plain, range(10, 10, 1, 1))).toBeNull();
  });

  it("never reports an end line above its start line", () => {
    const widened = { startLineOffset: 0, endLineOffset: -1 };

    // The line below was deleted, so the widened range collapsed onto one line.
    expect(entryAfterModelChange(entry("a", 10, 11), widened, range(10, 10, 1, 4))).toEqual({
      ...entry("a", 10, 10),
    });
  });
});

function isEmpty({ range: anchored }: CommentAnchor): boolean {
  return (
    anchored.startLineNumber === anchored.endLineNumber &&
    anchored.startColumn === anchored.endColumn
  );
}
