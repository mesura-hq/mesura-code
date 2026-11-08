/**
 * Neovim's window, read off the editor the developer sees. Monaco owns pointer and wheel scrolling,
 * Neovim owns key scrolling, and each tells the other. `shouldEchoViewport` drops a topline either
 * side sent recently (see `REMEMBERED_TOPLINES`). Neovim draws nothing past the grid's width, so a
 * grid sized to the text hides flash labels at line ends.
 */

import { EDITOR_VIEWPORT_MAX_COLS, type EditorViewportSource } from "@t3tools/contracts";

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
  /** Who moved the window; see `EditorViewportSource`. Absent means keys. */
  readonly source?: EditorViewportSource;
}

export interface ViewportHistory {
  /** The toplines this client recently sent to Neovim, oldest first. */
  readonly sentToplines: ReadonlyArray<number>;
  /** The toplines Neovim recently sent to this client, oldest first. */
  readonly neovimToplines: ReadonlyArray<number>;
}

export const EMPTY_VIEWPORT_HISTORY: ViewportHistory = { sentToplines: [], neovimToplines: [] };

/**
 * How many toplines each side remembers. One is too few (measured): a wheel outruns the round trip,
 * and a stale echo scrolls the editor back. Eight covers a burst without mistaking a real jump
 * back.
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
 * The floor on grid width, so a flash label at the end of an ordinary line is inside the grid and
 * gets drawn. Blank cells past the text cost nothing.
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

  // Clamped to what the contract accepts: a request past it is refused whole,
  // topline and rows included. The host widens the grid past the widest line
  // itself, so the clamp costs no column the developer can see.
  return { topline, rows, cols: Math.min(widest, EDITOR_VIEWPORT_MAX_COLS) };
}

/**
 * Whether scrolling Monaco to `targetTop` would hide the caret: Monaco may wrap and Neovim does
 * not, so following Neovim's topline can leave the caret below Monaco's last row. The caret wins.
 */
export function followingHidesCaret(input: {
  readonly targetTop: number;
  readonly caretTop: number;
  readonly lineHeight: number;
  readonly height: number;
}): boolean {
  return (
    input.caretTop < input.targetTop ||
    input.caretTop + input.lineHeight > input.targetTop + input.height
  );
}

export function shouldEchoViewport(history: ViewportHistory, topline: number): boolean {
  if (history.sentToplines.includes(topline)) return false;
  if (history.neovimToplines.includes(topline)) return false;
  return true;
}
