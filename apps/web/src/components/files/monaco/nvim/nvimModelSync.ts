/**
 * Neovim's view of the text, as Monaco edit operations.
 *
 * Pure on purpose: the driver that applies these owns a live editor and is
 * awkward to test, while the arithmetic is where the mistakes are and it is
 * all here.
 *
 * Two coordinate systems meet in this file and they agree about nothing.
 * Neovim counts lines from zero and gives half-open ranges, so `first` is the
 * first line replaced and `last` is one past it. Monaco counts lines and
 * columns from one and gives closed ranges. Rather than convert at the edges
 * and hope, every function here takes Neovim's terms and returns Monaco's.
 *
 * The second rule is that an edit which changes nothing must not be produced.
 * Monaco moves decorations, markers and the caret for an applied edit, so
 * replacing a line with an identical line is a visible event.
 */

/** A Monaco range, in Monaco's own one-based closed terms. */
export interface MonacoRange {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

export interface MonacoEdit {
  readonly range: MonacoRange;
  readonly text: string;
}

/** One `nvim_buf_lines_event`, in Neovim's terms. */
export interface NvimLinesEvent {
  readonly first: number;
  readonly last: number;
  readonly lines: ReadonlyArray<string>;
}

/**
 * A column past the end of any line.
 *
 * Monaco clamps a column beyond a line's length to that line's end, which is
 * how a range reaches "the end of the buffer" without first asking how long
 * the last line is.
 */
const END_OF_LINE = Number.MAX_SAFE_INTEGER;

/**
 * The edits that apply one lines event to a model of `lineCount` lines.
 *
 * Four shapes come out of this, and they differ only in what the range can
 * anchor to. A replacement in the middle spans whole lines, so it starts at
 * the first column of `first` and ends at the first column of `last` — taking
 * the trailing newline with it, which is why the replacement text carries one.
 * A whole-buffer reset (`last === -1`) spans everything. An append, where
 * `first` is already past the last line, has no line to anchor to: it hangs
 * off the end of the last line and brings its own leading newline. And a
 * replacement that reaches the buffer's current last line has no line `last`
 * to end on, so it ends at the end of the text and brings no newline at all.
 *
 * The last of the four is the one a test written from the arithmetic does not
 * think of, and it is the everyday case: it is what typing on the last line of
 * a file produces.
 */
export function editsForLinesEvent(
  lineCount: number,
  event: NvimLinesEvent,
): ReadonlyArray<MonacoEdit> {
  if (event.last === -1) {
    return [
      {
        range: {
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: Math.max(1, lineCount),
          endColumn: END_OF_LINE,
        },
        text: event.lines.join("\n"),
      },
    ];
  }

  const startLine = event.first + 1;
  const endLine = event.last + 1;

  if (startLine > lineCount) {
    // Past the end. There is no line `startLine` to put a range on, so the
    // edit is an insertion at the very end of the text, carrying the newline
    // that separates it from what is already there.
    const anchor = Math.max(1, lineCount);
    return [
      {
        range: {
          startLineNumber: anchor,
          startColumn: END_OF_LINE,
          endLineNumber: anchor,
          endColumn: END_OF_LINE,
        },
        text: `\n${event.lines.join("\n")}`,
      },
    ];
  }

  if (endLine > lineCount) {
    // The replacement reaches the buffer's current last line, so there is no
    // line `endLine` to anchor the end of the range on. Monaco clamps a line
    // past the end of the text to the end of the text, which leaves the
    // trailing newline of the replacement with nothing after it and adds a
    // blank line. Measured against a real Neovim: `G` `A` `!` on a two-line
    // buffer produced `["one", "two!", ""]` before this branch existed.
    const lastLine = Math.max(1, lineCount);

    if (event.lines.length === 0) {
      // A deletion that reaches the end has to take the newline *before* it,
      // or the line above survives as an empty one.
      const start =
        startLine > 1
          ? { startLineNumber: startLine - 1, startColumn: END_OF_LINE }
          : { startLineNumber: 1, startColumn: 1 };
      return [
        {
          range: { ...start, endLineNumber: lastLine, endColumn: END_OF_LINE },
          text: "",
        },
      ];
    }

    return [
      {
        range: {
          startLineNumber: startLine,
          startColumn: 1,
          endLineNumber: lastLine,
          endColumn: END_OF_LINE,
        },
        text: event.lines.join("\n"),
      },
    ];
  }

  const text = event.lines.length === 0 ? "" : `${event.lines.join("\n")}\n`;
  return [
    {
      range: {
        startLineNumber: startLine,
        startColumn: 1,
        endLineNumber: endLine,
        endColumn: 1,
      },
      text,
    },
  ];
}

/**
 * The edits that reconcile a model with a whole snapshot.
 *
 * Line by line rather than as one replacement of everything, because a
 * snapshot arrives when a client attaches to a session that is already running
 * and the model is usually almost right. Replacing the whole text would move
 * every decoration and the caret to reproduce a handful of differences.
 */
export function editsForSnapshot(
  current: ReadonlyArray<string>,
  target: ReadonlyArray<string>,
): ReadonlyArray<MonacoEdit> {
  // Neither Neovim nor Monaco has a buffer with no lines in it, so a caller
  // asking for one is asking for the empty document: one line, with nothing on
  // it. Without this the per-line loop below runs zero times and the tail
  // delete starts at the end of line 1, which leaves line 1's old text on
  // screen with everything after it gone.
  const snapshot = target.length === 0 ? [""] : target;
  const edits: MonacoEdit[] = [];
  const shared = Math.min(current.length, snapshot.length);

  for (let index = 0; index < shared; index += 1) {
    if (current[index] === snapshot[index]) continue;
    const line = index + 1;
    edits.push({
      range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: END_OF_LINE },
      text: snapshot[index] ?? "",
    });
  }

  if (snapshot.length > current.length) {
    const anchor = Math.max(1, current.length);
    const tail = snapshot.slice(current.length).join("\n");
    const last = edits[edits.length - 1];
    if (last !== undefined && last.range.startLineNumber === anchor) {
      // The line the new text hangs off is itself being replaced. Left as two
      // edits they start at the same position — the end of a line that the
      // other edit is rewriting — and Monaco's order between them decides the
      // result. One edit that carries both is the only version with a single
      // answer. Reached whenever the last line changed and lines were added
      // after it, which is what `o` on the last line of a file does.
      edits[edits.length - 1] = { range: last.range, text: `${last.text}\n${tail}` };
    } else {
      edits.push({
        range: {
          startLineNumber: anchor,
          startColumn: END_OF_LINE,
          endLineNumber: anchor,
          endColumn: END_OF_LINE,
        },
        text: `\n${tail}`,
      });
    }
  } else if (current.length > snapshot.length) {
    // From the end of the last line that survives to the end of the text, so
    // the newline joining it to the first doomed line goes too.
    const anchor = Math.max(1, snapshot.length);
    edits.push({
      range: {
        startLineNumber: anchor,
        startColumn: END_OF_LINE,
        endLineNumber: current.length,
        endColumn: END_OF_LINE,
      },
      text: "",
    });
  }

  return edits;
}
