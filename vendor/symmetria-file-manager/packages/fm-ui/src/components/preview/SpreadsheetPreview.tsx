import {
  type CappedGrid,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_ROWS,
} from "@symmetria/fm-core/preview/sheet";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { lazyWorker } from "../../lazyWorker.ts";
import type { SheetRequest, SheetResponse } from "../../spreadsheet.worker.ts";
import { INITIAL_RECT, observeWithFallback } from "../virtualize.ts";
import { usePreviewUrl } from "./previewUrl.ts";

export interface SpreadsheetPreviewProps {
  readonly path: string;
  readonly mime: string;
}

/** Row height in pixels. Fixed, so the virtualiser needs no measurement pass. */
const ROW_HEIGHT = 22;

/**
 * How wide a column may be, in characters.
 *
 * A preview pane is a few hundred pixels wide, so this is a compromise rather
 * than a layout: too narrow and a description column ellipsises to nothing —
 * verification measured five or six visible characters against the operator's
 * real files — while too wide pushes every other column off the edge. The
 * whole value stays available on hover.
 */
const MIN_COLUMN_CH = 6;
const MAX_COLUMN_CH = 24;

const reader = lazyWorker(
  () => new Worker(new URL("../../spreadsheet.worker.ts", import.meta.url), { type: "module" }),
);

/** Drop the shared worker. For tests, which must not inherit another's. */
export function forgetSpreadsheetWorker(): void {
  reader.forget();
}

/** What the pane knows about the workbook under the cursor. */
type SheetState =
  | { readonly kind: "reading" }
  | {
      readonly kind: "workbook";
      readonly sheetNames: readonly string[];
      readonly activeSheet: number;
      readonly grid: CappedGrid;
      /**
       * Another sheet of the SAME workbook is being read.
       *
       * Distinct from `reading`, and the distinction is the whole point:
       * reverting to `reading` on a tab click swaps the entire pane — the tab
       * strip included — for a bare message, so the control the user just
       * clicked disappears under their cursor. Invisible in tests, where a
       * fake worker answers in a microtask; plainly visible against a real
       * parse, which the previous phase measured at 23 ms for one sheet.
       */
      readonly loadingSheet: boolean;
    }
  | { readonly kind: "unreadable" };

const READING: SheetState = { kind: "reading" };

/** One shared empty grid, so a `useMemo` keyed on it does not re-run per render. */
const EMPTY_ROWS: readonly (readonly string[])[] = [];

/**
 * Ask the worker for one sheet of one file.
 *
 * Keyed on the URL and the sheet together: choosing another tab is the same
 * kind of request as landing on another file, and both must discard whatever
 * the previous one would have answered.
 */
function useWorkbook(url: string | null, sheet: number): SheetState {
  const [state, setState] = useState<SheetState>(READING);
  const nextId = useRef(0);
  /** The file the state on screen belongs to, so a sheet change is tellable. */
  const shownUrl = useRef<string | null>(null);

  useEffect(() => {
    if (url === null) {
      setState(READING);
      shownUrl.current = null;
      return;
    }

    // A new FILE clears everything: the previous file's cells must never sit
    // under the next file's name. A new SHEET of the same file keeps the tab
    // strip on screen and marks itself as loading.
    const sameFile = shownUrl.current === url;
    setState((current) =>
      sameFile && current.kind === "workbook" ? { ...current, loadingSheet: true } : READING,
    );
    shownUrl.current = url;

    const instance = reader.get();
    // Unlike a waveform, there is no lesser thing to show — the grid IS the
    // preview — so a host without workers gets a notice rather than a pane
    // that stays empty and explains nothing.
    if (instance === null) {
      setState({ kind: "unreadable" });
      return;
    }

    const id = ++nextId.current;

    const onMessage = (event: MessageEvent<SheetResponse>) => {
      // A stale answer belongs to a file, or a sheet, already left.
      if (event.data.id !== id) return;
      setState(
        event.data.kind === "unreadable"
          ? { kind: "unreadable" }
          : {
              kind: "workbook",
              sheetNames: event.data.sheetNames,
              activeSheet: event.data.activeSheet,
              grid: event.data.grid,
              loadingSheet: false,
            },
      );
    };

    instance.addEventListener("message", onMessage);
    const request: SheetRequest = { id, url, sheet };
    instance.postMessage(request);

    return () => instance.removeEventListener("message", onMessage);
  }, [url, sheet]);

  return state;
}

/** Does this cell read as a number, and so belong on the right? */
function isNumeric(text: string): boolean {
  if (text === "") return false;
  // Currency, percentages and thousands separators all count: the point is
  // whether a column of these lines up on its digits, not whether the string
  // would parse. A date is left alone — it reads as a label, not a quantity.
  //
  // **It misfires on a plain run of digits that is not a quantity**: a phone
  // number, an account code, a version. Review raised it and there is no
  // correct answer here — telling those apart needs the column's declared type
  // from the source file, which the worker does not carry through. Naming the
  // gap is the honest alternative to a heuristic that pretends not to have one.
  return /^[-+(]?[\d\s.,$€£%()]+$/.test(text) && /\d/.test(text);
}

/** What the pane says when it is not showing the whole sheet. */
function truncationNotice(grid: CappedGrid): string | null {
  const parts: string[] = [];
  if (grid.truncatedRows) parts.push(`first ${MAX_SHEET_ROWS} rows`);
  if (grid.truncatedColumns) parts.push(`first ${MAX_SHEET_COLUMNS} columns`);
  return parts.length === 0 ? null : `showing the ${parts.join(" and the ")}`;
}

/**
 * A spreadsheet, as the grid it is.
 *
 * ── The pane does no per-cell work ──────────────────────────────────────────
 * Every value arrives already formatted, on the worker thread — see
 * `sheet.ts`. What is left here is layout: which rows are mounted, which tab
 * is active, and whether a number leans right.
 *
 * ── Rows are virtualised; columns are not ───────────────────────────────────
 * Two hundred rows of fifty cells is ten thousand elements on a pane a few
 * hundred pixels tall. The columns are capped at fifty, which is few enough to
 * render whole, and virtualising them as well would mean keeping a header in
 * step with a moving window for no measurable gain at that width.
 */
export function SpreadsheetPreview({ path, mime }: SpreadsheetPreviewProps) {
  const url = usePreviewUrl(path);
  const [sheet, setSheet] = useState(0);

  // Back to the first sheet whenever the file changes. An index left over from
  // the previous workbook is either out of range or silently pointing at a
  // different sheet that happens to share its number.
  const [shownPath, setShownPath] = useState(path);
  if (shownPath !== path) {
    setShownPath(path);
    setSheet(0);
  }

  const state = useWorkbook(url, sheet);

  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const attach = useCallback((node: HTMLDivElement | null) => setScrollElement(node), []);

  const rows = state.kind === "workbook" ? state.grid.rows : EMPTY_ROWS;

  /**
   * Each cell paired with its identity, and each column with a width.
   *
   * One walk over the immutable grid, done when it arrives rather than on
   * every render, producing the two things the drawing needs and cannot derive
   * cheaply per frame.
   *
   * **Identity**: a cell's identity in a spreadsheet IS its position. Cells
   * never reorder — the whole grid is replaced when the sheet or the file
   * changes — and two in one row may hold the same text, so text cannot
   * identify them.
   *
   * **Width**: a fixed narrow column ellipsised real description columns down
   * to five or six characters, which verification found against the operator's
   * own files. Sizing each column to its widest cell, clamped, spends the pane
   * on the columns that need it and keeps a column of short codes narrow.
   */
  const { keyed, widths } = useMemo(() => {
    const cells = rows.map((row, r) => row.map((text, c) => ({ id: `${r}:${c}`, text })));
    const columns = rows[0]?.length ?? 0;
    const measured = Array.from({ length: columns }, (_, c) =>
      Math.min(MAX_COLUMN_CH, Math.max(MIN_COLUMN_CH, ...rows.map((row) => (row[c] ?? "").length))),
    );
    return { keyed: cells, widths: measured };
  }, [rows]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => ROW_HEIGHT,
    overscan: 6,
    // Shared with `FileList` rather than copied: a virtualiser told its
    // viewport is zero pixels tall renders zero rows, and a headless DOM
    // always reports zero.
    initialRect: INITIAL_RECT,
    observeElementRect: observeWithFallback,
  });

  if (url === null || state.kind === "reading") {
    return <div data-testid="preview-loading">reading…</div>;
  }

  if (state.kind === "unreadable") {
    return (
      <p className="preview__failed" data-testid="preview-sheet-failed">
        could not read this {mime} spreadsheet
      </p>
    );
  }

  const notice = truncationNotice(state.grid);

  return (
    <div className="preview preview--spreadsheet" data-testid="preview-spreadsheet">
      {/* One tab is a label pretending to be a control, and the pane is narrow
          enough that the row is better spent on cells. */}
      {state.sheetNames.length > 1 ? (
        <div className="preview__sheet-tabs" data-testid="preview-sheet-tabs" role="tablist">
          {state.sheetNames.map((name, index) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={index === state.activeSheet}
              className="preview__sheet-tab"
              data-testid="preview-sheet-tab"
              data-active={index === state.activeSheet ? "true" : undefined}
              onClick={() => setSheet(index)}
            >
              {name}
            </button>
          ))}
        </div>
      ) : null}

      <div className="preview__sheet-scroll" ref={attach}>
        <div className="preview__sheet-body" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => (
            <div
              key={item.key}
              className="preview__sheet-row"
              data-testid="preview-sheet-row"
              style={{ height: item.size, transform: `translateY(${item.start}px)` }}
            >
              {(keyed[item.index] ?? []).map((cell, column) => (
                <div
                  key={cell.id}
                  className="preview__sheet-cell"
                  data-testid="preview-sheet-cell"
                  data-numeric={isNumeric(cell.text) ? "true" : undefined}
                  style={{ width: `${widths[column] ?? MIN_COLUMN_CH}ch` }}
                  title={cell.text}
                >
                  {cell.text}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {notice === null ? null : (
        <p className="preview__truncated" data-testid="preview-sheet-truncated">
          {notice}
        </p>
      )}
    </div>
  );
}
