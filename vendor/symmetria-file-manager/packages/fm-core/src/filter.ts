import type { FsEntry } from "./entry.ts";

export interface FilterOptions {
  /** Show entries whose name begins with a dot. */
  readonly showHidden?: boolean;
  /** A case-insensitive substring the name must contain. */
  readonly query?: string;
  /** Names the host asked to hide, e.g. git-ignored ones. */
  readonly ignored?: ReadonlySet<string>;
}

/** One reason to drop an entry. Composed rather than nested. */
type Predicate = (entry: FsEntry) => boolean;

function hiddenRule(showHidden: boolean): Predicate {
  return showHidden ? () => true : (entry) => !entry.isHidden;
}

function ignoredRule(ignored: ReadonlySet<string> | undefined): Predicate {
  return ignored === undefined ? () => true : (entry) => !ignored.has(entry.name);
}

function queryRule(query: string): Predicate {
  if (query === "") return () => true;
  return (entry) => entry.name.toLowerCase().includes(query);
}

/**
 * Narrow a listing.
 *
 * Kept apart from the scan on purpose: the scan reports what is on disk, and
 * the view decides what to show. That separation is what lets one set of
 * entries feed a filtered pane and an unfiltered one without a second read.
 *
 * `ignored` is the seam an embedding host injects — the file manager itself
 * knows nothing about git, and an absent set means nothing is ignored. That is
 * the contract Symmetria IDE already proved: capability arrives as an injected
 * object, and absent is always safe.
 *
 * Built from small predicates rather than one compound condition, so each rule
 * is readable on its own and adding a fourth does not deepen a nest.
 */
export function filterEntries(entries: readonly FsEntry[], options: FilterOptions = {}): FsEntry[] {
  const rules: Predicate[] = [
    hiddenRule(options.showHidden ?? false),
    ignoredRule(options.ignored),
    queryRule(options.query?.trim().toLowerCase() ?? ""),
  ];

  return entries.filter((entry) => rules.every((rule) => rule(entry)));
}
