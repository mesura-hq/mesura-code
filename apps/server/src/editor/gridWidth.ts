/**
 * Sizes Neovim's grid wider than any line the cursor can reach, so 'nowrap' never scrolls it
 * sideways and `leftcol` stays 0. The host owns this because only it sees every key; the
 * client's `cols` is a floor. Past `MAX_GRID_COLUMNS` the window scrolls and `GridModel` reads
 * the row against `leftcol`: correct, but every row redraws.
 */
import { displayWidth } from "./GridModel.ts";

/** The most columns the host gives a grid; see the module note. */
export const MAX_GRID_COLUMNS = 2048;

/** Columns kept free past the widest line the grid has to hold. */
export const SPARE_COLUMNS = 128;

/**
 * How close the widest line may come to the grid's edge before a key widens
 * the grid. Below `SPARE_COLUMNS`, so a burst of typing grows the grid once
 * every `SPARE_COLUMNS - GROW_HEADROOM` characters rather than on every key.
 */
export const GROW_HEADROOM = 32;

export interface GridWidthInput {
  /** The buffer, as the host mirrors it. */
  readonly lines: ReadonlyArray<string>;
  /** The first buffer line of the window, one-based. */
  readonly topline: number;
  readonly rows: number;
  readonly tabstop: number;
}

/**
 * The widest line the cursor can reach without the window scrolling first:
 * the window's own lines, and one window's worth either side of it, because
 * `j` or `k` at the window's edge brings a line in and `$` can follow at once.
 */
export function widestReachableLine(input: GridWidthInput): number {
  const first = Math.max(1, input.topline - input.rows);
  const last = Math.min(input.lines.length, input.topline + 2 * input.rows - 1);
  let widest = 0;
  for (let line = first; line <= last; line += 1) {
    const width = lineWidth(input.lines[line - 1] ?? "", input.tabstop);
    if (width > widest) widest = width;
    if (widest >= MAX_GRID_COLUMNS) break;
  }
  return widest;
}

/**
 * Widths already measured, by tabstop and then by the line's text. This runs before every key
 * batch, and re-measuring non-ASCII lines cost 90 ms a batch. The mirror reuses a line's string
 * until it changes, so an unchanged line is a lookup on a hash V8 caches.
 */
const measuredWidths = new Map<number, Map<string, number>>();

/** Lines measured per tabstop before the memory is dropped and refilled. */
const MEASURED_WIDTHS_LIMIT = 4_000;

/** The display width of one line, counted no further than `MAX_GRID_COLUMNS`. */
function lineWidth(text: string, tabstop: number): number {
  // Plain printable ASCII is its length, and asking a map costs more.
  if (!/[^ -~]/.test(text)) return Math.min(text.length, MAX_GRID_COLUMNS);
  let widths = measuredWidths.get(tabstop);
  if (widths === undefined) {
    widths = new Map();
    measuredWidths.set(tabstop, widths);
  }
  const known = widths.get(text);
  if (known !== undefined) return known;
  if (widths.size >= MEASURED_WIDTHS_LIMIT) widths.clear();
  const width = Math.min(displayWidth(text, tabstop, MAX_GRID_COLUMNS), MAX_GRID_COLUMNS);
  widths.set(text, width);
  return width;
}

/**
 * The grid width for a viewport request of `requested` columns. A grid that fits keeps its
 * width unless it is more than `2 * SPARE_COLUMNS` too wide, because each resize redraws and
 * re-sends every row, and an exact width would change on most scroll steps.
 */
export function gridColumnsForViewport(
  requested: number,
  input: GridWidthInput,
  current: number,
  /** A reservation is still in force: a wider grid is kept, however wide. */
  reserved = false,
): number {
  const needed = Math.max(
    requested,
    Math.min(MAX_GRID_COLUMNS, widestReachableLine(input) + SPARE_COLUMNS),
  );
  if (current >= needed && (reserved || current - needed <= 2 * SPARE_COLUMNS)) return current;
  return needed;
}

/** Whether a line fits in `cols` columns, so the window has no reason to be scrolled. */
export function lineFits(text: string, tabstop: number, cols: number): boolean {
  return lineWidth(text, tabstop) < cols;
}

/**
 * Whether `keys` in `mode` can widen a line by more than they spell: a put, a repeat, a macro,
 * a join, a count or an Ex command. The host must grow first, because Neovim sends the change
 * and the scroll it causes in one burst. Typed text in insert mode is its own width.
 */
export function mayExpandUnpredictably(keys: string, mode: string): boolean {
  const inserting = mode.startsWith("i") || mode.startsWith("R");
  if (/<C-[rRoOaA]>/.test(keys)) return true;
  if (inserting) return false;
  if (/[pP.@J:&]/.test(keys)) return true;
  // A count on a motion or an operator (`3j`, `d2w`) widens nothing. On an
  // insert it repeats the inserted text that many times (`5ix<Esc>`).
  return /[1-9][0-9]*[iaIAoOsSCR]/.test(keys);
}

/**
 * How many key batches a reservation outlives: long enough that viewport requests between
 * counted or repeated keys do not shrink the grid for the next key to widen again.
 */
export const RESERVATION_BATCHES = 20;

/**
 * The width to grow the grid to before `pendingCells` more cells land on the cursor's line, or
 * `null` when it has room. `pendingCells` counts every key character as typed text, so key
 * notation (`<Esc>`) overestimates and the grid at worst grows a little early.
 */
export function grownGridColumns(
  current: number,
  input: GridWidthInput & {
    readonly cursorLine: number;
    readonly pendingCells: number;
    /** The keys may widen the line by any amount; see `mayExpandUnpredictably`. */
    readonly unpredictable?: boolean;
  },
): number | null {
  if (current >= MAX_GRID_COLUMNS) return null;
  if (input.unpredictable === true) return MAX_GRID_COLUMNS;
  const cursorLine = lineWidth(input.lines[input.cursorLine - 1] ?? "", input.tabstop);
  const widest = Math.max(widestReachableLine(input), cursorLine + input.pendingCells);
  if (widest + GROW_HEADROOM <= current) return null;
  return Math.min(MAX_GRID_COLUMNS, widest + SPARE_COLUMNS);
}
