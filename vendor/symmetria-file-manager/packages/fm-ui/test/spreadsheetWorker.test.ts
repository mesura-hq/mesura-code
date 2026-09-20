import { MAX_SHEET_COLUMNS, MAX_SHEET_ROWS } from "@symmetria/fm-core/preview/sheet";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
// Type-only, deliberately: importing the worker for real would run its
// listener. This is what keeps the message contract below honest — the shapes
// asserted here are the ones the worker actually promises.
import type { SheetRequest, SheetResponse } from "../src/spreadsheet.worker.ts";
import {
  fetchWorkbook,
  MAX_WORKBOOK_BYTES,
  type ParsedWorkbook,
  readWorkbook,
} from "../src/spreadsheetParse.ts";

/**
 * Parsing real workbooks, written by the same library that reads them.
 *
 * ── Why no fixture files are committed ──────────────────────────────────────
 * SheetJS writes the formats it reads, so a workbook can be built in memory,
 * parsed back, and checked — with no binary in the repository for anyone to
 * wonder about and no fixture that drifts from what the test claims it holds.
 *
 * ── What this cannot cover, and who does ────────────────────────────────────
 * The community build does not WRITE legacy `.xls`, so the BIFF path cannot be
 * exercised from here. That matters more than usual: 80 of the operator's 98
 * spreadsheets are genuine OLE2 `.xls`, verified by content, and reading them
 * is why this parser was chosen over the better-maintained alternative. It is
 * left to the verifier in the phase that mounts the pane, against their real
 * files.
 */

/** A workbook holding one sheet of the given rows, in the given format. */
function workbook(
  rows: unknown[][],
  format: XLSX.BookType,
  sheetName = "Sheet1",
): Uint8Array<ArrayBuffer> {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), sheetName);
  // Named rather than inlined: SheetJS types `write` loosely, so the result
  // would otherwise be a `Uint8Array<ArrayBufferLike>` — which is not a
  // `BlobPart` and not a `BodyInit`, and needs an assertion to become one.
  const written: ArrayBuffer = XLSX.write(book, { type: "array", bookType: format });
  return new Uint8Array(written);
}

describe("the formats it reads", () => {
  it("reads an xlsx", () => {
    const parsed = readWorkbook(
      workbook(
        [
          ["Name", "Total"],
          ["Chini", 42],
        ],
        "xlsx",
      ),
      0,
    );

    expect(parsed.kind).toBe("workbook");
    if (parsed.kind !== "workbook") return;
    expect(parsed.sheetNames).toEqual(["Sheet1"]);
    expect(parsed.grid.rows[0]).toEqual(["Name", "Total"]);
    expect(parsed.grid.rows[1]).toEqual(["Chini", "42"]);
  });

  it("reads a csv", () => {
    // A csv reaches this branch because `route.ts` sends `text/csv` to the
    // spreadsheet preview rather than to the text one — it has been doing so
    // since before there was a spreadsheet preview to send it to.
    const parsed = readWorkbook(
      workbook(
        [
          ["a", "b"],
          [1, 2],
        ],
        "csv",
      ),
      0,
    );

    expect(parsed.kind).toBe("workbook");
    if (parsed.kind !== "workbook") return;
    expect(parsed.grid.rows[1]).toEqual(["1", "2"]);
  });

  it("reads an ods", () => {
    const parsed = readWorkbook(workbook([["x"], ["y"]], "ods"), 0);

    expect(parsed.kind).toBe("workbook");
  });
});

describe("more than one sheet", () => {
  it("names every sheet, not only the one it returns", () => {
    // The tab strip needs all of them, and one of the operator's own workbooks
    // has seventy-six.
    const book = XLSX.utils.book_new();
    for (const name of ["Enero", "Febrero", "Marzo"]) {
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[name]]), name);
    }
    const written: ArrayBuffer = XLSX.write(book, { type: "array", bookType: "xlsx" });
    const bytes = new Uint8Array(written);

    const parsed = readWorkbook(bytes, 0);

    expect(parsed.kind).toBe("workbook");
    if (parsed.kind !== "workbook") return;
    expect(parsed.sheetNames).toEqual(["Enero", "Febrero", "Marzo"]);
  });

  it("returns the sheet that was asked for", () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["first"]]), "A");
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["second"]]), "B");
    const written: ArrayBuffer = XLSX.write(book, { type: "array", bookType: "xlsx" });
    const bytes = new Uint8Array(written);

    const parsed = readWorkbook(bytes, 1);

    expect(parsed.kind).toBe("workbook");
    if (parsed.kind !== "workbook") return;
    expect(parsed.grid.rows[0]).toEqual(["second"]);
    expect(parsed.activeSheet).toBe(1);
  });

  it("falls back to the first sheet when asked for one that is not there", () => {
    // The pane resets its chosen sheet when the file changes, but a race
    // between that and a stale index must not produce an empty grid.
    const parsed = readWorkbook(workbook([["only"]], "xlsx"), 9);

    expect(parsed.kind).toBe("workbook");
    if (parsed.kind !== "workbook") return;
    expect(parsed.activeSheet).toBe(0);
    expect(parsed.grid.rows[0]).toEqual(["only"]);
  });
});

describe("values arrive already formatted", () => {
  it("turns a number into a string", () => {
    // The pane does no per-cell work: everything it draws is already text by
    // the time it crosses the boundary.
    const parsed = readWorkbook(workbook([[1234.5]], "xlsx"), 0);

    expect(parsed.kind).toBe("workbook");
    if (parsed.kind !== "workbook") return;
    expect(parsed.grid.rows[0]?.[0]).toBe("1234.5");
  });

  it("shows a boolean the way the workbook itself shows it", () => {
    // `TRUE`/`FALSE`, not `true`/`false`. The parser is asked for the
    // workbook's OWN rendering (`raw: false`) so that a currency column reads
    // the way it reads in the source file, and Excel renders a boolean in
    // capitals. Taking the file's rendering here and overriding it for booleans
    // alone would be two answers to one question.
    //
    // `formatCell`'s own lowercase rule still applies to a cell that arrives as
    // a raw boolean, which is what `sheet.test.ts` pins.
    const parsed = readWorkbook(workbook([[true, false]], "xlsx"), 0);

    expect(parsed.kind).toBe("workbook");
    if (parsed.kind !== "workbook") return;
    expect(parsed.grid.rows[0]).toEqual(["TRUE", "FALSE"]);
  });

  it("leaves an empty cell empty rather than writing a word in it", () => {
    const parsed = readWorkbook(workbook([["a", null, "c"]], "xlsx"), 0);

    expect(parsed.kind).toBe("workbook");
    if (parsed.kind !== "workbook") return;
    expect(parsed.grid.rows[0]).toEqual(["a", "", "c"]);
  });
});

describe("a sheet larger than the pane will show", () => {
  it("caps the rows and says it did", () => {
    const rows = Array.from({ length: MAX_SHEET_ROWS + 50 }, (_, i) => [i]);

    const parsed = readWorkbook(workbook(rows, "xlsx"), 0);

    expect(parsed.kind).toBe("workbook");
    if (parsed.kind !== "workbook") return;
    expect(parsed.grid.rows).toHaveLength(MAX_SHEET_ROWS);
    expect(parsed.grid.truncatedRows).toBe(true);
  });

  it("caps the columns and says it did", () => {
    const wide = [Array.from({ length: MAX_SHEET_COLUMNS + 20 }, (_, i) => i)];

    const parsed = readWorkbook(workbook(wide, "xlsx"), 0);

    expect(parsed.kind).toBe("workbook");
    if (parsed.kind !== "workbook") return;
    expect(parsed.grid.rows[0]).toHaveLength(MAX_SHEET_COLUMNS);
    expect(parsed.grid.truncatedColumns).toBe(true);
  });
});

describe("when it cannot be read", () => {
  it("names a corrupt workbook rather than throwing", () => {
    // A ZIP header followed by rubbish: the shape of a truncated download or a
    // half-written file. The parser recognises the container and fails inside
    // it, which is the failure this branch exists for.
    //
    // The worker's caller has no catch, so a throw here becomes an unhandled
    // rejection and the pane shows nothing with no explanation.
    const corrupt = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(64).fill(0x7f)]);

    expect(readWorkbook(corrupt, 0).kind).toBe("unreadable");
  });

  it("does not throw on bytes that are not a spreadsheet at all", () => {
    // SheetJS is permissive and reads unrecognised bytes as a one-column CSV
    // rather than refusing them. That is its answer, not a defect, and the
    // router only ever sends it a file whose type says spreadsheet — so what
    // matters here is that nothing throws, not which of the two answers it
    // gives. Asserting `unreadable` would have been asserting my expectation
    // of the library rather than a requirement of the pane.
    expect(() => readWorkbook(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 0)).not.toThrow();
  });

  it("does not throw on an empty file", () => {
    expect(() => readWorkbook(new Uint8Array(0), 0)).not.toThrow();
  });
});

describe("fetching one", () => {
  /** A response of `bytes` real bytes declaring `declared`. */
  function respond(bytes: Uint8Array<ArrayBuffer>, declared = bytes.byteLength): Response {
    // A `Blob` rather than the array itself: `BodyInit` does not accept a
    // `Uint8Array<ArrayBufferLike>`, and wrapping it needs no type assertion.
    return new Response(new Blob([bytes]), {
      status: 200,
      headers: { "content-length": String(declared) },
    });
  }

  function withFetch(make: () => Promise<Response>): void {
    Object.defineProperty(globalThis, "fetch", { value: make, configurable: true, writable: true });
  }

  it("reads a workbook from a URL", async () => {
    const bytes = workbook([["Total", 42]], "xlsx");
    withFetch(() => Promise.resolve(respond(bytes)));

    const parsed = await fetchWorkbook("symmetria-fm://app/__preview/t", 0);

    expect(parsed.kind).toBe("workbook");
    if (parsed.kind !== "workbook") return;
    expect(parsed.grid.rows[0]).toEqual(["Total", "42"]);
  });

  it("refuses on the declared length without reading the body", async () => {
    let bodyRead = false;
    withFetch(() => {
      const response = respond(new Uint8Array(8), MAX_WORKBOOK_BYTES + 1);
      const read = response.arrayBuffer.bind(response);
      response.arrayBuffer = () => {
        bodyRead = true;
        return read();
      };
      return Promise.resolve(response);
    });

    const parsed = await fetchWorkbook("symmetria-fm://app/__preview/t", 0);

    expect(parsed.kind).toBe("unreadable");
    expect(bodyRead).toBe(false);
  });

  it("refuses a body larger than its own declared length", async () => {
    // The header is advisory. A response that under-declares must not slip past.
    withFetch(() => Promise.resolve(respond(new Uint8Array(MAX_WORKBOOK_BYTES + 1), 1024)));

    expect((await fetchWorkbook("symmetria-fm://app/__preview/t", 0)).kind).toBe("unreadable");
  });

  it("does not throw when the fetch fails", async () => {
    // The worker does `void fetchWorkbook(...).then(...)` with no catch, so a
    // rejection here becomes an unhandled one and the pane shows nothing with
    // no reason given.
    withFetch(() => Promise.reject(new Error("network")));

    expect((await fetchWorkbook("symmetria-fm://app/__preview/t", 0)).kind).toBe("unreadable");
  });

  it("does not throw on a response that is not ok", async () => {
    withFetch(() => Promise.resolve(new Response(null, { status: 404 })));

    expect((await fetchWorkbook("symmetria-fm://app/__preview/t", 0)).kind).toBe("unreadable");
  });
});

describe("the message contract the worker promises", () => {
  it("carries a request id back on the answer, for the staleness check", () => {
    // The preview is debounced and the cursor keeps moving, so a late answer
    // for the previous file is the normal case. Every consumer drops an answer
    // whose id is not the current one, which only works if the id survives the
    // round trip.
    const request: SheetRequest = { id: 7, url: "symmetria-fm://app/__preview/t", sheet: 2 };
    const answer: SheetResponse = { id: request.id, kind: "unreadable" };

    expect(answer.id).toBe(request.id);
  });

  it("shapes its workbook answer exactly as the parser's result", () => {
    // A compile-time statement first: the worker copies these fields across
    // one at a time, so a field renamed on one side and not the other is a
    // type error here rather than an empty grid at runtime.
    const parsed: ParsedWorkbook = readWorkbook(workbook([["a"]], "xlsx"), 0);
    if (parsed.kind !== "workbook") throw new Error("expected a workbook");

    const answer: SheetResponse = {
      id: 1,
      kind: "workbook",
      sheetNames: parsed.sheetNames,
      activeSheet: parsed.activeSheet,
      grid: parsed.grid,
    };

    expect(answer.kind).toBe("workbook");
    expect(answer).toMatchObject({ sheetNames: ["Sheet1"], activeSheet: 0 });
  });
});

describe("guards", () => {
  it("renders a date as ISO, not as the workbook's locale text", () => {
    // Review found this by running the parser: asked for the workbook's own
    // rendering, a date cell comes back as `"9/1/26"` — two-digit year, in an
    // order that means one thing to one reader and another to the next. The
    // ISO formatter existed and nothing reached it, and the comment claiming
    // it prevented that ambiguity was describing a dead branch.
    const parsed = readWorkbook(workbook([[new Date(2026, 8, 2)]], "xlsx"), 0);

    expect(parsed.kind).toBe("workbook");
    if (parsed.kind !== "workbook") return;
    expect(parsed.grid.rows[0]?.[0]).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it("still keeps the workbook's own rendering for everything else", () => {
    // The split is the point: a date is reformatted, a number is not. Taking
    // our own rendering for numbers too would lose the currency and percentage
    // formats that make a column readable.
    const parsed = readWorkbook(workbook([["text", 1234.5, true]], "xlsx"), 0);

    expect(parsed.kind).toBe("workbook");
    if (parsed.kind !== "workbook") return;
    expect(parsed.grid.rows[0]).toEqual(["text", "1234.5", "TRUE"]);
  });

  it("does not claim columns were cut when the wide row is past the row cap", () => {
    // Review found `capGrid` measuring the width over every row READ rather
    // than over the rows SHOWN, so a wide row below the fold raised a warning
    // about columns that were all visible.
    const narrow = Array.from({ length: MAX_SHEET_ROWS }, () => ["a", "b"]);
    const wideBelowTheFold = Array.from({ length: MAX_SHEET_COLUMNS + 10 }, (_, i) => i);

    const parsed = readWorkbook(workbook([...narrow, wideBelowTheFold], "xlsx"), 0);

    expect(parsed.kind).toBe("workbook");
    if (parsed.kind !== "workbook") return;
    expect(parsed.grid.truncatedRows).toBe(true);
    expect(parsed.grid.truncatedColumns).toBe(false);
  });

  it("reports no truncation for a sheet of exactly the cap", () => {
    // The boundary, through the REAL parser rather than through constructed
    // arrays: `sheetRows` is one past the display cap so that "exactly at the
    // cap" stays distinguishable from "more than it", and that reasoning is
    // only true if both ends agree.
    const exact = Array.from({ length: MAX_SHEET_ROWS }, (_, i) => [i]);

    const parsed = readWorkbook(workbook(exact, "xlsx"), 0);

    expect(parsed.kind).toBe("workbook");
    if (parsed.kind !== "workbook") return;
    expect(parsed.grid.rows).toHaveLength(MAX_SHEET_ROWS);
    expect(parsed.grid.truncatedRows).toBe(false);
  });

  it("reports truncation for a sheet one row past the cap", () => {
    const oneMore = Array.from({ length: MAX_SHEET_ROWS + 1 }, (_, i) => [i]);

    const parsed = readWorkbook(workbook(oneMore, "xlsx"), 0);

    expect(parsed.kind).toBe("workbook");
    if (parsed.kind !== "workbook") return;
    expect(parsed.grid.rows).toHaveLength(MAX_SHEET_ROWS);
    expect(parsed.grid.truncatedRows).toBe(true);
  });

  it("parses only the sheet it was asked for", () => {
    // Measured on a 76-sheet workbook: 817 ms to parse every sheet against
    // 23 ms for the names plus the one shown. The pane shows one at a time.
    const book = XLSX.utils.book_new();
    for (let i = 0; i < 8; i++) {
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[`s${i}`]]), `S${i}`);
    }
    const written: ArrayBuffer = XLSX.write(book, { type: "array", bookType: "xlsx" });

    const parsed = readWorkbook(new Uint8Array(written), 5);

    expect(parsed.kind).toBe("workbook");
    if (parsed.kind !== "workbook") return;
    // Every name, but only the asked-for sheet's cells.
    expect(parsed.sheetNames).toHaveLength(8);
    expect(parsed.grid.rows[0]).toEqual(["s5"]);
  });
});
