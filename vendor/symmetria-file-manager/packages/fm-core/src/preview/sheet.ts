/**
 * What a spreadsheet preview shows, decided without a spreadsheet.
 *
 * The formatting and the caps live here, away from the parser, because they are
 * arithmetic and string work with no library in them — so they can be checked
 * against constructed input rather than against a workbook.
 *
 * **Both halves run on the WORKER thread**, which is the point rather than an
 * implementation detail: the pane that draws the grid does no per-cell work at
 * all, and everything it receives is already text. The Qt build's
 * `SpreadsheetPreviewModel` records the same decision for the same reason —
 * its `data()` returns a pre-formatted string and nothing else.
 *
 * `packages/fm-core` compiles against NO environment, so nothing here may reach
 * for `Intl`, the DOM or Node.
 */

/**
 * How much of a sheet a preview shows.
 *
 * 200 by 50, matching the Qt build. A preview does not need the whole sheet,
 * and the count bounds the parse and the number of elements drawn at once.
 */
export const MAX_SHEET_ROWS = 200;
export const MAX_SHEET_COLUMNS = 50;

/**
 * A cell's value, once the parser's output has been narrowed at its boundary.
 *
 * The narrowing belongs to the worker, which is where untrusted bytes turn into
 * values. Everything downstream of that point works with this closed set.
 */
export type CellValue = string | number | boolean | Date | null;

export interface CappedGrid {
  /** Rows of already-formatted text, every row the same width. */
  readonly rows: readonly (readonly string[])[];
  /** Whether rows past the cap were dropped. */
  readonly truncatedRows: boolean;
  /** Whether columns past the cap were dropped. Reported separately. */
  readonly truncatedColumns: boolean;
}

/** Two digits, for a clock or a calendar. */
function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * A date as it sorts.
 *
 * ISO rather than a locale format, because a preview is read down a column and
 * a locale format puts the day first for one reader and the month first for
 * another. The time is shown only when the value carries one, so a column of
 * plain dates does not grow six characters of zeroes.
 */
function formatDate(value: Date): string {
  const time = value.getTime();
  // A spreadsheet can hold a serial number outside the range a date covers, and
  // the parser hands that over as an invalid `Date`. `Invalid Date` on screen
  // looks like data.
  if (!Number.isFinite(time)) return "";

  const day = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  const hours = value.getUTCHours();
  const minutes = value.getUTCMinutes();
  const seconds = value.getUTCSeconds();

  if (hours === 0 && minutes === 0 && seconds === 0) return day;
  if (seconds === 0) return `${day} ${pad(hours)}:${pad(minutes)}`;
  return `${day} ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/**
 * One cell, as the text a reader sees.
 *
 * **An unknown value is an EMPTY cell, never the word for it.** `String(value)`
 * writes `undefined`, `NaN` and `Infinity` into the grid, and all three look
 * like data to somebody scanning a column. A blank is the honest answer and it
 * is also what the source file shows.
 */
export function formatCell(value: CellValue): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return formatDate(value);
}

/**
 * Trim a grid to what the pane will draw, and square it off.
 *
 * Two flags rather than one, because the pane says WHICH direction it is not
 * showing and a sheet can be cut in one while whole in the other.
 *
 * **The width is the widest row's, not the first row's.** A spreadsheet's rows
 * are ragged — a three-column header above a sixty-column table is ordinary —
 * so measuring the first row alone reports a sheet as complete while dropping
 * most of it.
 */
export function capGrid(rows: readonly (readonly string[])[]): CappedGrid {
  const kept = rows.slice(0, MAX_SHEET_ROWS);
  // Measured over the rows that will be SHOWN, not over every row read. A wide
  // row past the row cap would otherwise raise `truncatedColumns` while no
  // column visible on screen had been cut — a warning about nothing, which is
  // how a reader learns to ignore the warnings that mean something.
  const widest = kept.reduce((width, row) => Math.max(width, row.length), 0);
  const keptColumns = Math.min(widest, MAX_SHEET_COLUMNS);

  return {
    // Squared off: a grid whose rows differ in length cannot be drawn as a
    // table without the caller re-checking every row at every cell.
    rows: kept.map((row) => Array.from({ length: keptColumns }, (_, column) => row[column] ?? "")),
    truncatedRows: rows.length > MAX_SHEET_ROWS,
    truncatedColumns: widest > MAX_SHEET_COLUMNS,
  };
}
