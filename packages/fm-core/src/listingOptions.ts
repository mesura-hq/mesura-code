import { isSortMode, type SortMode } from "./sort.ts";

/**
 * How a listing is ordered, as a stored preference.
 *
 * The same division the bookmark store draws: this file decides what a stored
 * value MEANS and what to do when it is nonsense, while `fm-main` owns where it
 * lives and what happens when the disk disagrees. Neither half can be tested
 * properly while they are one.
 */

export interface ListingOptions {
  readonly sort: SortMode;
  /** Newest, largest or last first. Reverses the mode rather than replacing it. */
  readonly reverse: boolean;
  readonly showHidden: boolean;
  /**
   * Whether a markdown or HTML file previews rendered, or as its source.
   *
   * A view preference and not a listing one, which is why the name says what
   * it does rather than borrowing the file's. It lives here anyway: it
   * persists for exactly the same reason `showHidden` does, and a second store
   * for one boolean would mean a second channel pair, a second hook and a
   * second write chain.
   */
  readonly renderDocuments: boolean;
}

/**
 * What a first run gets.
 *
 * Modification time, newest first. `modified` ascending puts the OLDEST entry
 * at the top, so newest-first is that mode reversed — `reverse: true` here is
 * the whole of what "descending" means and is not a mistake.
 */
export const DEFAULT_LISTING_OPTIONS: ListingOptions = {
  sort: "modified",
  reverse: true,
  showHidden: false,
  // Rendering is the default and the key is the escape hatch. This inverts the
  // Qt build, where source was the default and `Ctrl+R` opted in — its reason
  // was the cost of starting a browser engine per file, which is not a cost
  // here.
  renderDocuments: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A stored value, made safe to use.
 *
 * **Field by field, not file by file.** A file with a good sort mode and a
 * corrupt hidden flag keeps the sort mode: discarding the whole object would
 * throw away a setting the user did choose because of one they did not.
 *
 * `SortMode` is a union of five string literals, so a file saying
 * `"sort": "cromulent"` must never become a listing request — the main process
 * would pass it straight to a comparison that has no case for it.
 */
export function decodeListingOptions(raw: unknown): ListingOptions {
  if (!isRecord(raw)) return DEFAULT_LISTING_OPTIONS;

  return {
    sort: isSortMode(raw["sort"]) ? raw["sort"] : DEFAULT_LISTING_OPTIONS.sort,
    reverse: typeof raw["reverse"] === "boolean" ? raw["reverse"] : DEFAULT_LISTING_OPTIONS.reverse,
    showHidden:
      typeof raw["showHidden"] === "boolean"
        ? raw["showHidden"]
        : DEFAULT_LISTING_OPTIONS.showHidden,
    renderDocuments:
      typeof raw["renderDocuments"] === "boolean"
        ? raw["renderDocuments"]
        : DEFAULT_LISTING_OPTIONS.renderDocuments,
  };
}

/**
 * What the file said, or why it said nothing.
 *
 * Three answers rather than two, and the difference between the first two is
 * the whole point: `null` is a first run and `"unreadable"` is the user's own
 * data mid-edit, which is neither trusted nor overwritten.
 */
export type StoredListingOptions = ListingOptions | null | "unreadable";

export interface ResolvedListingOptions {
  readonly options: ListingOptions;
  /**
   * Whether this process may write the file.
   *
   * False for a file that exists and did not parse. Saving over it would
   * destroy something a person is in the middle of fixing.
   */
  readonly mayWrite: boolean;
}

/** Decide what the window uses, and whether the file may be written back. */
export function resolveListingOptions(stored: StoredListingOptions): ResolvedListingOptions {
  if (stored === null) return { options: DEFAULT_LISTING_OPTIONS, mayWrite: true };
  if (stored === "unreadable") return { options: DEFAULT_LISTING_OPTIONS, mayWrite: false };
  return { options: stored, mayWrite: true };
}
