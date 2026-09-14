import type { FsEntry } from "./entry.ts";

/**
 * Searching a listing: which rows match, and how to step between them.
 *
 * ── It marks, it does not filter, and that is a decision ────────────────────
 * `filter.ts` next door already carries a `query` option, so filtering the
 * listing down to the matches would have been less code. It was rejected. The
 * Qt build's `SearchHandler.js` computes the matching INDICES, marks them and
 * moves the cursor, leaving every other row on screen — and that is what makes
 * a Miller column worth having, because where a file sits among its neighbours
 * is half of what you are reading. A filtered column answers "here are two
 * files"; a marked one answers "here they are, in a directory of forty".
 *
 * ── Nothing here knows about a cursor ───────────────────────────────────────
 * Every function takes indices and returns indices. The pane, the field's focus
 * and the cursor belong to the host; keeping them out is what lets the wrapping
 * and the reload case be tested without a window.
 */

/**
 * The indices of every entry whose name contains the query.
 *
 * Case-insensitive on both sides, and an empty or blank query matches NOTHING
 * rather than everything. "No search is running" and "every row matches" would
 * otherwise be the same state, and the second one lights the whole column up.
 */
export function computeMatches(entries: readonly FsEntry[], query: string): number[] {
  return computeTextMatches(entries, query, (entry) => entry.name);
}

/** Match host-provided text without requiring filesystem metadata. */
export function computeTextMatches<T>(
  entries: readonly T[],
  query: string,
  textOf: (entry: T) => string,
  trimQuery = true,
): number[] {
  const needle = (trimQuery ? query.trim() : query).toLowerCase();
  if (needle === "") return [];
  const found: number[] = [];
  entries.forEach((entry, index) => {
    if (textOf(entry).toLowerCase().includes(needle)) found.push(index);
  });
  return found;
}

/**
 * The next position in the match list, wrapping.
 *
 * A POSITION in the list of matches, not an index into the listing — the caller
 * turns one into the other. `-1` means "not on a match yet", which is where a
 * fresh search starts and where an empty match list stays.
 */
export function nextMatch<T>(matches: readonly T[], position: number): number {
  if (matches.length === 0) return -1;
  // From "not on a match", forward means the first one.
  if (position < 0) return 0;
  return (position + 1) % matches.length;
}

/** The previous position in the match list, wrapping. */
export function previousMatch<T>(matches: readonly T[], position: number): number {
  if (matches.length === 0) return -1;
  // From "not on a match", backward means the LAST one — the same wrap a
  // reverse step makes from the first. Handled explicitly rather than left to
  // the arithmetic, which would read `-1` as a real position and land one short
  // of the end.
  if (position < 0) return matches.length - 1;
  return (position - 1 + matches.length) % matches.length;
}

/**
 * Where the search should sit after the listing was rebuilt underneath it.
 *
 * A watcher refresh or a re-sort is not navigation, so throwing the search back
 * to its first match would move the user off the file they were looking at.
 * `SearchHandler.computeMatches` takes a `preservePosition` flag for exactly
 * this; it is a separate function here because a boolean argument at a call
 * site says nothing about which behaviour it selects.
 *
 * Keeps the position when the cursor's row is still a match, and falls back to
 * the first match when it is not.
 */
export function matchAfterReload(matches: readonly number[], cursorIndex: number): number {
  if (matches.length === 0) return -1;

  const stillThere = matches.indexOf(cursorIndex);
  return stillThere >= 0 ? stillThere : 0;
}
