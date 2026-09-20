import type { CappedGrid } from "@symmetria/fm-core/preview/sheet";

import { fetchWorkbook } from "./spreadsheetParse.ts";

/**
 * A workbook, read off the interface thread.
 *
 * Third worker in this package and the same discipline as the others: a request
 * carries an id, the answer carries it back, and the consumer drops any answer
 * whose id is not the current one. A preview is debounced by 150 ms and the
 * cursor keeps moving, so a late answer for the previous file is the normal
 * case rather than the corner.
 *
 * ── Why the parsing is here and not in the main process ─────────────────────
 * A spreadsheet is untrusted input that arrived from a browser download, and
 * this is a 988 kB parser with a large attack surface. The renderer is
 * sandboxed and has no filesystem; the main process has both. Putting the
 * parser on the side that can do nothing with a compromise is the whole
 * argument, and it is why the plan chose a worker over the privileged half.
 *
 * ── And why the file is fetched rather than handed over ─────────────────────
 * The same reason the tag worker does it: the token URL is same-origin and the
 * app scheme is registered with `supportFetchAPI`, so a worker created from
 * that document can read it — which keeps a whole workbook from crossing the
 * process boundary twice.
 *
 * Everything worth testing lives in `spreadsheetParse.ts`, because importing
 * THIS file runs the listener below and cannot be done from a test.
 */

export interface SheetRequest {
  readonly id: number;
  /** The token URL the main process issued for this file. */
  readonly url: string;
  /** Which sheet to return. Out of range falls back to the first. */
  readonly sheet: number;
}

export type SheetResponse =
  | {
      readonly id: number;
      readonly kind: "workbook";
      readonly sheetNames: readonly string[];
      readonly activeSheet: number;
      readonly grid: CappedGrid;
    }
  /** Corrupt, encrypted, empty, or a fetch that failed. */
  | { readonly id: number; readonly kind: "unreadable" };

self.addEventListener("message", (event: MessageEvent<SheetRequest>) => {
  const request = event.data;

  void fetchWorkbook(request.url, request.sheet).then((parsed) => {
    const answer: SheetResponse =
      parsed.kind === "unreadable"
        ? { id: request.id, kind: "unreadable" }
        : {
            id: request.id,
            kind: "workbook",
            sheetNames: parsed.sheetNames,
            activeSheet: parsed.activeSheet,
            grid: parsed.grid,
          };

    // Nothing to transfer: the answer is strings, which the structured clone
    // copies either way, and a grid capped at 200x50 is small.
    self.postMessage(answer);
  });
});
