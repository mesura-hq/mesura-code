/**
 * How wide a grid the host gives Neovim's window.
 *
 * With 'nowrap', a cursor that reaches the grid's last column scrolls the
 * window sideways, and every cell after that is read against the wrong buffer
 * character unless the classification knows the shift (`GridModel`'s
 * `leftcol`). The cheap way to keep `leftcol` at 0 is a grid wider than any
 * line the cursor can reach: the cells past the text are blanks, which Neovim
 * sends as one repeated cell per row and which classify as nothing.
 *
 * The host owns this rather than the client, because only the host sees every
 * key. A client sizes its request to what it shows and sends one only when it
 * scrolls, so typing at the end of the widest line ran past its width a key
 * at a time with no new request — measured on the bench's Markdown: `A` on a
 * 940-character line in a 940-column grid scrolled the window at once, and 40
 * typed characters scrolled it 40 times. The client's `cols` is a floor here.
 *
 * Bounded, because the grid is memory and work on both sides: `GridModel`
 * keeps a cell per column per row and reads every one of them on each frame
 * that changed. A line wider than `MAX_GRID_COLUMNS` scrolls the window
 * sideways when the cursor goes past the bound, and the classification then
 * reads it against `leftcol` — correct, only costlier, because every row
 * redraws when the window shifts.
 *
 * @module gridWidth
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
 * Widths already measured, by tabstop and then by the line's text.
 *
 * This runs before every key batch, over three windows of lines, so it has to
 * cost what changed rather than what is on screen: measured on seven rows of
 * 1,100-character lines with one accent each, measuring every line every time
 * took 90 ms a batch, against 0.01 ms for ASCII. The key is the text itself,
 * so an edited line is measured again and an unchanged one is a lookup; the
 * mirror hands the same string objects back until a line changes, and V8
 * keeps a string's hash on the string.
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
 * The width to give the grid for a viewport request of `requested` columns,
 * when it is `current` columns wide now.
 *
 * A grid that already fits keeps its width unless it is more than
 * `2 * SPARE_COLUMNS` wider than needed. A resize makes Neovim redraw every
 * row and the host re-send every row's decorations, and a width recomputed
 * exactly on each scroll would change on most scroll steps of an ordinary
 * source file, whose widest reachable line changes as lines come into view.
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
 * Whether `keys`, sent in `mode`, can widen a line by more than the keys
 * themselves spell.
 *
 * A put (`p`, `P`, `<C-r>` in insert mode), a repeat (`.`), a macro (`@`), a
 * join (`J`), a count or an Ex command can add any number of cells, and the
 * register or the command is Neovim's to know. The host cannot grow from the
 * change instead: measured, Neovim sends the change and the frame that scrolls
 * for it in one burst, so the scroll has already happened when the host hears
 * of the change. Typed text in insert mode is its own width, so a `p` typed
 * there reserves nothing.
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
 * How many key batches a reservation outlives.
 *
 * Long enough that the viewport requests between two counted or repeated
 * keys do not shrink the grid only for the next key to widen it again: each
 * resize redraws every row. Measured by "widens the grid at most once for a
 * burst of counts and repeats on short lines", which saw three resizes in
 * twelve keys when every viewport could shrink a reserved grid.
 */
export const RESERVATION_BATCHES = 20;

/**
 * The width to grow the grid to before `pendingCells` more cells may land on
 * the cursor's line, or `null` when the grid already has room.
 *
 * `pendingCells` overestimates on purpose: the keys about to be sent, counted
 * as if each character were typed text. Key notation (`<Esc>`) is shorter on
 * screen than in the batch, so the grid at worst grows a little early.
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
