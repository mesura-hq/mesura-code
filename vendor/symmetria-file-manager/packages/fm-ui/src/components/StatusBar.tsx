import type { SortMode } from "@symmetria/fm-core/sort";
import type { ReactNode } from "react";

import type { PickerChrome } from "../usePicker.ts";

import { SearchField, type SearchFieldProps } from "./SearchField.tsx";
import { type TransientLineProps, transientLine } from "./transientLine.tsx";

/** Which of a renderable file's two views the preview is currently drawing. */
export type RenderMode = "rendered" | "source";

export interface StatusBarProps {
  readonly summary?: ReactNode;
  /**
   * The dialog chrome, or null in the browse window.
   *
   * In the status bar rather than in a row of its own, matching the Qt build —
   * the operator chose that, and it is what "parity" means to anyone comparing
   * the two side by side.
   */
  readonly picker: PickerChrome | null;
  readonly entryCount: number;
  readonly selectedCount: number;
  readonly sort: SortMode;
  readonly reverse: boolean;
  readonly showHidden: boolean;
  /**
   * Which view the preview is showing, or null when the file has no second one.
   *
   * Null for a spreadsheet, an image, a source file — most of what a cursor
   * passes over. So the indicator is absent almost always, which is what makes
   * it worth reading when it is there.
   */
  readonly renderMode?: RenderMode | null;
  /** The search field, when one is open. Null closes it. */
  readonly search: SearchFieldProps | null;
  /**
   * The running flash session, or null.
   *
   * It has no field of its own — the query is read from the raw key stream —
   * so this bar is the only place it is visible at all. Above the transient
   * line and below the search field in precedence, which is the Qt order.
   */
  readonly flash?: { readonly query: string } | null;
  /** A failure, a running transfer, or what just happened. */
  readonly transient: TransientLineProps;
}

/**
 * The one line at the bottom, and the only thing in the window that changes.
 *
 * ── It has a FIXED height, and that is the whole point ──────────────────────
 * The search field used to be a row of its own above the columns and the
 * transient strip a row of its own below them, so opening a search pushed the
 * listing down and a copy starting pushed it up — under the eyes of somebody
 * reading it. The operator asked to "use the status line that we have below,
 * just replace everything and just put the search there so that we do not have
 * any layout shift".
 *
 * So nothing enters or leaves the window's stack any more. This bar swaps its
 * CONTENTS, and `statusBar.test.tsx` asserts exactly that — happy-dom has no
 * layout engine, so what is checked is the cause rather than the pixels.
 *
 * ── Precedence, highest first ───────────────────────────────────────────────
 * The search field, because the user is typing into it. Then a running flash
 * session, which is also the user typing and has no field of its own. Then a
 * failure, which is the one they must act on. Then a transfer, which is
 * running. Then a message. Then the counts. The last three are
 * `transientLine`'s own order and its comment says why; this file does not
 * repeat it.
 *
 * The dialog chrome is a separate axis from the mode: Accept, Cancel and the
 * save-name field show whenever this is a dialog UNLESS search has the bar.
 * The operator chose that over crowding the row, and Escape brings them back.
 */
export function StatusBar({
  picker,
  entryCount,
  selectedCount,
  sort,
  reverse,
  showHidden,
  renderMode = null,
  search,
  flash = null,
  transient,
  summary,
}: StatusBarProps) {
  return (
    <footer data-testid="status-bar" className="status-bar">
      {search === null ? (
        <>
          {picker === null ? null : (
            <button
              type="button"
              data-testid="picker-accept"
              className="status-bar__accept"
              disabled={!picker.acceptEnabled}
              onClick={picker.confirm}
            >
              {picker.acceptLabel}
            </button>
          )}
          {picker?.saveMode === true ? (
            <input
              type="text"
              data-testid="picker-save-name"
              className="status-bar__save-name"
              ref={picker.saveNameRef}
              value={picker.saveName}
              aria-label="File name"
              onChange={(event) => picker.setSaveName(event.target.value)}
            />
          ) : null}
          <BarContent
            entryCount={entryCount}
            selectedCount={selectedCount}
            sort={sort}
            reverse={reverse}
            showHidden={showHidden}
            renderMode={renderMode}
            flash={flash}
            transient={transient}
            summary={summary}
          />
          {picker === null ? null : (
            <button
              type="button"
              data-testid="picker-cancel"
              className="status-bar__cancel"
              onClick={picker.cancel}
            >
              Cancel
            </button>
          )}
        </>
      ) : (
        <SearchField {...search} />
      )}
    </footer>
  );
}

/**
 * What the bar is showing, once the search field has declined it.
 *
 * A component rather than a ternary inside `StatusBar`, because the complexity
 * gate scores a component as one function and this bar already carries the
 * dialog chrome's branches.
 */
function BarContent({ flash, ...body }: Omit<StatusBarProps, "picker" | "search">) {
  if (flash === null || flash === undefined) return <Body {...body} />;

  return (
    <span data-testid="status-flash" className="status-bar__flash">
      <kbd>s</kbd>
      {flash.query}
    </span>
  );
}

/**
 * What is in this pane, or what just happened to it.
 *
 * The transient line REPLACES the counts rather than sitting beside them, which
 * is what "just replace everything" means and what keeps the row from growing.
 *
 * The hidden-file state is shown because it changes what the count MEANS: "42
 * entries" with hidden files off is a different claim from the same number with
 * them on, and a user who cannot see which is in force cannot trust either.
 */
function Body({
  entryCount,
  selectedCount,
  sort,
  reverse,
  showHidden,
  renderMode,
  transient,
  summary,
}: Omit<StatusBarProps, "picker" | "search" | "flash">) {
  const transientContent = transientLine(transient);
  if (transientContent !== null) return transientContent;
  if (summary != null) return summary;

  return (
    <>
      <span>{entryCount} entries</span>
      {selectedCount > 0 ? <span>{selectedCount} selected</span> : null}
      {/* The direction is an arrow rather than the word "reversed", because it
          sits beside the mode name and reads as one phrase: "sort: size ↓". */}
      <span>
        sort: {sort} {reverse ? "↓" : "↑"}
      </span>
      {showHidden ? <span>hidden shown</span> : null}
      {renderMode === null || renderMode === undefined ? null : (
        <span className="status-bar__render" data-testid="status-render-mode">
          <kbd>⌃r</kbd>
          {renderMode}
        </span>
      )}
    </>
  );
}
