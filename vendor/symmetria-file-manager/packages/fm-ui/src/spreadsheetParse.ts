import {
  type CappedGrid,
  type CellValue,
  capGrid,
  formatCell,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_ROWS,
} from "@symmetria/fm-core/preview/sheet";
import * as XLSX from "xlsx";

/**
 * Bytes to a grid, using SheetJS.
 *
 * ── Separate from the worker that calls it, on purpose ──────────────────────
 * `spreadsheet.worker.ts` is a worker entry point: importing it runs
 * `self.addEventListener` and it cannot be reached from a test. Everything
 * worth testing lives here, where a workbook can be built in memory, parsed
 * back and checked without a browser.
 *
 * ── Why SheetJS, and why from the vendor's own tarball ──────────────────────
 * 80 of this operator's 98 spreadsheets are genuine legacy `.xls` — OLE2
 * compound documents, verified by content rather than by extension. ExcelJS is
 * healthier and better maintained and reads only `.xlsx`, so it would fail on
 * four of every five of them. SheetJS left npm in 2022; the copy still on the
 * registry is frozen at 0.18.5 and carries two HIGH advisories fixed in
 * releases the registry never received. The dependency therefore points at
 * `cdn.sheetjs.com` with the hash pinned in the lockfile — see
 * `packages/fm-ui/package.json`, and do NOT "tidy" it back to a registry name.
 */

/**
 * How many rows the parser itself is allowed to read.
 *
 * One more than the display cap, so that "there are more rows than we show" is
 * still detectable: capping the parse at exactly the display cap would make a
 * sheet of precisely that many rows indistinguishable from a longer one.
 */
const MAX_PARSED_ROWS = MAX_SHEET_ROWS + 1;

export type ParsedWorkbook =
  | {
      readonly kind: "workbook";
      /** Every sheet's name, for the tab strip. One workbook here has 76. */
      readonly sheetNames: readonly string[];
      /** Which one `grid` holds, which may not be the one that was asked for. */
      readonly activeSheet: number;
      readonly grid: CappedGrid;
    }
  /**
   * Corrupt, encrypted, not a spreadsheet, or a workbook with no sheets at all.
   * Named rather than thrown: the worker's caller has no catch, so a throw
   * becomes an unhandled rejection and the pane shows nothing with no reason.
   */
  | { readonly kind: "unreadable" };

/**
 * Narrow one of the parser's cell values into the closed set the formatter takes.
 *
 * This is the I/O boundary. Everything past it works with `CellValue`, and
 * anything the parser produces that is not on that list — an object, a
 * function, a symbol — becomes an empty cell rather than a `[object Object]`.
 */
function asCellValue(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return value instanceof Date ? value : null;
}

/**
 * One cell, as the text a reader sees.
 *
 * ── A date is formatted HERE; everything else keeps the workbook's own text ──
 * This split is the whole reason the cells are walked by hand rather than run
 * through `sheet_to_json({ raw: false })`, which was the first attempt.
 *
 * That call returns the workbook's OWN rendering for every cell, which is
 * exactly right for a currency or a percentage — the column then reads the way
 * it reads in the source file. For a date it is wrong: measured against the
 * pinned parser, a date cell comes back as `"9/1/26"`, a two-digit year in an
 * order that means one thing to one reader and another to the next. Review
 * caught it, and the comment claiming the ISO formatter prevented that
 * ambiguity was describing a branch nothing ever reached.
 *
 * `cell.v` for a date cell is a `Date` at UTC midnight — confirmed by reading a
 * raw serial, the way a real file stores one — so `formatCell`'s UTC getters
 * agree with what the spreadsheet means. Local getters would be a day out.
 */
function cellText(cell: XLSX.CellObject | undefined): string {
  if (cell === undefined) return "";
  if (cell.t === "d") return formatCell(asCellValue(cell.v));
  if (typeof cell.w === "string" && cell.w !== "") return cell.w;
  return formatCell(asCellValue(cell.v));
}

/**
 * The rows of one sheet, as text, bounded one past each cap.
 *
 * One past, so that `capGrid` can still tell "exactly at the cap" from "more
 * than the cap" and report the truncation. Reading the sheet's full declared
 * width would mean walking up to 16384 columns per row for a sheet whose
 * `!ref` claims them.
 */
function rowsOf(sheet: XLSX.WorkSheet): string[][] {
  const ref = sheet["!ref"];
  if (ref === undefined) return [];

  const range = XLSX.utils.decode_range(ref);
  const lastRow = Math.min(range.e.r, range.s.r + MAX_SHEET_ROWS);
  const lastColumn = Math.min(range.e.c, range.s.c + MAX_SHEET_COLUMNS);

  const rows: string[][] = [];
  for (let r = range.s.r; r <= lastRow; r++) {
    const row: string[] = [];
    for (let c = range.s.c; c <= lastColumn; c++) {
      row.push(cellText(sheet[XLSX.utils.encode_cell({ r, c })]));
    }
    // Trailing blanks are dropped, and that is not tidiness. The walk is bounded
    // by the SHEET's declared width, so one wide row anywhere — including one
    // below the row cap — pads every other row out to that width with empties.
    // `capGrid` would then measure them as real columns and report a truncation
    // that dropped nothing. A guard caught this the first time it was written.
    while (row.length > 0 && row[row.length - 1] === "") row.pop();
    rows.push(row);
  }
  return rows;
}

/**
 * Read `bytes` and return the sheet at `wanted`.
 *
 * Never throws. Every failure — corrupt bytes, an encrypted workbook, a file
 * that is not a spreadsheet at all — comes back as `unreadable`.
 *
 * @param wanted which sheet to return. Out of range falls back to the first,
 *   because the pane resets its chosen sheet when the file changes and a race
 *   between that and a stale index must not produce an empty grid.
 */
export function readWorkbook(bytes: Uint8Array, wanted: number): ParsedWorkbook {
  try {
    // ── Two passes, and the second one parses ONE sheet ────────────────────
    // The names are wanted for the tab strip and the cells are wanted for one
    // sheet only. Reading everything costs the whole workbook every time the
    // cursor lands on it: measured on a 76-sheet, 12 MB workbook — 817 ms for
    // all sheets against 5 ms for the names plus 23 ms for the one shown.
    const index = XLSX.read(bytes, { type: "array", bookSheets: true });
    const sheetNames = index.SheetNames;
    // Reachable only from hand-crafted bytes — SheetJS's own writer refuses to
    // produce a workbook with no sheets — so this guard is deliberately
    // uncovered rather than covered by a fixture nobody could read.
    if (sheetNames.length === 0) return { kind: "unreadable" };

    const activeSheet = wanted >= 0 && wanted < sheetNames.length ? wanted : 0;
    // SAFETY: `sheetNames` is non-empty (the guard above returned otherwise)
    // and `activeSheet` is either an index proven in range or 0.
    const name = sheetNames[activeSheet] as string;

    const book = XLSX.read(bytes, {
      type: "array",
      cellDates: true,
      sheets: [name],
      // Bounds the PARSE and not only the output, which is what keeps a large
      // sheet cheap rather than merely quiet.
      sheetRows: MAX_PARSED_ROWS,
    });

    const sheet = book.Sheets[name];
    if (sheet === undefined) return { kind: "unreadable" };

    return { kind: "workbook", sheetNames, activeSheet, grid: capGrid(rowsOf(sheet)) };
  } catch {
    return { kind: "unreadable" };
  }
}

/**
 * The largest workbook this will read.
 *
 * ── What this bounds, and what it does not ──────────────────────────────────
 * It bounds the COMPRESSED bytes, and an xlsx or an ods is a ZIP. Review asked
 * whether that is the wrong shape here for the same reason it was wrong for
 * audio, and the honest answer is that **I could not establish an expansion
 * ratio**: two attempts to measure one in-process were defeated by garbage
 * collection and by a baseline the fixture itself had already inflated. So this
 * comment states what IS bounded rather than claiming a ratio nobody measured.
 *
 * Bounded:
 *   - the bytes fetched and held, by this constant;
 *   - the rows parsed per sheet, by `sheetRows`;
 *   - the columns read per row, by `rowsOf`;
 *   - the number of SHEETS parsed, which is now exactly one — see
 *     `readWorkbook`. Measured on a 76-sheet workbook, that took the parse from
 *     817 ms to 23 ms, and it removes the per-sheet multiplier entirely.
 *
 * NOT bounded: the decompressed size of `sharedStrings.xml` and `styles.xml`,
 * which SheetJS reads whole whatever else is capped. A deliberately crafted
 * file can therefore still cost more memory than its compressed size suggests.
 * SheetJS has shipped a CVE of exactly that class before (CVE-2021-32013).
 *
 * 8 MB rather than the 32 this started at, for that reason: it is still twelve
 * times the operator's largest real workbook (657 kB) and it cuts the worst
 * case fourfold. The parser runs in the sandboxed renderer precisely so that
 * the damage from what is not bounded stops at a wedged preview pane.
 */
export const MAX_WORKBOOK_BYTES = 8 * 1024 * 1024;

/**
 * Fetch a previewed workbook and read one of its sheets.
 *
 * Here rather than in the worker for the reason the header states: importing
 * the worker runs its listener, so nothing in it can be reached from a test.
 * This is everything the worker does apart from receiving the message.
 *
 * Never throws.
 */
export async function fetchWorkbook(url: string, sheet: number): Promise<ParsedWorkbook> {
  try {
    const response = await fetch(url);
    if (!response.ok) return { kind: "unreadable" };

    // Refuse on the declared length before reading the body. The preview scheme
    // always declares one — see `app/src/main/fileRange.ts`.
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_WORKBOOK_BYTES) {
      await response.body?.cancel();
      return { kind: "unreadable" };
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    // And again from the buffer's own length: the header is advisory.
    if (bytes.byteLength > MAX_WORKBOOK_BYTES) return { kind: "unreadable" };

    return readWorkbook(bytes, sheet);
  } catch {
    // `readWorkbook` does not throw, so this catches the fetch alone.
    return { kind: "unreadable" };
  }
}
