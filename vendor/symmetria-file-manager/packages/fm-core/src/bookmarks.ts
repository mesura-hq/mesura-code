/**
 * Bookmarks: the letters, the seed, and what a stored file is allowed to say.
 *
 * ── It does not know where home is ──────────────────────────────────────────
 * The seed is a table of letter to a HOME-RELATIVE suffix, and the host hands
 * in the home directory. That is the same seam `filter.ts` uses for its
 * injected `ignored` set, and it is what keeps this package free of an
 * environment it deliberately does not compile against.
 *
 * ── The seed is written once, not merged forever ────────────────────────────
 * A seed re-merged on every start cannot be deleted from: `gx p` would remove
 * Pictures and the next launch would put it back, with no way for the user to
 * say no. So a missing file means the seed AND a write; a file that exists is
 * the whole answer. Qt settles it the same way — its defaults are documented as
 * "seeded on first run, deletable by the user".
 *
 * The one exception is a file that cannot be read at all. That is the user's
 * data mid-edit, so it is neither trusted nor overwritten: the seed is used in
 * memory and the file is left alone for them to repair.
 */

import { basename } from "./pane.ts";

export interface Bookmark {
  readonly path: string;
  /** What the overlays show beside the letter. The directory's own name. */
  readonly label: string;
}

export type BookmarkMap = Map<string, Bookmark>;

/**
 * The letters the go chord already spends.
 *
 * `gg` jumps to the top, `gn` opens the create sub-mode and `gx` the delete
 * one. A bookmark on any of them would be unreachable by construction, so the
 * store refuses to hold one rather than accepting it and never firing.
 */
export const RESERVED_LETTERS: ReadonlySet<string> = new Set(["g", "n", "x"]);

export function isReservedLetter(letter: string): boolean {
  return RESERVED_LETTERS.has(letter.toLowerCase());
}

/**
 * What a fresh machine gets, as letter to home-relative suffix.
 *
 * Eight rather than the Qt build's two. The operator asked for Downloads,
 * Pictures and Videos by name and uses those jumps constantly, and a seed that
 * cannot answer `gp` on a new machine fails the request it exists for.
 *
 * The names are English because this machine's directories are. Reading the
 * real ones from the XDG user-dirs file was considered and rejected: correct on
 * a localised system, and a file reader in the main process for a case that
 * does not arise here.
 *
 * `r` is `projects`, which is a convention of this machine rather than an XDG
 * directory. It is one line and `gx r` removes it.
 */
const SEED: readonly (readonly [string, string])[] = [
  ["h", ""],
  ["d", "Downloads"],
  ["p", "Pictures"],
  ["v", "Videos"],
  ["m", "Music"],
  ["o", "Documents"],
  ["c", ".config"],
  ["r", "projects"],
];

/**
 * A human label for a path: its last segment, or the path itself for the root.
 *
 * `basename` with two differences that are the whole reason this exists
 * separately: trailing slashes are stripped first, so `/home/jc/` labels as
 * `jc`; and a path with no last segment labels as ITSELF, so `/` stays `/`
 * rather than becoming an empty bookmark.
 */
export function labelFor(path: string): string {
  const last = basename(path.replace(/\/+$/, ""));
  return last === "" ? path : last;
}

/** The seed, resolved against a home directory. */
export function seedBookmarks(home: string): BookmarkMap {
  const base = home.replace(/\/+$/, "");
  const marks: BookmarkMap = new Map();

  for (const [letter, suffix] of SEED) {
    const path = suffix === "" ? base : `${base}/${suffix}`;
    marks.set(letter, { path, label: labelFor(path) });
  }
  return marks;
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

/** One stored entry, or `null` when the file's version of it cannot be used. */
function decodeOne(letter: string, raw: unknown): Bookmark | null {
  if (!/^[a-z]$/.test(letter) || isReservedLetter(letter)) return null;
  if (!isRecord(raw)) return null;

  const path = raw.path;
  // Absolute only. Every other path in this application is, and one that
  // resolves against a working directory the renderer never learns would land
  // somewhere different on each run.
  if (typeof path !== "string" || !path.startsWith("/")) return null;

  const label = raw.label;
  return { path, label: typeof label === "string" && label !== "" ? label : labelFor(path) };
}

/**
 * Read a parsed file into a store, dropping what cannot be used.
 *
 * Dropping rather than rejecting, per entry: one hand-edited bad line must not
 * cost the user their other seven bookmarks. A top-level value that is not an
 * object IS rejected wholesale, because a list or a string is not a partly
 * usable store — it is not a store.
 */
export function decodeBookmarks(raw: unknown): BookmarkMap {
  const marks: BookmarkMap = new Map();
  if (!isRecord(raw)) return marks;

  for (const [letter, value] of Object.entries(raw)) {
    const mark = decodeOne(letter, value);
    if (mark !== null) marks.set(letter, mark);
  }
  return marks;
}

/**
 * What the file said, or why it said nothing.
 *
 * `null` means no file, which is the only case that seeds. `"unreadable"` means
 * a file that exists and could not be parsed — a different answer, because it
 * must NOT be overwritten.
 */
export type StoredBookmarks = BookmarkMap | null | "unreadable";

export interface ResolvedBookmarks {
  readonly bookmarks: BookmarkMap;
  /** True only on a first run: the seed should be written to disk. */
  readonly shouldWrite: boolean;
}

/** Decide what the application uses, and whether the disk is owed a write. */
export function resolveBookmarks(seed: BookmarkMap, stored: StoredBookmarks): ResolvedBookmarks {
  if (stored === null) return { bookmarks: new Map(seed), shouldWrite: true };
  if (stored === "unreadable") return { bookmarks: new Map(seed), shouldWrite: false };
  return { bookmarks: new Map(stored), shouldWrite: false };
}
