import type { OverviewCommand } from "../overview/navigation.ts";
/**
 * The shapes the keyboard registry is built from.
 *
 * Separated from the registry itself so the table stays readable as a table.
 */

/** Which set of bindings is in force. */
export type ViewKind = "miller" | "tree" | "overview";

/**
 * One key press, reduced to what a binding can match on.
 *
 * `key` is the browser's `KeyboardEvent.key` — the glyph PRODUCED, not the
 * physical key. That distinction is the whole reason the modifier rules below
 * exist: on the Latin-American layout `/` is Shift+7, and the browser reports
 * `key: "/"` with `shift: true`.
 */
export interface KeyEvent {
  readonly key: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
  readonly altGraph?: boolean;
}

/**
 * Which modifiers a binding requires.
 *
 * `"*"` means "ignore modifiers entirely", and it is **load-bearing for every
 * symbol glyph**. The modifiers that PRODUCE a punctuation glyph are
 * layout-dependent: on the Latin-American layout `/` is Shift+7 and `=` is
 * Shift+0, so those events arrive with `shift: true`. A binding declaring `""`
 * rejects them and the key silently does nothing — exactly the regression that
 * broke slash-search in the Qt build after its own registry migration. Letters
 * and real chords keep precise modifiers, because there the modifier is the
 * user's intent rather than a side effect of the layout.
 */
export type Mods = "" | "Ctrl" | "Shift" | "Alt" | "Ctrl+Shift" | "*" | "Symbol";

/** Where a binding appears in the help sheet. */
export type HelpGroup =
  | "Navigation"
  | "History"
  | "File"
  | "Clipboard"
  | "Selection"
  | "Search & jump"
  | "Chords"
  | "View"
  | "Tabs"
  | "Tools"
  | "Help";

/** The entry under the cursor, as much of it as a binding needs to decide. */
export interface CursorEntry {
  readonly name: string;
  readonly path: string;
  readonly isDirectory: boolean;
  readonly isImage: boolean;
  readonly mimeType: string;
}

/**
 * Picker mode, as the registry sees it.
 *
 * A file chooser is not a file manager: clipboard operations do not belong in
 * one, which is what the suppression pre-pass enforces. `fileOps` is the opt-out
 * for an embedding host that wants the full set anyway.
 */
export interface PickerState {
  readonly active: boolean;
  readonly saveMode: boolean;
  readonly fileOps: boolean;
  readonly multiple: boolean;
  /** True when the picker is choosing a directory rather than a file. */
  readonly directory: boolean;
}

/** Everything a `when()` may read. Never mutated by the registry. */
export interface KeyState {
  readonly selectedCount: number;
  readonly searchActive: boolean;
  readonly matchCount: number;
  readonly cursorEntry: CursorEntry | null;
  readonly picker: PickerState;
}

/** Which bookmark operation the sub-mode is capturing a letter for. */
export type BookmarkSubMode = "create" | "delete";

/** Which sort a chord asked for. */
export type SortKey = "alphabetical" | "modified" | "size" | "extension" | "natural";

/** What the copy chord puts on the clipboard. */
export type CopyTarget = "path" | "filename" | "nameWithoutExtension" | "directory" | "imageBytes";

/**
 * Everything a binding can do, as an interface the host implements.
 *
 * The Qt original injected its singletons through `ctx.services` for one
 * reason: it made dispatch testable without loading the UI. The same reason
 * applies here and the same shape is kept. A test passes a recording stub and
 * asserts which method a key reached; nothing in this package knows what a
 * window is.
 *
 * Every method returns void. A binding decides WHICH operation runs, never what
 * the operation does — that split is what keeps the table readable.
 */
export interface KeyActions {
  // Navigation
  moveDown(): void;
  moveUp(): void;
  jumpToTop(): void;
  jumpToBottom(): void;
  halfPageDown(): void;
  halfPageUp(): void;
  activate(): void;
  goUp(): void;
  enterDirectory(): void;
  goHome(): void;
  jumpDirectoryFileBoundary(): void;
  /** Swallow a stray Escape so it does not reach the host's close handling. */
  dismiss(): void;

  // History
  historyBack(): void;
  historyForward(): void;

  // File operations
  trash(): void;
  rename(withExtension: boolean): void;
  createEntry(): void;
  editSaveName(): void;

  // Clipboard
  yank(): void;
  cut(): void;
  paste(): void;
  copyToClipboard(target: CopyTarget): void;

  // Selection
  toggleSelection(): void;
  clearSelection(): void;

  // Search and jump
  startSearch(): void;
  nextMatch(): void;
  previousMatch(): void;
  startFlash(): void;
  openFuzzyFinder(): void;
  openZoxide(): void;

  // Chords
  setChordPrefix(prefix: string): void;
  startBookmarkSubMode(mode: BookmarkSubMode): void;
  exitBookmarkSubMode(): void;
  navigateToBookmark(letter: string): void;
  /**
   * Assign or remove a bookmark on this letter.
   *
   * The host decides whether the letter is reserved, whether a bookmark exists
   * there, and what to say about it. Keeping that here would mean porting the
   * bookmark store into a package that has no business knowing about one.
   */
  assignBookmark(letter: string): void;
  deleteBookmark(letter: string): void;
  setSort(key: SortKey, reverse: boolean): void;

  /** Say something transient. The chord guards are the only users today. */
  showMessage(text: string): void;

  // View
  toggleViewMode(): void;
  toggleHidden(): void;
  /**
   * Swap the rendered view for the source, and back.
   *
   * Named for the whole set rather than for one format: markdown and HTML both
   * have a rendered form, and the binding is gated by `renderableAs`, which is
   * what decides which files those are.
   */
  toggleDocumentRender(): void;
  openContextMenu(): void;
  /** Open, and in a picker put the chosen path on the clipboard first. */
  openCopyingPath(): void;

  // Tabs
  tabNew(): void;
  tabClose(): void;
  tabNext(): void;
  tabPrevious(): void;

  // Tools
  toggleAudioPlayback(): void;

  // Help
  openHelp(): void;

  // Tree only — reachable once the tree view exists.
  treeCollapseOrParent(): void;
  treeExpandOrActivate(): void;
  treeToggleExpand(): void;
  treeToggleHidden(): void;
  treePageDown(): void;
  treePageUp(): void;
  treeRefresh(): void;
}

/** What a binding is handed. */
export interface KeyContext {
  readonly tree?: { close(): void };
  readonly overview?: {
    toggle(): void;
    command?(name: OverviewCommand): void;
    revealDestination?: string;
  };
  readonly view: ViewKind;
  readonly state: KeyState;
  readonly actions: KeyActions;
}

/**
 * One binding.
 *
 * `when()` gates EXECUTION only. A false `when()` reports "not consumed" so the
 * key falls through to whatever handles it next — that is what preserves the
 * `n`/`N` guards. It does NOT hide the
 * row from the help sheet; view scoping is by membership in `CORE`,
 * `MILLER_ONLY` or `TREE_ONLY`.
 */
export interface Binding {
  readonly id: string;
  /** Lowercased `KeyboardEvent.key` values. See `normaliseKey`. */
  readonly keys: readonly string[];
  readonly mods: Mods;
  /** How the key is drawn in the help sheet. */
  readonly keycap: string;
  readonly label: string;
  readonly icon: string;
  readonly group: HelpGroup;
  readonly when?: (ctx: KeyContext) => boolean;
  readonly run: (ctx: KeyContext) => void;
}
