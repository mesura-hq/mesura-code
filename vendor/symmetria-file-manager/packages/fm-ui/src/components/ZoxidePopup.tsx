import { isFailure } from "@symmetria/fm-core/contract";
import { basename } from "@symmetria/fm-core/pane";
import { type FrecentDirectory, filterFrecent } from "@symmetria/fm-core/zoxide";
import { useOverlayList } from "@symmetria/fm-search/ui";
import { useEffect, useMemo, useState } from "react";

import { frecentDirectories } from "../bridge.ts";

/** A stable id per row, so the field can name the one that is current. */
function rowId(index: number): string {
  return `zoxide-row-${index}`;
}

function statusLine(
  problem: string | null,
  loading: boolean,
  query: string,
  count: number,
): string {
  if (problem !== null) return problem;
  if (loading) return "Loading directories…";
  if (count === 0)
    return query.trim() === "" ? "No visited directories" : "No matching directories";
  return `${count} ${count === 1 ? "directory" : "directories"}`;
}

export interface ZoxidePopupProps {
  readonly onChoose: (path: string) => void;
  readonly onClose: () => void;
}

/**
 * The directories zoxide already knows you go to.
 *
 * **The list is fetched once, on open, and narrowed here.** Asking zoxide costs
 * a subprocess, so a query per keystroke would spawn a process per character.
 *
 * A modal handles its own keys, which is what makes the cascade's "a modal
 * handles it" true rather than a claim. Escape closes, the arrows move, Enter
 * goes. Nothing here reaches the pane's keymap, and the pane's keymap does not
 * reach in.
 */
export function ZoxidePopup({ onChoose, onClose }: ZoxidePopupProps) {
  const [entries, setEntries] = useState<readonly FrecentDirectory[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let current = true;
    void frecentDirectories().then((reply) => {
      if (!current) return;
      setLoading(false);
      // An empty list and a missing binary look identical on screen, and only
      // one of them is something the user can fix.
      if (isFailure(reply)) setProblem(reply.error.message);
      else setEntries(reply.value.entries);
    });

    return () => {
      current = false;
    };
  }, []);

  const shown = useMemo(() => filterFrecent(entries, query), [entries, query]);

  // Focus, the Escape backstop, the Tab trap and the clamped highlight all
  // live in `useOverlayList`, shared with the finder. This dialog was once
  // UNCLOSABLE by keyboard because that logic had a gap; one copy of it is how
  // the fix stays fixed in both places. See that module's header.
  const list = useOverlayList(shown.length, onClose);
  const highlighted = list.highlighted;

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (list.handleKey(event)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      const chosen = shown[highlighted];
      if (chosen !== undefined) onChoose(chosen.path);
    }
  };

  return (
    <div className="overlay overlay--search">
      <div data-testid="zoxide" className="overlay__panel search-popup">
        {/* The input holds focus and names the current row, which is the
            shape a listbox takes when the keyboard belongs to a text field.
            No conflict here with the pane's document-level keymap: this popup
            owns every key while it is up. */}
        <input
          data-testid="zoxide-query"
          ref={list.field}
          className="overlay__query"
          value={query}
          placeholder="jump to…"
          role="combobox"
          aria-expanded={true}
          aria-controls="zoxide-list"
          aria-activedescendant={shown[highlighted] === undefined ? undefined : rowId(highlighted)}
          onChange={(event) => {
            setQuery(event.target.value);
            list.resetHighlight();
          }}
          onKeyDown={onKeyDown}
        />
        <p className="overlay__status" data-testid="zoxide-status">
          {statusLine(problem, loading, query, shown.length)}
        </p>
        {/* Plain elements carrying the roles, rather than a `ul` and `li`
            given them. A list element with an interactive role is a list to
            the parser and a listbox to the reader, and the two disagree; a
            `div` claims nothing it then has to override.

            `tabIndex={-1}` on the box and none on the rows is the shape this
            pattern takes: focus stays in the field, which names the current
            row with `aria-activedescendant`, so no row is ever a tab stop.

            That is why each row suppresses `useFocusableInteractive`. The rule
            wants every option to be focusable, which is the opposite of what
            this pattern requires — a tabIndex per row would put all of them in
            the tab order and break the very thing the roles declare. The
            suppression is one line directly above the element on purpose:
            biome attaches it to whatever follows, and a continuation comment
            in between silently detaches it. */}
        <div
          id="zoxide-list"
          ref={list.results}
          className="overlay__list search-popup__results"
          role="listbox"
          aria-label="Frecent directories"
          tabIndex={-1}
        >
          {shown.map((entry, index) => (
            // biome-ignore lint/a11y/useFocusableInteractive: see the note above
            <div
              key={entry.path}
              id={rowId(index)}
              data-testid="zoxide-row"
              role="option"
              aria-selected={index === highlighted}
              data-active={index === highlighted ? "true" : undefined}
              className={`overlay__row${index === highlighted ? " overlay__row--active" : ""}`}
            >
              <span className="zoxide__score">{Math.round(entry.score)}</span>
              <span className="zoxide__path" title={entry.path}>
                <span className="zoxide__parent">
                  {entry.path.slice(0, entry.path.length - basename(entry.path).length)}
                </span>
                <span className="zoxide__name">{basename(entry.path)}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
