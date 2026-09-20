import type { Direction, OverviewCommand } from "../overview/navigation.ts";
import { renderableAs } from "../preview/route.ts";
import type { Binding, HelpGroup, KeyContext, ViewKind } from "./types.ts";

/**
 * The single source of truth for normal-mode keybindings.
 *
 * Both the dispatcher and the help overlay read this one table, so a binding
 * added here automatically works AND appears in the cheat sheet. That is the
 * property the Qt original was built for and the reason it is ported as data
 * rather than rewritten as a switch.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 * These are MODES, not bindings, and stay in the imperative cascade outside the
 * registry: the modal block, the bookmark sub-mode, chord RESOLUTION, and flash
 * navigation. Picker suppression is a pre-pass inside `dispatch`, not a row.
 *
 * ── Keys are browser key values, lowercased ─────────────────────────────────
 * `"j"`, `"arrowdown"`, `"enter"`, `"escape"`, `" "`, `"tab"`. Matching
 * lowercases the incoming `KeyboardEvent.key`, so `Shift+G` arrives as `"G"`,
 * compares as `"g"`, and its Shift requirement is checked separately by `mods`.
 *
 * ── One thing the web port gets for free ────────────────────────────────────
 * Qt needed a separate `Key_Backtab` for Shift+Tab. The browser reports
 * `key: "Tab"` with `shift: true`, so previous-tab is an ordinary
 * `mods: "Ctrl+Shift"` row on the same key as next-tab.
 */

// ── CORE: identical in both views ───────────────────────────────────────────

export const CORE: readonly Binding[] = [
  // Navigation
  {
    id: "nav.down",
    keys: ["j", "arrowdown"],
    mods: "",
    keycap: "j  ↓",
    label: "Move down",
    icon: "keyboard_arrow_down",
    group: "Navigation",
    run: (ctx) => ctx.actions.moveDown(),
  },
  {
    id: "nav.up",
    keys: ["k", "arrowup"],
    mods: "",
    keycap: "k  ↑",
    label: "Move up",
    icon: "keyboard_arrow_up",
    group: "Navigation",
    run: (ctx) => ctx.actions.moveUp(),
  },
  {
    id: "nav.bottom",
    keys: ["g"],
    mods: "Shift",
    keycap: "G",
    label: "Jump to bottom",
    icon: "vertical_align_bottom",
    group: "Navigation",
    run: (ctx) => ctx.actions.jumpToBottom(),
  },
  {
    id: "nav.activate",
    keys: ["enter"],
    mods: "",
    keycap: "⏎",
    label: "Open / enter",
    icon: "subdirectory_arrow_left",
    group: "Navigation",
    run: (ctx) => ctx.actions.activate(),
  },
  {
    id: "nav.halfDown",
    keys: ["d"],
    mods: "Ctrl",
    keycap: "⌃d",
    label: "Half-page down",
    icon: "keyboard_double_arrow_down",
    group: "Navigation",
    run: (ctx) => ctx.actions.halfPageDown(),
  },
  {
    id: "nav.halfUp",
    keys: ["u"],
    mods: "Ctrl",
    keycap: "⌃u",
    label: "Half-page up",
    icon: "keyboard_double_arrow_up",
    group: "Navigation",
    run: (ctx) => ctx.actions.halfPageUp(),
  },

  // History
  {
    id: "hist.back",
    keys: ["s"],
    mods: "Shift",
    keycap: "⇧S",
    label: "Back",
    icon: "arrow_back",
    group: "History",
    run: (ctx) => ctx.actions.historyBack(),
  },
  {
    id: "hist.forward",
    keys: ["d"],
    mods: "Shift",
    keycap: "⇧D",
    label: "Forward",
    icon: "arrow_forward",
    group: "History",
    run: (ctx) => ctx.actions.historyForward(),
  },

  // File operations
  {
    id: "op.delete",
    keys: ["d"],
    mods: "",
    keycap: "d",
    label: "Trash",
    icon: "delete",
    group: "File",
    run: (ctx) => ctx.actions.trash(),
  },
  {
    id: "op.rename",
    keys: ["r"],
    mods: "",
    keycap: "r",
    label: "Rename",
    icon: "drive_file_rename_outline",
    group: "File",
    run: (ctx) => ctx.actions.rename(false),
  },
  {
    id: "op.create",
    keys: ["a"],
    mods: "",
    keycap: "a",
    label: "New file / folder",
    icon: "add",
    group: "File",
    run: (ctx) => ctx.actions.createEntry(),
  },
  {
    id: "op.pickerSaveEdit",
    keys: ["r"],
    mods: "Ctrl",
    keycap: "⌃r",
    label: "Edit save name",
    icon: "edit_note",
    group: "File",
    when: (ctx) => ctx.state.picker.saveMode,
    run: (ctx) => ctx.actions.editSaveName(),
  },

  // Clipboard
  {
    id: "clip.yank",
    keys: ["y"],
    mods: "",
    keycap: "y",
    label: "Yank (copy)",
    icon: "content_copy",
    group: "Clipboard",
    run: (ctx) => ctx.actions.yank(),
  },
  {
    id: "clip.cut",
    keys: ["x"],
    mods: "",
    keycap: "x",
    label: "Cut",
    icon: "content_cut",
    group: "Clipboard",
    run: (ctx) => ctx.actions.cut(),
  },
  {
    id: "clip.paste",
    keys: ["p"],
    mods: "",
    keycap: "p",
    label: "Paste",
    icon: "content_paste",
    group: "Clipboard",
    run: (ctx) => ctx.actions.paste(),
  },
  {
    id: "clip.pasteCtrl",
    keys: ["v"],
    mods: "Ctrl",
    keycap: "⌃v",
    label: "Paste",
    icon: "content_paste",
    group: "Clipboard",
    run: (ctx) => ctx.actions.paste(),
  },

  // Selection
  {
    id: "sel.toggle",
    keys: [" "],
    mods: "",
    keycap: "␣",
    label: "Select / mark",
    icon: "check_box",
    group: "Selection",
    run: (ctx) => ctx.actions.toggleSelection(),
  },
  {
    id: "sel.clear",
    keys: ["escape"],
    mods: "",
    keycap: "Esc",
    label: "Clear selection",
    icon: "deselect",
    group: "Selection",
    when: (ctx) => ctx.state.selectedCount > 0,
    run: (ctx) => ctx.actions.clearSelection(),
  },

  // Search and jump
  {
    // `mods: "*"` — a symbol glyph. On the Latin-American layout `/` is Shift+7,
    // so the event carries Shift and a strict `""` match would reject it. See
    // the `Mods` documentation; every glyph binding below follows this rule.
    id: "search.start",
    keys: ["/"],
    mods: "*",
    keycap: "/",
    label: "Search",
    icon: "search",
    group: "Search & jump",
    run: (ctx) => ctx.actions.startSearch(),
  },
  {
    id: "match.next",
    keys: ["n"],
    mods: "",
    keycap: "n",
    label: "Next match",
    icon: "arrow_downward",
    group: "Search & jump",
    when: (ctx) => !ctx.state.searchActive && ctx.state.matchCount > 0,
    run: (ctx) => ctx.actions.nextMatch(),
  },
  {
    id: "match.prev",
    keys: ["n"],
    mods: "Shift",
    keycap: "⇧N",
    label: "Previous match",
    icon: "arrow_upward",
    group: "Search & jump",
    when: (ctx) => !ctx.state.searchActive && ctx.state.matchCount > 0,
    run: (ctx) => ctx.actions.previousMatch(),
  },
  {
    id: "flash.enter",
    keys: ["s"],
    mods: "",
    keycap: "s",
    label: "Flash jump",
    icon: "bolt",
    group: "Search & jump",
    run: (ctx) => ctx.actions.startFlash(),
  },
  {
    id: "finder.fuzzy",
    keys: ["f"],
    mods: "",
    keycap: "f",
    label: "Fuzzy finder",
    icon: "manage_search",
    group: "Search & jump",
    run: (ctx) => ctx.actions.openFuzzyFinder(),
  },

  // Chord prefixes. Resolution lives in the cascade, never here.
  {
    id: "chord.go",
    keys: ["g"],
    mods: "",
    keycap: "g",
    label: "Go to / bookmarks…",
    icon: "explore",
    group: "Chords",
    run: (ctx) => ctx.actions.setChordPrefix("g"),
  },
  {
    id: "chord.copy",
    keys: ["c"],
    mods: "",
    keycap: "c",
    label: "Copy to clipboard…",
    icon: "content_copy",
    group: "Chords",
    run: (ctx) => ctx.actions.setChordPrefix("c"),
  },
  {
    id: "chord.sort",
    keys: [","],
    mods: "*",
    keycap: ",",
    label: "Sort by…",
    icon: "sort",
    group: "Chords",
    run: (ctx) => ctx.actions.setChordPrefix(","),
  },

  // View
  {
    id: "view.toggle",
    keys: ["e"],
    mods: "Ctrl",
    keycap: "⌃e",
    label: "Open file tree",
    when: (ctx) => !ctx.state.picker.active,
    icon: "account_tree",
    group: "View",
    run: (ctx) => ctx.actions.toggleViewMode(),
  },

  // Help
  {
    id: "help.open",
    keys: ["?"],
    mods: "*",
    keycap: "?",
    label: "Keyboard help",
    icon: "help",
    group: "Help",
    run: (ctx) => ctx.actions.openHelp(),
  },
];

// ── MILLER_ONLY ─────────────────────────────────────────────────────────────

const OVERVIEW_DIRECTIONS: readonly {
  direction: Direction;
  key: string;
  arrow: string;
  halfAlias?: string;
}[] = [
  { direction: "left", key: "h", arrow: "arrowleft" },
  { direction: "down", key: "j", arrow: "arrowdown", halfAlias: "d" },
  { direction: "up", key: "k", arrow: "arrowup", halfAlias: "u" },
  { direction: "right", key: "l", arrow: "arrowright" },
];
const OVERVIEW_KEYCAPS = new Map([
  [" ", "Space"],
  ["enter", "Enter"],
  ["arrowleft", "←"],
  ["arrowdown", "↓"],
  ["arrowup", "↑"],
  ["arrowright", "→"],
]);
function overviewBinding(
  command: OverviewCommand,
  keys: readonly string[],
  mods: Binding["mods"],
  label: string,
): Binding {
  return {
    id: `overview.${command}`,
    keys,
    mods,
    keycap:
      `${mods === "Symbol" ? "" : mods} ${keys.map((key) => OVERVIEW_KEYCAPS.get(key) ?? key).join(" / ")}`.trim(),
    label,
    icon: "account_tree",
    group: "View",
    run: (ctx) => (command === "help" ? ctx.actions.openHelp() : ctx.overview?.command?.(command)),
  };
}
export const OVERVIEW_ONLY: readonly Binding[] = [
  ...OVERVIEW_DIRECTIONS.flatMap(({ direction, key, arrow, halfAlias }) => [
    overviewBinding(direction, [key, arrow], "", `Select ${direction}`),
    overviewBinding(
      `half-${direction}`,
      halfAlias ? [key, arrow, halfAlias] : [key, arrow],
      "Ctrl",
      `Pan half viewport ${direction}`,
    ),
    overviewBinding(
      `full-${direction}`,
      [key, arrow],
      "Ctrl+Shift",
      `Pan full viewport ${direction}`,
    ),
  ]),
  overviewBinding("zoom-in", ["+", "="], "Symbol", "Zoom in"),
  overviewBinding("zoom-out", ["-"], "Symbol", "Zoom out"),
  overviewBinding("reset", ["0"], "", "Reset zoom"),
  overviewBinding("toggle-minimap", ["m"], "Alt", "Toggle minimap"),
  overviewBinding("fit", ["f"], "", "Fit loaded graph"),
  overviewBinding("toggle", [" "], "", "Toggle folder"),
  overviewBinding("flash", ["s"], "", "Flash visible names"),
  overviewBinding("search", ["/"], "Symbol", "Search loaded paths"),
  overviewBinding("search-next", ["n"], "", "Next search result"),
  overviewBinding("search-previous", ["n"], "Shift", "Previous search result"),
  overviewBinding("help", ["?"], "Symbol", "Overview help"),
  overviewBinding("reveal", ["enter"], "", "Reveal in Miller"),
  {
    id: "overview.close",
    keys: ["escape"],
    mods: "",
    keycap: "Esc",
    label: "Close overview",
    icon: "close",
    group: "View",
    run: (ctx) => ctx.overview?.toggle(),
  },
  {
    id: "overview.toggle",
    keys: ["o"],
    mods: "Ctrl",
    keycap: "Ctrl+O",
    label: "Close overview",
    icon: "close",
    group: "View",
    run: (ctx) => ctx.overview?.toggle(),
  },
];
export const MILLER_ONLY: readonly Binding[] = [
  {
    id: "miller.overview",
    keys: ["o"],
    mods: "Ctrl",
    keycap: "Ctrl+O",
    label: "Folder overview",
    icon: "account_tree",
    group: "View",
    when: (ctx) => !ctx.state.picker.active,
    run: (ctx) => ctx.overview?.toggle(),
  },
  {
    id: "miller.up",
    keys: ["h", "arrowleft"],
    mods: "",
    keycap: "h  ←",
    label: "Up a directory",
    icon: "arrow_back",
    group: "Navigation",
    run: (ctx) => ctx.actions.goUp(),
  },
  {
    id: "miller.into",
    keys: ["l", "arrowright"],
    mods: "",
    keycap: "l  →",
    label: "Enter directory",
    icon: "arrow_forward",
    group: "Navigation",
    run: (ctx) => ctx.actions.enterDirectory(),
  },
  {
    id: "miller.contextMenu",
    keys: ["enter"],
    mods: "Ctrl",
    keycap: "⌃⏎",
    label: "Context menu",
    icon: "more_horiz",
    group: "Navigation",
    // A deliberate deviation from the original, which carried this same test
    // INSIDE its run body. There it consumed Ctrl+Enter on a directory and then
    // did nothing; as a `when` the key falls through instead, which is what the
    // registry's own contract says a false condition means. Nothing else claims
    // Ctrl+Enter today, so the visible behaviour is unchanged.
    when: (ctx) => ctx.state.cursorEntry !== null && !ctx.state.cursorEntry.isDirectory,
    run: (ctx) => ctx.actions.openContextMenu(),
  },
  {
    id: "miller.shiftEnter",
    keys: ["enter"],
    mods: "Shift",
    keycap: "⇧⏎",
    label: "Open (copy path in picker)",
    icon: "content_paste_go",
    group: "Navigation",
    run: (ctx) => ctx.actions.openCopyingPath(),
  },
  {
    id: "miller.tabBoundary",
    keys: ["tab"],
    mods: "",
    keycap: "⇥",
    label: "Jump dir / file boundary",
    icon: "swap_vert",
    group: "Navigation",
    run: (ctx) => ctx.actions.jumpDirectoryFileBoundary(),
  },
  {
    // Miller consumes a stray Escape. Project modes close through their own
    // binding, without propagating Escape to the host window handler.
    id: "miller.escapeSwallow",
    keys: ["escape"],
    mods: "",
    keycap: "Esc",
    label: "Dismiss",
    icon: "close",
    group: "Navigation",
    run: (ctx) => ctx.actions.dismiss(),
  },

  // History aliases
  {
    id: "miller.home",
    keys: ["~"],
    mods: "*",
    keycap: "~",
    label: "Go home",
    icon: "home",
    group: "History",
    run: (ctx) => ctx.actions.goHome(),
  },
  {
    id: "miller.back",
    keys: ["-"],
    mods: "*",
    keycap: "-",
    label: "Back",
    icon: "arrow_back",
    group: "History",
    run: (ctx) => ctx.actions.historyBack(),
  },
  {
    id: "miller.forward",
    keys: ["="],
    mods: "*",
    keycap: "=",
    label: "Forward",
    icon: "arrow_forward",
    group: "History",
    run: (ctx) => ctx.actions.historyForward(),
  },

  // File
  {
    id: "miller.renameExt",
    keys: ["r"],
    mods: "Shift",
    keycap: "⇧R",
    label: "Rename (with extension)",
    icon: "edit",
    group: "File",
    run: (ctx) => ctx.actions.rename(true),
  },

  // View
  {
    id: "miller.toggleHidden",
    keys: ["."],
    mods: "*",
    keycap: ".",
    label: "Toggle hidden files",
    icon: "visibility",
    group: "View",
    run: (ctx) => ctx.actions.toggleHidden(),
  },
  {
    // Gated to HTML so Ctrl+R falls through on anything else — and so it never
    // clashes with `op.pickerSaveEdit`, which is also Ctrl+R, is gated on save
    // mode, and sits earlier in CORE so it wins inside a save picker.
    id: "miller.renderToggle",
    keys: ["r"],
    mods: "Ctrl",
    keycap: "⌃r",
    // Read verbatim by the help sheet. It said "Render HTML preview" while HTML
    // was the only rendered view; markdown has one now, and the key is one key.
    label: "Rendered view / source",
    icon: "article",
    group: "View",
    when: (ctx) => isRenderable(ctx),
    run: (ctx) => ctx.actions.toggleDocumentRender(),
  },

  // Search and jump
  {
    id: "miller.zoxide",
    keys: ["z"],
    mods: "",
    keycap: "z",
    label: "Zoxide jump",
    icon: "history",
    group: "Search & jump",
    run: (ctx) => ctx.actions.openZoxide(),
  },

  // Tools
  {
    id: "miller.audioToggle",
    keys: ["p"],
    mods: "Ctrl",
    keycap: "⌃p",
    label: "Play / pause audio",
    icon: "play_circle",
    group: "Tools",
    run: (ctx) => ctx.actions.toggleAudioPlayback(),
  },

  // Tabs
  {
    id: "miller.tabNew",
    keys: ["t"],
    mods: "",
    keycap: "t",
    label: "New tab",
    icon: "add",
    group: "Tabs",
    run: (ctx) => ctx.actions.tabNew(),
  },
  {
    id: "miller.tabClose",
    keys: ["q"],
    mods: "Ctrl",
    keycap: "⌃q",
    label: "Close tab",
    icon: "close",
    group: "Tabs",
    run: (ctx) => ctx.actions.tabClose(),
  },
  {
    id: "miller.tabPrev",
    keys: ["["],
    mods: "*",
    keycap: "[",
    label: "Previous tab",
    icon: "chevron_left",
    group: "Tabs",
    run: (ctx) => ctx.actions.tabPrevious(),
  },
  {
    id: "miller.tabNext",
    keys: ["]"],
    mods: "*",
    keycap: "]",
    label: "Next tab",
    icon: "chevron_right",
    group: "Tabs",
    run: (ctx) => ctx.actions.tabNext(),
  },
  {
    id: "miller.tabNextCtrl",
    keys: ["tab"],
    mods: "Ctrl",
    keycap: "⌃⇥",
    label: "Next tab",
    icon: "chevron_right",
    group: "Tabs",
    run: (ctx) => ctx.actions.tabNext(),
  },
  {
    // Qt needed a separate `Key_Backtab` here. The browser reports Shift+Tab as
    // `key: "Tab"` with `shift: true`, so this is an ordinary modifier row.
    id: "miller.tabPrevCtrl",
    keys: ["tab"],
    mods: "Ctrl+Shift",
    keycap: "⌃⇧⇥",
    label: "Previous tab",
    icon: "chevron_left",
    group: "Tabs",
    run: (ctx) => ctx.actions.tabPrevious(),
  },
];

// ── TREE_ONLY ───────────────────────────────────────────────────────────────

/** Tree mode bindings share the dispatch and help registry with overview. */
export const TREE_ONLY: readonly Binding[] = [
  {
    id: "tree.close",
    keys: ["escape"],
    mods: "",
    keycap: "Esc",
    label: "Close file tree",
    icon: "close",
    group: "View",
    run: (ctx) => ctx.tree?.close(),
  },
  {
    id: "tree.first",
    keys: ["home"],
    mods: "",
    keycap: "Home",
    label: "First row",
    icon: "vertical_align_top",
    group: "Navigation",
    run: (ctx) => ctx.actions.jumpToTop(),
  },
  {
    id: "tree.last",
    keys: ["end"],
    mods: "",
    keycap: "End",
    label: "Last row",
    icon: "vertical_align_bottom",
    group: "Navigation",
    run: (ctx) => ctx.actions.jumpToBottom(),
  },
  {
    id: "tree.pageDown",
    keys: ["pagedown"],
    mods: "",
    keycap: "PgDn",
    label: "Page down",
    icon: "keyboard_double_arrow_down",
    group: "Navigation",
    run: (ctx) => ctx.actions.treePageDown(),
  },
  {
    id: "tree.pageUp",
    keys: ["pageup"],
    mods: "",
    keycap: "PgUp",
    label: "Page up",
    icon: "keyboard_double_arrow_up",
    group: "Navigation",
    run: (ctx) => ctx.actions.treePageUp(),
  },

  {
    id: "tree.collapseOrParent",
    keys: ["h", "arrowleft"],
    mods: "",
    keycap: "h  ←",
    label: "Collapse / parent",
    icon: "chevron_left",
    group: "Navigation",
    run: (ctx) => ctx.actions.treeCollapseOrParent(),
  },
  {
    id: "tree.expandOrActivate",
    keys: ["l", "arrowright"],
    mods: "",
    keycap: "l  →",
    label: "Expand / first child",
    icon: "chevron_right",
    group: "Navigation",
    run: (ctx) => ctx.actions.treeExpandOrActivate(),
  },
  {
    id: "tree.toggleExpand",
    keys: ["o"],
    mods: "",
    keycap: "o",
    label: "Toggle expand",
    icon: "unfold_more",
    group: "Navigation",
    run: (ctx) => ctx.actions.treeToggleExpand(),
  },
  {
    id: "tree.toggleHidden",
    keys: ["h"],
    mods: "Shift",
    keycap: "⇧H",
    label: "Toggle hidden files",
    icon: "visibility",
    group: "View",
    run: (ctx) => ctx.actions.treeToggleHidden(),
  },
  {
    id: "tree.refreshAll",
    keys: ["r"],
    mods: "Shift",
    keycap: "⇧R",
    label: "Refresh tree",
    icon: "refresh",
    group: "View",
    run: (ctx) => ctx.actions.treeRefresh(),
  },
];

/**
 * Does the entry under the cursor have a rendered form?
 *
 * **`renderableAs` and not a list of MIME strings here.** The panel asks the
 * same function about the same question, so the two cannot disagree about
 * which files qualify. A second list is the shape that cost the previous cycle
 * a release, when the renderer's hand-written MIME table and the system
 * database disagreed about compressed tarballs while every test passed.
 */
function isRenderable(ctx: KeyContext): boolean {
  const entry = ctx.state.cursorEntry;
  return entry !== null && renderableAs(entry.name, entry.mimeType) !== null;
}

const TREE_SHARED = new Set([
  "search.start",
  "match.next",
  "match.prev",
  "flash.enter",
  "nav.down",
  "nav.up",
  "nav.activate",
  "nav.bottom",
  "nav.halfDown",
  "nav.halfUp",
  "chord.go",
  "view.toggle",
  "help.open",
]);
const TREE_MILLER = new Set([
  "miller.overview",
  "miller.toggleHidden",
  "miller.tabNew",
  "miller.tabClose",
  "miller.tabPrev",
  "miller.tabNext",
  "miller.tabPrevCtrl",
  "miller.tabNextCtrl",
]);
const TREE_SUPPORTED = new Set([
  "tree.close",
  "tree.collapseOrParent",
  "tree.expandOrActivate",
  "tree.toggleExpand",
  "tree.toggleHidden",
  "tree.refreshAll",
  "tree.first",
  "tree.last",
  "tree.pageDown",
  "tree.pageUp",
]);

export function bindingsFor(view: ViewKind): readonly Binding[] {
  if (view === "overview") return OVERVIEW_ONLY;
  if (view === "tree")
    return [
      ...CORE.filter((binding) => TREE_SHARED.has(binding.id)),
      ...MILLER_ONLY.filter((binding) => TREE_MILLER.has(binding.id)),
      ...TREE_ONLY.filter((binding) => TREE_SUPPORTED.has(binding.id)),
    ];
  return [...CORE, ...MILLER_ONLY];
}

/**
 * The order the help overlay renders groups in.
 *
 * A test asserts every binding's group is one of these, so a row given an
 * unknown group cannot silently vanish from the cheat sheet — which would
 * recreate exactly the drift this registry exists to prevent. "Chords" is
 * rendered from the chord table as expanded sub-menus rather than from the bare
 * prefix rows, so the overlay filters it out of this list.
 */
export const HELP_GROUPS: readonly HelpGroup[] = [
  "Navigation",
  "History",
  "File",
  "Clipboard",
  "Selection",
  "Search & jump",
  "Chords",
  "View",
  "Tabs",
  "Tools",
  "Help",
];

/** A text-input mode, which has no binding row but still belongs in the help. */
export interface HelpMode {
  readonly keycap: string;
  readonly label: string;
  readonly icon: string;
}

/** The modes, as static help rows, so the cheat sheet is complete. */
export const MODES: readonly HelpMode[] = [
  { keycap: "s", label: "Flash jump — type letters to jump, Esc cancels", icon: "bolt" },
  { keycap: "/", label: "Search — type to filter, n/N to cycle, Enter confirms", icon: "search" },
  { keycap: "gn / gx", label: "Bookmarks — assign / delete with a letter", icon: "bookmark" },
];
