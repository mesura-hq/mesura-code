import type { FileCommentAnnotationEntry } from "../fileCommentAnnotations";

/**
 * The comments that share one view zone.
 *
 * Zones hang below a line, so every comment whose range ends on the same line
 * is drawn in the same zone, in the order it was made.
 */
export interface FileCommentGroup {
  readonly endLine: number;
  readonly entries: readonly FileCommentAnnotationEntry[];
}

/** The part of a Monaco range this module reads. */
export interface AnchorRange {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

/**
 * Where to put a comment's tracked decoration, and how to read it back.
 *
 * The offsets exist because the decoration does not cover exactly the commented
 * lines. See `anchorForLines` for why it cannot.
 */
export interface CommentAnchor {
  readonly range: AnchorRange;
  readonly startLineOffset: number;
  readonly endLineOffset: number;
}

/** Groups comments into one entry per view zone, ordered down the file. */
export function groupEntriesByEndLine(
  entries: ReadonlyArray<FileCommentAnnotationEntry>,
): FileCommentGroup[] {
  const byEndLine = new Map<number, FileCommentAnnotationEntry[]>();
  for (const entry of entries) {
    const group = byEndLine.get(entry.endLine);
    if (group === undefined) byEndLine.set(entry.endLine, [entry]);
    else group.push(entry);
  }
  return [...byEndLine.entries()]
    .sort(([left], [right]) => left - right)
    .map(([endLine, groupEntries]) => ({ endLine, entries: groupEntries }));
}

/**
 * The decoration that anchors a comment to its lines. It reaches into the newline that ends the
 * range (or the one before it at end of file), so it is never empty while the lines exist: an
 * empty range means deletion and nothing else. The offsets recover the commented lines.
 */
export function anchorForLines(
  startLine: number,
  endLine: number,
  lineCount: number,
  maxColumnOf: (line: number) => number,
): CommentAnchor {
  // The usual case: take the newline that ends the last commented line, by
  // reaching to the first column of the line after it.
  if (endLine < lineCount) {
    return {
      range: {
        startLineNumber: startLine,
        startColumn: 1,
        endLineNumber: endLine + 1,
        endColumn: 1,
      },
      startLineOffset: 0,
      endLineOffset: -1,
    };
  }

  // The range ends at the last line of the file, so there is no newline after
  // it. The line's own text will do, when it has any.
  const lastColumn = maxColumnOf(endLine);
  if (lastColumn > 1 || startLine < endLine) {
    return {
      range: {
        startLineNumber: startLine,
        startColumn: 1,
        endLineNumber: endLine,
        endColumn: lastColumn,
      },
      startLineOffset: 0,
      endLineOffset: 0,
    };
  }

  // One blank line at the end of the file. Reach backwards instead, for the
  // newline that ends the line before it.
  if (startLine > 1) {
    return {
      range: {
        startLineNumber: startLine - 1,
        startColumn: maxColumnOf(startLine - 1),
        endLineNumber: endLine,
        endColumn: 1,
      },
      startLineOffset: 1,
      endLineOffset: 0,
    };
  }

  // A file that is one blank line. There is no character anywhere to anchor to,
  // and nothing the user could delete that would not also delete the comment's
  // only line, so the empty range is accurate here.
  return {
    range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
    startLineOffset: 0,
    endLineOffset: 0,
  };
}

/**
 * Where a comment sits after Monaco remapped its anchor, or `null` when its lines are gone:
 * the decoration id is missing, or the range collapsed to empty, which `anchorForLines` never
 * creates for a line that still exists.
 */
export function entryAfterModelChange(
  entry: FileCommentAnnotationEntry,
  anchor: Pick<CommentAnchor, "startLineOffset" | "endLineOffset">,
  range: AnchorRange | null,
): FileCommentAnnotationEntry | null {
  if (range === null) return null;
  if (range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn) {
    return null;
  }
  const startLine = Math.max(1, range.startLineNumber + anchor.startLineOffset);
  const endLine = Math.max(startLine, range.endLineNumber + anchor.endLineOffset);
  if (startLine === entry.startLine && endLine === entry.endLine) return entry;
  return { ...entry, startLine, endLine };
}
