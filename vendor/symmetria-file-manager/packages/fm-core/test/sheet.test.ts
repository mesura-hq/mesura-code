import { describe, expect, it } from "vitest";

import {
  type CellValue,
  capGrid,
  formatCell,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_ROWS,
} from "../src/preview/sheet.ts";

/**
 * What a spreadsheet preview shows, decided without a spreadsheet.
 *
 * The formatting and the caps are arithmetic and string work, so they belong
 * here where they can be checked against constructed input rather than against
 * a parser. Whether SheetJS reads a real `.xls` is a different question and a
 * different test.
 *
 * Both halves are done on the WORKER thread deliberately, so the pane that
 * draws a grid does no per-cell work at all — the same decision the Qt build's
 * `SpreadsheetPreviewModel` records in its own header.
 */

/** A row of `count` cells, each carrying its own index. */
function row(count: number, prefix = "c"): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}

/** `count` rows, each `width` wide. */
function grid(count: number, width: number): string[][] {
  return Array.from({ length: count }, (_, r) => row(width, `r${r}c`));
}

describe("what a cell says", () => {
  it("shows a string as itself", () => {
    expect(formatCell("Total")).toBe("Total");
  });

  it("shows a number without decoration", () => {
    expect(formatCell(1234.5)).toBe("1234.5");
    expect(formatCell(0)).toBe("0");
    expect(formatCell(-7)).toBe("-7");
  });

  it("shows a boolean as a word", () => {
    expect(formatCell(true)).toBe("true");
    expect(formatCell(false)).toBe("false");
  });

  it("shows a date the way it sorts", () => {
    // ISO, because a preview is read across a column and a locale format would
    // put the day first for one reader and the month first for another.
    expect(formatCell(new Date(Date.UTC(2026, 8, 2)))).toBe("2026-09-02");
  });

  it("keeps the time when a date carries one", () => {
    expect(formatCell(new Date(Date.UTC(2026, 8, 2, 14, 30)))).toBe("2026-09-02 14:30");
  });

  it("shows an empty cell as empty, never as a word", () => {
    // The failure this exists to prevent is a grid full of `undefined`, which
    // is what `String(value)` produces and what a reader assumes is data.
    expect(formatCell(null)).toBe("");
  });

  it("shows a date that is not a date as empty rather than as nonsense", () => {
    // A spreadsheet can hold a serial number outside the range a date can
    // represent, and the parser hands it over as an invalid `Date`.
    expect(formatCell(new Date(Number.NaN))).toBe("");
  });

  it("shows a number that is not a number as empty", () => {
    // A division by zero in the source file arrives as an error, and `NaN` on
    // screen is worse than a blank because it looks like a value.
    expect(formatCell(Number.NaN)).toBe("");
    expect(formatCell(Number.POSITIVE_INFINITY)).toBe("");
  });
});

describe("capping the grid", () => {
  it("keeps a small sheet whole and says nothing was dropped", () => {
    const capped = capGrid(grid(3, 4));

    expect(capped.rows).toHaveLength(3);
    expect(capped.truncatedRows).toBe(false);
    expect(capped.truncatedColumns).toBe(false);
  });

  it("cuts the rows at the cap and says so", () => {
    const capped = capGrid(grid(MAX_SHEET_ROWS + 40, 3));

    expect(capped.rows).toHaveLength(MAX_SHEET_ROWS);
    expect(capped.truncatedRows).toBe(true);
    expect(capped.truncatedColumns).toBe(false);
  });

  it("cuts the columns at the cap and says so separately", () => {
    // Two flags rather than one, because the pane has to say WHICH direction
    // it is not showing, and a sheet can be cut in one and whole in the other.
    const capped = capGrid(grid(3, MAX_SHEET_COLUMNS + 10));

    expect(capped.rows[0]).toHaveLength(MAX_SHEET_COLUMNS);
    expect(capped.truncatedColumns).toBe(true);
    expect(capped.truncatedRows).toBe(false);
  });

  it("reports both when both were cut", () => {
    const capped = capGrid(grid(MAX_SHEET_ROWS + 1, MAX_SHEET_COLUMNS + 1));

    expect(capped.truncatedRows).toBe(true);
    expect(capped.truncatedColumns).toBe(true);
  });

  it("measures the width by the WIDEST row, not the first", () => {
    // A spreadsheet's rows are ragged: the header can be three columns while
    // row forty is sixty. Measuring the first row alone reports a sheet as
    // whole while silently dropping most of it.
    const ragged = [row(2), row(MAX_SHEET_COLUMNS + 5)];

    expect(capGrid(ragged).truncatedColumns).toBe(true);
  });

  it("pads short rows so every row has the same number of cells", () => {
    // A grid whose rows differ in length cannot be drawn as a table without
    // the caller checking each row's length at every cell.
    const ragged = [row(1), row(3)];

    const capped = capGrid(ragged);

    expect(capped.rows[0]).toHaveLength(3);
    expect(capped.rows[0]?.[2]).toBe("");
  });

  it("handles a sheet with nothing in it", () => {
    const capped = capGrid([]);

    expect(capped.rows).toEqual([]);
    expect(capped.truncatedRows).toBe(false);
    expect(capped.truncatedColumns).toBe(false);
  });

  it("caps exactly at the boundary rather than one either side", () => {
    // The off-by-one that shows as a missing last row in every large sheet.
    expect(capGrid(grid(MAX_SHEET_ROWS, 2)).truncatedRows).toBe(false);
    expect(capGrid(grid(MAX_SHEET_ROWS + 1, 2)).truncatedRows).toBe(true);
  });
});

describe("the caps themselves", () => {
  it("match the Qt build's, which chose them for the same reason", () => {
    // `plugin/src/Symmetria/FileManager/Models/spreadsheetpreviewmodel.hpp`
    // records 200x50: a preview does not need the whole sheet, and the count
    // bounds both the parse and the number of elements drawn.
    expect(MAX_SHEET_ROWS).toBe(200);
    expect(MAX_SHEET_COLUMNS).toBe(50);
  });
});

describe("the value types a cell may hold", () => {
  it("accepts every one of them", () => {
    // A compile-time statement as much as a runtime one: `CellValue` is the
    // narrowed type the worker produces at its boundary, and this is the list.
    const values: CellValue[] = ["text", 1, true, new Date(0), null];

    expect(values.map((value) => typeof formatCell(value))).toEqual([
      "string",
      "string",
      "string",
      "string",
      "string",
    ]);
  });
});
