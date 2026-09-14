import type { FsEntry } from "./entry.ts";

/**
 * One pane's navigation state.
 *
 * Pure data with pure transitions, so every navigation rule is testable without
 * a window. The renderer holds one of these per tab and renders it; it never
 * decides where the cursor goes.
 */
export interface PaneState {
  /**
   * An absolute, normalised path.
   *
   * Every function here assumes `entries` holds ONE DIRECTORY's listing, where
   * the filesystem guarantees names are unique. Cursor memory and React list
   * keys both look entries up by name, so a flattened cross-directory listing —
   * search results, say — would silently pick the wrong entry.
   */
  readonly path: string;
  /**
   * The listing, in the order the MAIN process produced it.
   *
   * **INVARIANT: directories come first, as one contiguous block.**
   * `compareEntries` establishes it in every mode and in both directions, and
   * `sortEntries` preserves it when it reverses by reversing each group on its
   * own. Every listing reaches a pane through that one function today.
   *
   * `boundaryIndex` is the one reader that DEPENDS on it rather than merely
   * benefiting from it: it takes the first entry of the opposite kind as the
   * boundary, which is only the boundary while the kinds are contiguous. A
   * listing assembled some other way — a flattened search result, a hand-built
   * fixture, an incremental watcher diff that appends — would not fail loudly
   * there. It would move the cursor somewhere plausible and wrong.
   */
  readonly entries: readonly FsEntry[];
  readonly cursorIndex: number;
  /**
   * Where the cursor sat in each directory already visited.
   *
   * Per directory, not one global value. Going in and coming back out must land
   * the cursor where it was left — that is what makes Miller columns navigable
   * rather than a list that resets under you.
   */
  readonly cursorMemory: ReadonlyMap<string, string>;
  /**
   * The marked entries, by name.
   *
   * Per pane, so it is per tab the moment tabs exist — a selection that
   * followed the window would let a file operation act on entries the user
   * marked somewhere else entirely.
   *
   * Names rather than paths: an entry belongs to one directory, so the pane's
   * own path completes it. What the selection is FOR arrives with the file
   * operations; what it must be is per pane, and that is decided here.
   */
  readonly selection: ReadonlySet<string>;
}

/**
 * How many directories' cursors are remembered.
 *
 * Unbounded, this grows one entry per unique directory visited for the lifetime
 * of the renderer — days, in a resident application. Bounded, the copy that
 * `moveCursor` makes on every keystroke is also bounded: a held `j` copies at
 * most this many entries per repeat, which at 128 is noise beside a React
 * render.
 */
const MEMORY_LIMIT = 128;

export interface Breadcrumb {
  readonly label: string;
  readonly path: string;
}

export function createPane(path: string): PaneState {
  return { path, entries: [], cursorIndex: 0, cursorMemory: new Map(), selection: new Set() };
}

/**
 * The entry at an index, or `null`.
 *
 * Exists because the pointer needs to ask about a row that is NOT under the
 * cursor — a click decides what to do from what was clicked, and asking about
 * the cursor instead is how a double click opens the wrong file. `cursorEntry`
 * is the same question at one particular index.
 */
export function entryAt(pane: PaneState, index: number): FsEntry | null {
  return pane.entries[index] ?? null;
}

export function cursorEntry(pane: PaneState): FsEntry | null {
  return entryAt(pane, pane.cursorIndex);
}

/**
 * Is this something you can go into?
 *
 * One definition, because two callers ask it about different entries — the
 * keyboard about the cursor, the pointer about what was clicked — and the
 * answer decides enter-versus-open in both. A second copy would eventually
 * disagree about a symlinked directory, which the scan reports as `directory`
 * precisely so it can be entered.
 */
export function isDirectoryEntry(entry: FsEntry | null): boolean {
  return entry?.kind === "directory";
}

/**
 * Replace the listing, keeping the cursor on the same NAME where possible.
 *
 * A re-sort or a watcher refresh is not navigation. The user's attention is on
 * a file, not on an index, so moving the cursor under them is how the wrong
 * file gets deleted. When the name is gone, the index is clamped into range.
 */
/**
 * Where the directories stop and the files begin, from where the cursor is.
 *
 * From a directory it is the first non-directory; from anything else it is the
 * first directory. Returns -1 where there is nowhere to go — an empty listing,
 * or one holding a single kind.
 *
 * The two kinds are always contiguous blocks, because `compareEntries` puts
 * directories first in every order and in both directions. That is what makes
 * "the first entry of the opposite kind" the boundary rather than merely some
 * entry on the other side of it.
 *
 * It asks `isDirectoryEntry` rather than testing for `kind === "file"`. A
 * socket, a device node or a broken symlink comes back as `other`, and it
 * belongs on the side Tab reaches from a directory; testing for `file` would
 * skip past it and land somewhere the user did not ask for. -1 follows
 * `nextMatch` in `search.ts`, which reports "nowhere" the same way.
 */
export function boundaryIndex(pane: PaneState): number {
  const from = cursorEntry(pane);
  if (from === null) return -1;

  const wantDirectory = !isDirectoryEntry(from);
  return pane.entries.findIndex((entry) => isDirectoryEntry(entry) === wantDirectory);
}

export function setEntries(pane: PaneState, entries: readonly FsEntry[]): PaneState {
  // Memory is the only source of truth once populated. An earlier draft also
  // fell back to the current cursor entry, which could only ever fire on a
  // pane whose entries were still empty — dead in practice, and it obscured
  // that memory was doing all the work.
  const remembered = pane.cursorMemory.get(pane.path);
  const byName = remembered === undefined ? -1 : entries.findIndex((e) => e.name === remembered);

  const cursorIndex =
    byName >= 0 ? byName : Math.min(pane.cursorIndex, Math.max(entries.length - 1, 0));

  // Drop marks for entries that are gone.
  //
  // A selection is a set of NAMES, so a file deleted underfoot would leave its
  // name marked — and a later operation would act on whatever is recreated with
  // that name. Pruning on every refresh keeps the mark and the entry together.
  const present = new Set(entries.map((e) => e.name));
  const kept = [...pane.selection].filter((name) => present.has(name));
  const selection = kept.length === pane.selection.size ? pane.selection : new Set(kept);

  const next = { ...pane, entries, cursorIndex, selection };

  // A miss means the remembered entry is gone. Leaving the old name in memory
  // means that if a file with that name is ever recreated here, the cursor
  // teleports back to it on the next refresh — somewhere the user never
  // navigated and has not been for some time.
  return byName >= 0 ? next : { ...next, cursorMemory: remember(next, cursorIndex) };
}

/**
 * Move the cursor, without wrapping.
 *
 * Wrapping is disorienting in a list navigated by feel: hold `j`, the cursor
 * silently teleports to the top, and the next keystroke acts on the wrong file.
 */
export function moveCursor(pane: PaneState, delta: number): PaneState {
  if (pane.entries.length === 0) return { ...pane, cursorIndex: 0 };

  const cursorIndex = Math.max(0, Math.min(pane.entries.length - 1, pane.cursorIndex + delta));
  return { ...pane, cursorIndex, cursorMemory: remember(pane, cursorIndex) };
}

function remember(pane: PaneState, index: number): ReadonlyMap<string, string> {
  const name = pane.entries[index]?.name;
  if (name === undefined) return pane.cursorMemory;
  return rememberIn(pane.cursorMemory, pane.path, name);
}

/** Record `name` as the cursor for `path`, evicting the least recent. */
function rememberIn(
  memory: ReadonlyMap<string, string>,
  path: string,
  name: string,
): ReadonlyMap<string, string> {
  const next = new Map(memory);
  // Re-inserting moves the key to the end, so the iteration order is
  // least-recently-used first and the eviction below drops the right one.
  next.delete(path);
  next.set(path, name);

  while (next.size > MEMORY_LIMIT) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

/**
 * Record where the cursor should land in a directory the pane is not in yet.
 *
 * The other half of a jump into another column: record, then go. `setEntries`
 * restores from this memory by NAME when the listing arrives, so the cursor
 * ends on the entry that was labelled rather than at the top.
 *
 * **By name and for a NAMED path, which is what removes a hazard rather than
 * documenting one.** The Qt build writes the destination's cursor and the
 * departing directory's cursor into one cache, and carries a comment warning
 * that the two calls must happen in a particular order or the second overwrites
 * what the first meant. Here the departing directory's own memory is untouched,
 * so there is no order to get wrong.
 */
export function rememberCursorAt(pane: PaneState, path: string, name: string): PaneState {
  return { ...pane, cursorMemory: rememberIn(pane.cursorMemory, path, name) };
}

/**
 * Enter the directory under the cursor.
 *
 * Returns the pane unchanged when the cursor is not on a directory, so a caller
 * can bind this to a key without asking first. A symlink to a directory reports
 * `kind: "directory"`, which is what makes a symlinked directory enterable.
 */
export function enterDirectory(pane: PaneState): PaneState {
  const target = cursorEntry(pane);
  if (target === null || target.kind !== "directory") return pane;

  return {
    path: joinPath(pane.path, target.name),
    entries: [],
    cursorIndex: 0,
    cursorMemory: remember(pane, pane.cursorIndex),
    // A selection does not survive leaving the directory it was made in. The
    // names would still match in the new one, and a file operation would then
    // act on entries that merely share a name with what was marked.
    selection: new Set(),
  };
}

/**
 * Go to the parent, stopping at the root rather than climbing past it.
 *
 * The stop IS `goToPath`'s same-path rule and not a second guard beside it:
 * `parentOf("/")` returns `"/"`, so climbing from the root asks to go where it
 * already is and gets the pane back by reference. The body of this function was
 * byte-identical to that transition, guard included, which is one pane literal
 * too many — a field added to `PaneState` would have had to be remembered here
 * as well.
 */
export function leaveDirectory(pane: PaneState): PaneState {
  return goToPath(pane, parentOf(pane.path));
}

/**
 * Go to a path named outright, rather than to one the cursor is standing on.
 *
 * The third way a pane changes location, beside entering and leaving, and the
 * one every jump takes: a bookmark letter, a zoxide result, a breadcrumb, a
 * click in the parent column.
 *
 * **A jump to where we already are returns the pane BY REFERENCE, and that is
 * not a nicety.** Emptying a pane and re-listing it are two separate
 * mechanisms: the transition clears `entries` so the column blanks and refills,
 * and the watch reconciler starts the read — but the reconciler is keyed on the
 * PATH, so a jump that does not change the path never asks for a listing. The
 * hand-rolled transition this replaced cleared the entries anyway, and the
 * column then sat empty for as long as the tab stayed there: `gd` inside
 * Downloads reported "0 entries" for a directory full of files, and so did a
 * click on the current directory in the parent column. Nothing recovered it but
 * navigating away and back.
 *
 * The rule that follows, for anything added here later: **no NAVIGATION
 * transition may empty a pane without changing its path.** `didNavigate` is how
 * a caller asks whether one did. A listing that FAILS empties the pane at the
 * same path on purpose — see the `failed` branch in `useTabs.ts` — because that
 * is a report about a directory, not a move to one. Do not "fix" it to match
 * this rule.
 *
 * The selection is dropped for the same reason `enterDirectory` drops it — a
 * mark is a NAME, and a name that survives the move can match a different file
 * at the destination.
 */
export function goToPath(pane: PaneState, path: string): PaneState {
  if (path === pane.path) return pane;

  return {
    path,
    entries: [],
    cursorIndex: 0,
    cursorMemory: pane.cursorMemory,
    selection: new Set(),
  };
}

/**
 * Mark or unmark the entry under the cursor, and step past it.
 *
 * Advancing is what makes marking a run of files a repeated single keystroke
 * rather than an alternation of two. It stops at the last entry rather than
 * wrapping, for the same reason cursor movement does.
 */
export function toggleSelection(pane: PaneState): PaneState {
  const target = cursorEntry(pane);
  if (target === null) return pane;

  const selection = new Set(pane.selection);
  if (!selection.delete(target.name)) selection.add(target.name);

  const cursorIndex = Math.min(pane.cursorIndex + 1, pane.entries.length - 1);
  return { ...pane, selection, cursorIndex, cursorMemory: remember(pane, cursorIndex) };
}

/** Unmark everything. Returns the pane unchanged when nothing was marked. */
export function clearSelection(pane: PaneState): PaneState {
  return pane.selection.size === 0 ? pane : { ...pane, selection: new Set() };
}

/**
 * The path's segments, with every empty one dropped.
 *
 * One splitter for every path function here. `parentOf` used to strip only
 * TRAILING slashes while `breadcrumbs` collapsed internal ones, so the two
 * disagreed on `/home//jc` — `parentOf` answered `/home/` and `breadcrumbs`
 * answered `/home`. Two path parsers with different opinions is one too many.
 */
function segmentsOf(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}

export function joinPath(base: string, name: string): string {
  return base === "/" ? `/${name}` : `${base}/${name}`;
}

/**
 * The last segment of a path.
 *
 * Here rather than beside any one caller, because three slightly different
 * copies of `slice(lastIndexOf("/") + 1)` had accumulated across the tree and
 * review found the third being added. It lives with `joinPath` and `parentOf`
 * so every path question has one answer in one file.
 *
 * Trailing slashes are NOT stripped: these are entry paths, and a caller that
 * wants a human LABEL for a directory path wants `labelFor` in `bookmarks.ts`,
 * which is a different question with a different answer for `/`.
 */
export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function parentOf(path: string): string {
  const segments = segmentsOf(path);
  segments.pop();
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/** The path as clickable segments, root first. */
export function breadcrumbs(path: string): Breadcrumb[] {
  const crumbs: Breadcrumb[] = [{ label: "/", path: "/" }];

  let accumulated = "";
  for (const segment of segmentsOf(path)) {
    accumulated += `/${segment}`;
    crumbs.push({ label: segment, path: accumulated });
  }
  return crumbs;
}

/**
 * Did a navigation actually happen?
 *
 * `enterDirectory`, `leaveDirectory` and `goToPath` all return the pane BY
 * REFERENCE when there is nowhere to go, so a caller can bind them to a key
 * without asking first. This names that convention rather than leaving each
 * call site to know it. Keep the list complete: a transition that follows the
 * convention but is missing here is one a reader will not know to trust.
 */
export function didNavigate(before: PaneState, after: PaneState): boolean {
  return before !== after;
}
