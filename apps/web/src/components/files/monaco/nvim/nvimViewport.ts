/**
 * What Neovim's window should be, read off the editor the developer sees.
 *
 * Two authorities over one window. Monaco owns the scrolling a pointer or a
 * wheel caused, because that is a gesture Neovim never saw; Neovim owns the
 * scrolling a key caused, because that is a command Monaco never ran. Each
 * tells the other what it did, and the whole difficulty is that a message in
 * one direction looks exactly like a message in the other — so without a rule
 * the two scroll each other forever.
 *
 * The rule is `shouldEchoViewport`: a topline this client recently sent, or one
 * Neovim recently sent, is an echo, and an echo is dropped. Recently rather
 * than last, because a wheel outruns the round trip — see `REMEMBERED_TOPLINES`.
 *
 * The grid's size is not decoration. Neovim draws nothing past the grid's
 * width, so a flash label placed at the end of a long line is simply never
 * drawn on a grid sized to the text, and a label that is never drawn is a jump
 * target the developer cannot see.
 */

/** A line range Monaco reports as visible, in Monaco's one-based terms. */
export interface VisibleRange {
  readonly startLineNumber: number;
  readonly endLineNumber: number;
}

/** As much of Monaco's layout as sizing a grid needs. */
export interface EditorMetrics {
  readonly height: number;
  readonly lineHeight: number;
}

/** As much of a Monaco model as sizing a grid needs. */
export interface MeasurableModel {
  readonly getLineCount: () => number;
  readonly getLineContent: (lineNumber: number) => string;
}

export interface NvimViewport {
  /** The first visible buffer line, one-based, as Neovim counts `topline`. */
  readonly topline: number;
  readonly rows: number;
  readonly cols: number;
}

export interface ViewportHistory {
  /** The toplines this client recently sent to Neovim, oldest first. */
  readonly sentToplines: ReadonlyArray<number>;
  /** The toplines Neovim recently sent to this client, oldest first. */
  readonly neovimToplines: ReadonlyArray<number>;
}

export const EMPTY_VIEWPORT_HISTORY: ViewportHistory = { sentToplines: [], neovimToplines: [] };

/**
 * How many toplines each side remembers.
 *
 * One is not enough, and that is a measured shape rather than a cautious
 * guess. A wheel produces scrolls faster than the round trip answers them, so
 * the developer can scroll away and back before the first echo lands; with one
 * slot the stale echo fails the test and scrolls the editor back to where they
 * just left. Eight covers a burst without remembering a position long enough
 * for a genuine jump back to the same place to be mistaken for an echo.
 */
export const REMEMBERED_TOPLINES = 8;

/** Appends a topline to one side's memory, keeping it short. */
export function rememberTopline(
  toplines: ReadonlyArray<number>,
  topline: number,
): ReadonlyArray<number> {
  return [...toplines, topline].slice(-REMEMBERED_TOPLINES);
}

/**
 * The floor on grid width.
 *
 * Wide enough that a flash label at the end of an ordinary line of code is
 * still inside the grid, which is what makes it drawn at all. Costs nothing:
 * the cells beyond the text are blanks, and blanks are neither an overlay nor
 * a highlight run.
 */
export const MINIMUM_VIEWPORT_COLUMNS = 200;

export function viewportFromEditor(
  visibleRanges: ReadonlyArray<VisibleRange>,
  metrics: EditorMetrics,
  model: MeasurableModel,
): NvimViewport {
  const first = visibleRanges[0];
  const last = visibleRanges[visibleRanges.length - 1];

  if (first === undefined || last === undefined) {
    // Called before Monaco has laid out, where it reports nothing visible.
    // Rows from the height is the best answer available, and it is a much
    // better one than zero, which would resize Neovim's grid to nothing.
    const lineHeight = metrics.lineHeight > 0 ? metrics.lineHeight : 1;
    return {
      topline: 1,
      rows: Math.max(1, Math.floor(metrics.height / lineHeight)),
      cols: MINIMUM_VIEWPORT_COLUMNS,
    };
  }

  // The span, not the sum of the ranges. Folding splits what Monaco reports
  // into several ranges, and Neovim has one window with one topline: what the
  // developer can see runs from the first visible line to the last.
  const topline = first.startLineNumber;
  const rows = Math.max(1, last.endLineNumber - topline + 1);

  let widest = MINIMUM_VIEWPORT_COLUMNS;
  const lineCount = model.getLineCount();
  for (const range of visibleRanges) {
    const end = Math.min(range.endLineNumber, lineCount);
    for (let line = Math.max(1, range.startLineNumber); line <= end; line += 1) {
      const width = model.getLineContent(line).length;
      if (width > widest) widest = width;
    }
  }

  return { topline, rows, cols: widest };
}

export function shouldEchoViewport(history: ViewportHistory, topline: number): boolean {
  if (history.sentToplines.includes(topline)) return false;
  if (history.neovimToplines.includes(topline)) return false;
  return true;
}
