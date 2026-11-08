/**
 * Neovim's view of the text as Monaco edits, pure so the arithmetic is testable. Every function
 * takes Neovim's terms (zero-based lines, half-open: `last` is one past) and returns Monaco's
 * (one-based, closed). An edit that changes nothing is never produced: Monaco would move
 * decorations and caret.
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
 * The edits for one lines event on a model of `lineCount` lines. A middle replacement spans whole
 * lines and carries a trailing newline; `last === -1` resets everything; an append hangs off the
 * last line with a leading newline; a replacement reaching the last line ends at the end of the
 * text with no newline. That last shape is the everyday one: typing on a file's last line.
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
    // Reaching the current last line, there is no `endLine` to anchor on, and Monaco's clamping
    // would leave a blank line (`G` `A` `!` on two lines gave `["one", "two!", ""]`).
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
 * The edits that reconcile a model with a whole snapshot, line by line: on attach the model is
 * usually almost right, and a whole-text replace would move every decoration and the caret.
 */
export function editsForSnapshot(
  current: ReadonlyArray<string>,
  target: ReadonlyArray<string>,
): ReadonlyArray<MonacoEdit> {
  // Neither Neovim nor Monaco has a zero-line buffer, so an empty target means one empty line.
  // Without this the tail delete leaves line 1's old text on screen.
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
      // The line the tail hangs off is itself being replaced; as two edits at one position,
      // Monaco's order would decide the result. One combined edit has one answer (`o` on the last
      // line).
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
