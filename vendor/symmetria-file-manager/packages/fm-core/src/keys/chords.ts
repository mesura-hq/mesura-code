import { isBareModifier, normaliseKey } from "./keyEvent.ts";
import type { BookmarkSubMode, KeyContext, KeyEvent, SortKey } from "./types.ts";

/**
 * Chord resolution, and the bookmark sub-mode.
 *
 * A chord is a MODE, not a binding. The registry's three prefix rows only set
 * the pending prefix; everything after that happens here, and the cascade must
 * call `resolveChord` BEFORE `dispatch`. That ordering is load-bearing: a chord
 * ending in a letter the picker suppresses — `cd`, say — would otherwise be
 * eaten by the suppression pre-pass before the resolver ever saw it.
 *
 * **There is no chord timeout, and there never was.** The project documentation
 * states a 500 ms timer twice; the Qt implementation has none. A prefix persists
 * until the next key, an Escape, a focus loss, or a tab switch. Resist adding a
 * timer to match the documentation — correct the documentation instead.
 */

/** One row of a chord's sub-menu, as the which-key overlay draws it. */
export interface ChordEntry {
  /** The key, or a `x/X` pair when case selects direction. */
  readonly key: string;
  readonly label: string;
  readonly icon: string;
}

export interface ChordGroup {
  readonly label: string;
  readonly binds: readonly ChordEntry[];
}

/**
 * The chord table, as data.
 *
 * Rendered by both the which-key overlay and the help sheet, for the same
 * reason the binding table is shared: one description, two readers, no drift.
 * User bookmarks are merged into the `g` group by the host, which owns them.
 */
export const CHORD_GROUPS: ReadonlyMap<string, ChordGroup> = new Map([
  [
    "g",
    {
      label: "go to",
      binds: [{ key: "g", label: "Top", icon: "vertical_align_top" }],
    },
  ],
  [
    "c",
    {
      label: "copy to clipboard",
      binds: [
        { key: "c", label: "File path", icon: "link" },
        { key: "f", label: "Filename", icon: "description" },
        { key: "n", label: "Name without extension", icon: "label" },
        { key: "d", label: "Directory path", icon: "folder" },
      ],
    },
  ],
  [
    ",",
    {
      label: "sort by",
      binds: [
        { key: "a/A", label: "Alphabetical", icon: "sort_by_alpha" },
        { key: "m/M", label: "Modified date", icon: "schedule" },
        { key: "s/S", label: "Size", icon: "straighten" },
        { key: "e/E", label: "Extension", icon: "extension" },
        { key: "n/N", label: "Natural", icon: "format_list_numbered" },
      ],
    },
  ],
]);

/**
 * The `g` group as the overlays should draw it, with the user's bookmarks.
 *
 * The chord table's own header has promised this since it was written: "User
 * bookmarks are merged into the `g` group by the host, which owns them." This
 * is that merge, and it deliberately mirrors `copyGroupFor` below — same shape,
 * same reason. An overlay must not advertise a letter that would answer "No
 * bookmark on d", and the only way it can know is to be handed the store.
 *
 * Sorted by letter. A map iterates in insertion order, which is whatever order
 * the file happened to be written in, so an unsorted list would reshuffle
 * itself as the user edited their bookmarks.
 */
export function goGroupWith(
  bookmarks: ReadonlyMap<string, { readonly label: string }>,
): ChordGroup {
  const base = CHORD_GROUPS.get("g");
  if (base === undefined) throw new Error("the go chord group is missing");

  const rows: ChordEntry[] = [...bookmarks]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, bookmark]) => ({ key, label: bookmark.label, icon: "bookmark" }));

  return { ...base, binds: [...base.binds, ...rows] };
}

/** The image row, offered only when the cursor sits on one. */
export const IMAGE_CHORD_ENTRY: ChordEntry = {
  key: "i",
  label: "Image to clipboard",
  icon: "image",
};

/**
 * The `c` group as it should be drawn right now.
 *
 * The image row appears only over an image, so neither overlay advertises a key
 * that would answer "Not an image".
 */
export function copyGroupFor(cursorIsImage: boolean): ChordGroup {
  const base = CHORD_GROUPS.get("c");
  if (base === undefined) throw new Error("the copy chord group is missing");
  return cursorIsImage ? { ...base, binds: [...base.binds, IMAGE_CHORD_ENTRY] } : base;
}

const SORT_KEYS: ReadonlyMap<string, SortKey> = new Map([
  ["a", "alphabetical"],
  ["m", "modified"],
  ["s", "size"],
  ["e", "extension"],
  ["n", "natural"],
]);

/** What a chord key resolved to, so a caller knows whether to redraw. */
export interface ChordResult {
  /** Always true — a pending chord consumes every key, including Escape. */
  readonly consumed: true;
  /** True when the chord was cancelled rather than executed. */
  readonly cancelled: boolean;
}

/**
 * Resolve one key against a pending chord prefix.
 *
 * Every key consumes: that is what makes a chord a mode. A bare modifier keeps
 * the chord pending — holding Shift to type an uppercase sort key must not
 * cancel it. Escape cancels without executing. Anything else clears the prefix
 * and runs whatever it maps to, or nothing.
 */
export function resolveChord(prefix: string, event: KeyEvent, ctx: KeyContext): ChordResult {
  if (isBareModifier(event)) return { consumed: true, cancelled: false };

  ctx.actions.setChordPrefix("");

  if (normaliseKey(event.key) === "escape") return { consumed: true, cancelled: true };

  // The sort chord is the one place CASE carries meaning — an uppercase key
  // means descending — so its key is read raw while the others are lowercased.
  executeChord(prefix, prefix === "," ? event.key : normaliseKey(event.key), ctx);
  return { consumed: true, cancelled: false };
}

function executeChord(prefix: string, key: string, ctx: KeyContext): void {
  if (ctx.view === "tree") {
    if (prefix === "g" && key === "g") ctx.actions.jumpToTop();
    return;
  }
  if (prefix === "g") resolveGoChord(key, ctx);
  else if (prefix === "c") resolveCopyChord(key, ctx);
  else if (prefix === ",") resolveSortChord(key, ctx);
}

function resolveGoChord(key: string, ctx: KeyContext): void {
  if (key === "g") ctx.actions.jumpToTop();
  else if (key === "n") ctx.actions.startBookmarkSubMode("create");
  else if (key === "x") ctx.actions.startBookmarkSubMode("delete");
  // Any other letter is a bookmark. The host knows which letters have one; an
  // unknown letter is its no-op, not ours.
  else ctx.actions.navigateToBookmark(key);
}

function resolveCopyChord(key: string, ctx: KeyContext): void {
  if (key === "i") {
    copyImageBytes(ctx);
    return;
  }
  if (key === "d") {
    ctx.actions.copyToClipboard("directory");
    return;
  }

  // With a selection these operate on every selected path; without one, on the
  // cursor entry. Which of the two applies is the host's business — the chord
  // only says WHAT to copy.
  if (ctx.state.selectedCount === 0 && ctx.state.cursorEntry === null) return;

  if (key === "c") ctx.actions.copyToClipboard("path");
  else if (key === "f") ctx.actions.copyToClipboard("filename");
  else if (key === "n") ctx.actions.copyToClipboard("nameWithoutExtension");
}

/**
 * Put the picture itself on the clipboard, not its path.
 *
 * Always the cursor entry, never the selection: a Wayland clipboard holds one
 * selection, so "copy these four images" has no meaning.
 */
function copyImageBytes(ctx: KeyContext): void {
  const entry = ctx.state.cursorEntry;
  if (entry === null || !entry.isImage) {
    ctx.actions.showMessage("Not an image");
    return;
  }

  // `isImage` is a content sniff, independent of the MIME type, so an "image"
  // can carry a non-image MIME — an RPG-Maker `.rpgmvp` reports
  // `application/octet-stream` and its raw bytes are not even valid PNG. Only
  // copy bytes the clipboard can honestly advertise; otherwise the paste target
  // receives mislabelled data.
  if (!entry.mimeType.startsWith("image/")) {
    ctx.actions.showMessage("Can't copy this image format");
    return;
  }

  ctx.actions.copyToClipboard("imageBytes");
}

function resolveSortChord(key: string, ctx: KeyContext): void {
  if (key === "") return;

  const sort = SORT_KEYS.get(key.toLowerCase());
  if (sort === undefined) return;

  // Uppercase means descending. Comparing the key against its own uppercase
  // form also treats a non-letter as descending, which no sort key is.
  ctx.actions.setSort(sort, key === key.toUpperCase());
}

/**
 * Capture one letter for the bookmark sub-mode.
 *
 * Also a mode, and also consumes everything. A bare modifier is held while
 * typing; Escape cancels; a letter performs the operation; anything else — a
 * digit, Enter — cancels rather than guessing.
 */
export function handleBookmarkSubMode(
  mode: BookmarkSubMode,
  event: KeyEvent,
  ctx: KeyContext,
): boolean {
  if (isBareModifier(event)) return true;

  const key = normaliseKey(event.key);
  if (key === "escape") {
    ctx.actions.exitBookmarkSubMode();
    return true;
  }

  if (/^[a-z]$/.test(key)) {
    if (mode === "create") ctx.actions.assignBookmark(key);
    else ctx.actions.deleteBookmark(key);
  }

  ctx.actions.exitBookmarkSubMode();
  return true;
}

/**
 * Which group a prefix draws, including the two that depend on state.
 *
 * `c` hides its image row away from an image, and `g` gains the user's
 * bookmarks. Both overlays call this rather than each deciding for itself: the
 * which-key HUD and the cheat sheet must not come to disagree about what a
 * prefix offers, and they would, because they are edited months apart.
 *
 * It lived in the HUD component for one commit, with the cheat sheet importing
 * it from there. That put a pure function with no DOM in it inside a component
 * file, and made one component depend on another for data rather than for
 * rendering. It belongs here, beside the table it reads.
 */
export function groupFor(
  prefix: string,
  cursorIsImage: boolean,
  bookmarks: ReadonlyMap<string, { readonly label: string }>,
): ChordGroup | undefined {
  if (prefix === "c") return copyGroupFor(cursorIsImage);
  if (prefix === "g") return goGroupWith(bookmarks);
  return CHORD_GROUPS.get(prefix);
}
