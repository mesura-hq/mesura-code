import type { FsEntry } from "./entry.ts";

export type SortMode = "alphabetical" | "modified" | "size" | "extension" | "natural";

/**
 * Every mode, as values something can test an unknown string against.
 *
 * Beside the type rather than beside either of its readers: the wire contract
 * and the stored preference each need to reject a mode that is not one, and
 * they had grown a copy apiece. A sixth mode should be one edit.
 */
export const SORT_MODES: readonly SortMode[] = [
  "alphabetical",
  "modified",
  "size",
  "extension",
  "natural",
];

/**
 * A real narrowing, not an assertion.
 *
 * An early draft wrote `SORT_MODES.includes(sort as SortMode)` and then
 * `sort as SortMode` again — two assertions telling the compiler something
 * neither had checked. A predicate proves it instead, and both casts go.
 */
export function isSortMode(value: unknown): value is SortMode {
  return SORT_MODES.some((mode) => mode === value);
}

/**
 * Compare two entries under `mode`.
 *
 * **Directories always come first, in every mode.** The Qt version's
 * `compareEntries` did the same, and its tree walk depended on it; the columns
 * will too. It is asserted per mode in the tests rather than once, because a
 * mode added later is exactly where this gets forgotten.
 *
 * Every mode falls back to a case-insensitive name comparison, so the order is
 * total and two files that tie on the sort key never swap between runs.
 */
export function compareEntries(a: FsEntry, b: FsEntry, mode: SortMode): number {
  const aDir = a.kind === "directory";
  const bDir = b.kind === "directory";
  if (aDir !== bDir) return aDir ? -1 : 1;

  const primary = comparePrimary(a, b, mode);
  return primary !== 0 ? primary : compareNames(a.name, b.name);
}

function comparePrimary(a: FsEntry, b: FsEntry, mode: SortMode): number {
  switch (mode) {
    case "alphabetical":
      return compareNames(a.name, b.name);
    case "modified":
      return a.modifiedMs - b.modifiedMs;
    case "size":
      return a.size - b.size;
    case "extension":
      return compareNames(extensionOf(a.name), extensionOf(b.name));
    case "natural":
      return naturalCompare(a.name, b.name);
  }
}

/**
 * Two names, case-insensitively, with a stable tiebreak.
 *
 * Exported because the archive listing sorts by exactly this and a second copy
 * would drift: an archive whose folders ordered differently from the columns
 * beside them would look like a bug in one of the two.
 */
export function compareNames(a: string, b: string): number {
  const lowered = a.toLowerCase().localeCompare(b.toLowerCase());
  // Fall through to the cased form so `A` and `a` still have a stable order.
  return lowered !== 0 ? lowered : a.localeCompare(b);
}

/**
 * The extension, or the empty string.
 *
 * A leading dot does not start an extension: `.bashrc` is a hidden file named
 * `.bashrc`, not a file with extension `bashrc`. Getting that wrong scatters
 * every dotfile across the listing.
 */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1);
}

/**
 * Compare names with embedded numbers by value rather than by digit.
 *
 * Alphabetically `file10` precedes `file2`, which is the whole reason this mode
 * exists. Both names are split into alternating text and number runs and the
 * runs are compared pairwise.
 */
export function naturalCompare(a: string, b: string): number {
  const runs = /(\d+|\D+)/g;
  const left = a.toLowerCase().match(runs) ?? [];
  const right = b.toLowerCase().match(runs) ?? [];

  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    // SAFETY: `i < Math.min(left.length, right.length)` is the loop condition,
    // so both index reads are in range.
    const l = left[i] as string;
    // SAFETY: the same bound.
    const r = right[i] as string;
    if (l === r) continue;

    const bothNumeric = /^\d/.test(l) && /^\d/.test(r);
    if (!bothNumeric) return l < r ? -1 : 1;

    const diff = compareDigitRuns(l, r);
    if (diff !== 0) return diff;

    // Equal value, different text — `01` against `1`. Fewer leading zeros come
    // first, and that is decided HERE. An earlier draft claimed it in a comment
    // and did not do it: it fell through to the next run and returned 0 when
    // there was none, so the deterministic order only emerged by accident
    // through `compareEntries`'s name fallback, and this exported function
    // contradicted its own documentation when called directly.
    if (l.length !== r.length) return l.length - r.length;
  }

  return left.length - right.length;
}

/**
 * Compare two digit runs by value, without `Number`.
 *
 * `Number("99999999999999999998")` and `Number("99999999999999999999")` are the
 * same double, so two hashes or epoch-nanosecond timestamps differing only in
 * their low digits would compare equal. Stripping leading zeros and comparing
 * by length, then lexicographically, is exact at every length.
 */
function compareDigitRuns(a: string, b: string): number {
  const left = a.replace(/^0+(?=\d)/, "");
  const right = b.replace(/^0+(?=\d)/, "");
  if (left.length !== right.length) return left.length - right.length;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Sort a copy. The input is never mutated, so a caller's array stays stable.
 *
 * The third parameter is `reverse` and not `descending`, which it was called
 * until the wire contract grew a field for it. Every other surface — the
 * request, the renderer's listing options, the status bar — says `reverse`, and
 * one concept under two names is a rename waiting to happen at whichever
 * boundary is edited next.
 */
export function sortEntries(
  entries: readonly FsEntry[],
  mode: SortMode,
  reverse = false,
): FsEntry[] {
  const sorted = [...entries].sort((a, b) => compareEntries(a, b, mode));
  if (!reverse) return sorted;

  // Reversing wholesale would put files above directories. Reverse each group.
  const dirs = sorted.filter((e) => e.kind === "directory").reverse();
  const rest = sorted.filter((e) => e.kind !== "directory").reverse();
  return [...dirs, ...rest];
}
