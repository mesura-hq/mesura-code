/**
 * Find a file by typing part of its name.
 *
 * **`onChoose` and `onClose` are the whole activation seam**, and they are here
 * from the first version rather than retrofitted: nothing inside this component
 * knows what a file manager is. The file manager passes handlers that navigate;
 * a host passes handlers that open the file in an editor. That is the only
 * difference between the two consumers, and it is why this package can be
 * mounted without the panel.
 *
 * The structure follows the panel's zoxide popup — a combobox field over a
 * listbox, the field keeping focus and naming the current row. The keyboard
 * behaviour they share is `useOverlayList`, so a fix to it reaches both; what
 * is left here is what only the finder has, which is the confirm key and its
 * staleness rule.
 */
import type { SearchReplyRow } from "@symmetria/fm-core/contract";

import { FinderInfoPanel, type RenderPreview } from "./FinderInfoPanel.tsx";
import { FinderRow } from "./FinderRow.tsx";
import { withoutTrailingSeparator } from "./paths.ts";
import { useFinder } from "./useFinder.ts";
import { useOverlayList } from "./useOverlayList.ts";

/** A stable id per row, so the field can name the one that is current. */
function rowId(index: number): string {
  return `finder-row-${index}`;
}

export interface FinderOverlayProps {
  /** The tree to search. One index is opened per directory. */
  readonly directory: string;
  /**
   * A result was chosen.
   *
   * `isDir` rather than a path convention: a directory's path carries the
   * engine's trailing separator, and a caller that had to know that would be a
   * caller that can get it wrong.
   */
  onChoose(path: string, isDir: boolean): void;
  onClose(): void;
  /**
   * Draw a live preview of the highlighted result.
   *
   * Injected rather than built in, because this package must not import the
   * file-manager panel — see `FinderInfoPanel`'s header for the full reasoning.
   * Omit it and the information panel still shows the name and the four facts,
   * with no preview beneath them.
   */
  readonly renderPreview?: RenderPreview | undefined;
}

export function FinderOverlay({ directory, onChoose, onClose, renderPreview }: FinderOverlayProps) {
  const finder = useFinder(directory);
  const rows = finder.rows;
  const list = useOverlayList(rows.length, onClose);
  const highlighted = list.highlighted;
  const current = rows[highlighted];

  const choose = (row: SearchReplyRow | undefined) => {
    if (row === undefined) return;
    // Blocked while a newer query is in flight. Without this, pressing Enter as
    // results update opens whichever file the OLDER list had under the
    // highlight — the user acts on one row and gets another.
    if (finder.stale) return;
    // Recorded with the ENGINE's spelling and handed out with the
    // APPLICATION's. The engine gives a directory a trailing separator on both
    // path forms, and its store is keyed on that, so the tracker write must
    // keep it. A caller must not: every other path in a host is separator-free,
    // so `/home/jc/notes/` would become the pane's path and every later
    // `join(path, name)` would build `/home/jc/notes//file`. Stripping it here
    // costs the caller nothing, because `isDir` already carries the one thing
    // the separator was telling them.
    finder.record(row.fullPath);
    onChoose(withoutTrailingSeparator(row.fullPath), row.isDir);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (list.handleKey(event)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      choose(current);
    }
  };

  return (
    <div className="overlay overlay--search">
      <div data-testid="finder" className="overlay__panel search-popup">
        <input
          data-testid="finder-query"
          ref={list.field}
          className="overlay__query"
          value={finder.query}
          placeholder="find a file…"
          role="combobox"
          aria-expanded={true}
          aria-controls="finder-list"
          aria-activedescendant={current === undefined ? undefined : rowId(highlighted)}
          onChange={(event) => {
            finder.setQuery(event.target.value);
            list.resetHighlight();
          }}
          onKeyDown={onKeyDown}
        />
        <p className="overlay__status" data-testid="finder-status">
          {statusLine(finder)}
        </p>
        {/* Both columns keep their space, including while a query has no answer. */}
        <div className="finder__body">
          {/* Plain elements carrying the roles, rather than a `ul` and `li`
              given them: a list element with an interactive role is a list to
              the parser and a listbox to the reader, and the two disagree. */}
          <div
            id="finder-list"
            ref={list.results}
            className="overlay__list finder__list"
            role="listbox"
            aria-label="Results"
            tabIndex={-1}
          >
            {rows.map((row, index) => (
              <FinderRow
                key={row.fullPath}
                row={row}
                id={rowId(index)}
                active={index === highlighted}
              />
            ))}
          </div>
          {current === undefined ? (
            <aside className="finder-info" data-testid="finder-info-placeholder">
              <p className="overlay__placeholder">Select a file to preview</p>
            </aside>
          ) : (
            <FinderInfoPanel row={current} renderPreview={renderPreview} />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * What the overlay says about itself, in one line.
 *
 * The truncation flag is reported rather than swallowed. The Qt finder says
 * "200 results" whether there are 200 or 20,000, and a count that means two
 * different things is worse than no count.
 */
function statusLine({
  problem,
  indexing,
  stale,
  query,
  rows,
  truncated,
  cap,
}: ReturnType<typeof useFinder>): string {
  if (problem !== null) return problem;
  if (indexing) return "Indexing…";
  if (stale) return "Searching…";
  const shown = rows.length;
  if (query.trim() === "") return shown === 0 ? "No files in this scope" : "Suggested files";
  if (shown === 0) return "No results";
  if (truncated) return `First ${cap} of more`;
  return shown === 1 ? "1 result" : `${shown} results`;
}
