import { type ReactNode, useEffect, useRef } from "react";

export interface SearchFieldProps {
  readonly query: string;
  /** How many rows the query currently matches, for the count beside it. */
  readonly matchCount: number;
  readonly label?: string;
  readonly count?: ReactNode;
  onChange(query: string): void;
  onConfirm(): void;
  onCancel(): void;
}

/**
 * The search field.
 *
 * **Taking focus is the whole mechanism.** `useKeyDispatch` reports a focused
 * input as `textInputFocused`, and the cascade answers `notOurs` for every key
 * that arrives while it is — so `j` typed here is the letter j, and nothing had
 * to be added to the cascade to make that true. The field is autofocused on
 * mount for the same reason: a search field that needs a click before it takes
 * a letter is not a search field.
 *
 * Enter and Escape are handled here rather than in the registry, because they
 * belong to the field's own mode. The registry's `n` and `N` take over once it
 * has closed, guarded on the match count.
 */
export function SearchField({
  query,
  matchCount,
  onChange,
  onConfirm,
  onCancel,
  label = "Search this directory",
  count,
}: SearchFieldProps) {
  const field = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    field.current?.focus();
  }, []);

  return (
    <div className="search" data-testid="search">
      <span className="search__sigil" aria-hidden="true">
        /
      </span>
      <input
        ref={field}
        data-testid="search-field"
        className="search__field"
        type="text"
        // The browser's own suggestions would cover the listing this search is
        // meant to point at.
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        value={query}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            onConfirm();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      {/* Silent when nothing has been typed: "0 matches" for an empty query
          reads as a failed search rather than as one not yet made. */}
      {count ??
        (query.trim() === "" ? null : (
          <span className="search__count" data-testid="search-count">
            {matchCount === 0 ? "no matches" : `${matchCount} match${matchCount === 1 ? "" : "es"}`}
          </span>
        ))}
    </div>
  );
}
