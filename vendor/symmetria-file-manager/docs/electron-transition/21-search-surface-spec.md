# 21 — The search surface: one overlay, three modes

**Interface specification.** This document turns decision **D10**
(`15-decisions.md:222-317`) and the comparison in `17-search-grep-palette.md`
into one buildable design. An implementer reads this file and does not need to
re-read report 17.

Written 2026-08-25. Read-only research: no source file in either repository was
modified to produce it.

**Path prefixes used in every citation:**

| Prefix | Repository root |
|---|---|
| `fm/` | this worktree, `/home/jc/.t3/worktrees/symmetria-file-manager/t3code-a2a6aa9b` |
| `mesura/` | `/home/jc/projects/mesura-code` |

## 0. What is already fixed

These come from D10 and the vision document. This specification never
contradicts them.

1. The file manager's finder design wins. Six plumbing corrections from Mesura
   Code get adopted: a `matchedQuery`, a `truncated` flag, an "indexing" state
   distinct from "searching", an index keyed by working directory with an idle
   timeout, one shared dialog chrome, and Enter blocked while a newer query is
   in flight.
2. Content search runs **`ripgrep` as a subprocess**. `fff` keeps path search
   and `glob`. This reverses spike 6.
3. The command palette is a **third consumer of the keybinding registry**
   (`fm/qml/Symmetria/FileManager/UI/modules/filemanager/handlers/KeyRegistry.js`),
   never a parallel command array.
4. One window with tabs (`15-decisions.md:78-99`). Keyboard first. The host
   injects git; the panel knows nothing about git (`docs/vision.md:44-51`).

Two gaps neither product has, and both are specified here: **directory
drill-down inside the overlay**, and **preview-scroll keys**.

## 0.1 Where the code lives

| Layer | Package | Holds |
|---|---|---|
| Core | `file-manager-core` | the keybinding registry, the row types, the mode reducer, the rank formula, the byte-to-string conversion |
| Privileged | main process, `apps/…/fileManager/` | the `fff` index, the `ripgrep` child, the frecency store path |
| UI | `file-manager-ui` | the overlay, the row renderers, the preview router |

The registry is **renderer-side**. Its `run(ctx)` bodies drive renderer state
(navigate a tab, open a modal, start a file operation over the existing
filesystem IPC). The main process never imports the registry.

---

## 1. One overlay, three modes

### 1.1 The mode reducer

Port `reduceCommandPaletteUiState`
(`mesura/apps/web/src/components/CommandPalette.logic.ts:57-77`). It is 20
lines and has zero dependencies. Change the mode names and add one field.

```ts
/**
 * The search overlay hosts three mutually exclusive surfaces. One reducer owns
 * open/mode state so the surfaces can never stack, and so re-pressing a mode's
 * shortcut toggles that mode closed.
 */
export type SearchOverlayMode = "path" | "content" | "command";

export interface SearchOverlayState {
  readonly open: boolean;
  readonly mode: SearchOverlayMode;
  /**
   * The mode the overlay was opened in. Escape from any other mode returns
   * here instead of closing. Exactly one level deep — a mode switch never
   * pushes a stack.
   */
  readonly originMode: SearchOverlayMode;
  /** Absolute directory every mode searches. Re-rooted by the drill keys. */
  readonly searchRoot: string;
  /** The tab cwd the overlay opened at. Drill-up never passes above nothing;
   *  this is what the breadcrumb renders relative to. */
  readonly openedAtRoot: string;
}

export type SearchOverlayAction =
  | { readonly _tag: "Open"; readonly mode: SearchOverlayMode; readonly root: string }
  | { readonly _tag: "Close" }
  | { readonly _tag: "ToggleMode"; readonly mode: SearchOverlayMode; readonly root: string }
  | { readonly _tag: "SwitchMode"; readonly mode: SearchOverlayMode }
  | { readonly _tag: "Reroot"; readonly root: string };

export function reduceSearchOverlay(
  state: SearchOverlayState,
  action: SearchOverlayAction,
): SearchOverlayState {
  switch (action._tag) {
    case "Open":
      return {
        open: true,
        mode: action.mode,
        originMode: action.mode,
        searchRoot: action.root,
        openedAtRoot: action.root,
      };
    case "Close":
      return { ...state, open: false };
    case "ToggleMode":
      // Re-pressing a mode's own shortcut closes the overlay (Mesura Code's
      // ToggleMode, CommandPalette.logic.ts:66-69).
      return state.open && state.mode === action.mode
        ? { ...state, open: false }
        : {
            open: true,
            mode: action.mode,
            originMode: state.open ? state.originMode : action.mode,
            searchRoot: state.open ? state.searchRoot : action.root,
            openedAtRoot: state.open ? state.openedAtRoot : action.root,
          };
    case "SwitchMode":
      // Entered from the `>` sigil or from a palette row. The origin is kept.
      return { ...state, mode: action.mode };
    case "Reroot":
      return { ...state, searchRoot: action.root };
  }
}
```

**Why one overlay and not three dialogs.** Vision principle 4 ("One window")
and principle 6 ("Keyboard is the interface"). Three stacked dialogs are three
Escape semantics, three focus traps and three widths. Report 17 row 22 records
that Mesura Code shares one chrome across three surfaces and the file manager
shares none; that is the one clear plumbing loss to repair.

### 1.2 How a mode is entered

| Route | Lands on | Notes |
|---|---|---|
| `f` in normal mode | `path` | the existing `finder.fuzzy` registry row (`KeyRegistry.js:256-263`) |
| `Ctrl+F` in normal mode | `content` | new registry row `search.content` |
| `Ctrl+Shift+P` or `:` in normal mode | `command` | new registry rows `palette.open` and `palette.openColon`, one command, two rows — see **OPEN-1** |
| `>` as the first character of an **empty** query, in any mode | `command` | the `>` stays in the input as the mode sigil |
| Backspace that deletes the leading `>` | back to `originMode` | the sigil and the mode are one thing |
| a palette row whose `run` opens another mode | that mode | `SwitchMode`, so Escape still returns to `command` |
| re-press of the current mode's own shortcut | closed | `ToggleMode` |

**Why the `>` prefix.** VS Code and Mesura Code both use it
(`CommandPalette.logic.ts:298-299`), so the muscle memory already exists.
In Mesura Code the `>` filters the command surface to actions only. In the file
manager the command mode is already actions only, so `>` is promoted from a
filter to a mode switch. That gives a one-key route from a file search to a
command without lifting a hand off the query input, which is what principle 6
asks for.

The `>` rule applies only to an **empty** query. A `>` typed at position 3 of a
`ripgrep` pattern is a literal `>` and nothing else. Content queries treat
whitespace and punctuation as significant (`mesura/packages/contracts/src/project.ts:41-43`).

**No sigil for the content mode in v1.** See **OPEN-2**.

### 1.3 What persists and what resets

| Thing | On a mode switch | On close | On the active tab navigating |
|---|---|---|---|
| Per-mode query draft | **persists**, one draft per mode | see **OPEN-4** | reset, all three |
| Result rows of the mode being left | **dropped** | dropped | dropped |
| In-flight work of the mode being left | **cancelled** | cancelled | cancelled |
| `selectedIndex` | reset to 0 | reset to 0 | reset to 0 |
| `searchRoot` (drill state) | persists | reset to the tab cwd | reset to the tab cwd |
| Preview scroll offset | reset | reset | reset |
| `truncated`, `error`, `invalidRegex`, `matchedQuery` | reset | reset | reset |
| The content-mode option flags (case, word, regex) | **persist** | persist for the session | persist |
| Windowed row count (`visibleCount`) | reset to 100 | reset | reset |

**Why the query draft survives a mode switch but the rows do not.** Vision
principle 3 says: do not do work the user did not ask for. Making the user
retype a 40-character `ripgrep` pattern because they looked at the palette is
work the tool created. Holding a 500-row match array and a live `ripgrep` child
for a mode nobody is looking at is *also* work the user did not ask for, and it
is the expensive half. So: keep the cheap thing, drop the expensive thing, and
recompute on return. Recomputing a path search costs 10–20 ms and a content
search costs at most the 250 ms budget.

**Why everything resets when the tab navigates.** Mesura Code resets its
content dialog on a workspace change through a React `key`
(`mesura/apps/web/src/components/search/ProjectContentSearchDialog.tsx:314`).
The same reasoning applies harder here, because in a file manager the user
changes the directory constantly, and results rooted at the previous directory
are a trap rather than a convenience.

### 1.4 How the mode is shown

Three signals, no tab bar and no mouse target:

1. **A sigil chip at the left edge of the input row** — `⌕` for path, `≡` for
   content, `>` for command. In command mode the sigil is the literal `>`
   character inside the query, not a separate chip, so the input tells the truth
   about what a Backspace will do.
2. **The placeholder text** — `Find file in <basename(searchRoot)>`,
   `Search contents of <basename(searchRoot)>`, `Run a command`.
3. **The footer hint gutter** — the Enter action label changes per mode
   (`Open`, `Open at line`, `Run`). Port the gutter from
   `mesura/apps/web/src/components/CommandPaletteContent.tsx:44-71`.

**Why not a tab bar.** Vision: "The mouse is supported. It is not the design
target." A tab bar is a row of click targets that duplicates three keys already
in the registry, and it costs vertical space the preview pane wants.

### 1.5 Geometry

Keep the Qt values. They were tuned against real content and nothing in the
port invalidates them.

- Dialog width animates between **672 px** (no rows) and **1080 px** (rows),
  clamped to the window (`fm/qml/…/FuzzyFinderPopup.qml:76-77`).
- The preview pane is **fixed at 360 px** — `flex: 0 0 360px`, not a
  preferred width. The Qt comment records why a preferred width alone is wrong:
  a wide preview starves the result list
  (`fm/qml/…/FuzzyFinderPopup.qml:240-246`). See **OPEN-7**.
- In command mode the preview pane is absent, so the dialog stays at 672 px.

---

## 2. The result row contract

### 2.1 A tagged union, and why one type would be dishonest

One type cannot carry all three modes truthfully. Three concrete reasons:

1. **`matchRanges` annotate three different strings.** In path mode the ranges
   index into `relativePath`. In content mode they index into `lineContent`. In
   command mode they index into the label. One field named `matchRanges` would
   not say which string it refers to, and the renderer would guess.
2. **`absolutePath` is a lie for a command row.** A command has no file. An
   optional `absolutePath?: string` pushes the check into every consumer.
3. **`lineNumber` is meaningless outside content mode**, and a `lineNumber: 0`
   sentinel is the kind of value that reaches a UI and renders as `0`.

So: a shared base for what the row renderer and the keyboard model genuinely
need, and one variant per mode.

### 2.2 The types

```ts
// packages/file-manager-core/src/search/rowTypes.ts

/**
 * A half-open span [start, end) over UTF-16 string indices of the field named
 * by the property that carries it. NEVER byte offsets — the conversion from
 * ripgrep's byte offsets happens in the main process (§6.4), so no renderer
 * ever sees a byte offset.
 */
export interface MatchRange {
  readonly start: number;
  readonly end: number;
}

/** Git porcelain status character, normalized in the main process. */
export type GitStatusChar = "M" | "T" | "A" | "D" | "R" | "C" | "?" | "U" | "!";

/** What the row renderer needs, whatever the mode. */
export interface SearchRowBase {
  /** Stable across a re-render of the same result set. Used as the React key
   *  and as the argument of every keyboard action. */
  readonly key: string;
  /** Primary line. Path mode: the file name. Content mode: the file name.
   *  Command mode: the command label. */
  readonly title: string;
  /** Secondary line, dimmed. Path mode: the parent path. Content mode: the
   *  parent path. Command mode: the description, or "". */
  readonly subtitle: string;
  /** Resolved icon reference (D8 — the curated Pierre/lucide set). */
  readonly icon: IconRef;
}

export interface PathSearchRow extends SearchRowBase {
  readonly kind: "path";
  readonly absolutePath: string;
  /** Relative to searchRoot. Directories carry NO trailing slash — the slash
   *  fff appends is stripped once, in the main process, together with the
   *  matching fix-up of the name split. This kills defect 4 of 12-synthesis. */
  readonly relativePath: string;
  readonly isDirectory: boolean;
  /** Ranges over `relativePath`, one absolute set, split for display at
   *  `relativePath.length - title.length` — the Qt approach
   *  (fm/qml/…/FuzzyFinderResultDelegate.qml:48-49), which is cheaper than
   *  Mesura Code's two independent sets. */
  readonly pathRanges: readonly MatchRange[];
  readonly gitStatus: GitStatusChar | null;
  readonly sizeBytes: number | null;
  readonly modifiedMs: number | null;
  readonly isBinary: boolean;
}

export interface ContentSearchRow extends SearchRowBase {
  readonly kind: "content";
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly lineNumber: number;
  /** The matched line, trailing newline already stripped. May be truncated —
   *  see `lineTruncatedAt`. */
  readonly lineContent: string;
  /** Ranges over `lineContent`. The field name and the four-field shape are
   *  the swappable-backend contract from D10; do not add engine-specific
   *  fields to this variant. */
  readonly matchRanges: readonly MatchRange[];
  /** Non-null when the main process truncated a very long line (§6.5). The
   *  value is the string index the original line was cut at. */
  readonly lineTruncatedAt: number | null;
  readonly gitStatus: GitStatusChar | null;
}

export interface CommandRow extends SearchRowBase {
  readonly kind: "command";
  /** The registry `id`, e.g. "finder.fuzzy". Namespaced already. */
  readonly commandId: string;
  /** Live keycap string, e.g. "⌃e". Null when the command has no binding in
   *  the active view. */
  readonly keycap: string | null;
  /** One of KeyRegistry.HELP_GROUPS (KeyRegistry.js:455-456). */
  readonly group: string;
  /** False renders the row greyed and blocks Enter. Computed by the row's
   *  `enabled(ctx)` — NOT by its `when(ctx)`. See §5.4. */
  readonly enabled: boolean;
  /** The overlay stays open after `run()` resolves. Ported from Mesura Code's
   *  CommandPaletteActionItem.keepOpen (CommandPalette.logic.ts:104). */
  readonly keepOpen: boolean;
  /** Ranges over `title`. */
  readonly labelRanges: readonly MatchRange[];
}

export type SearchRow = PathSearchRow | ContentSearchRow | CommandRow;
```

### 2.3 The envelope — where `truncated` and `matchedQuery` belong

`truncated` and `matchedQuery` describe the **result set**, not a row. Putting
them on a row would repeat one boolean 200 times and invite a consumer to read
it off the wrong row. They go on an envelope.

```ts
export type SearchPhase =
  /** No query and no request in flight. */
  | "idle"
  /** The fff index for this root is still scanning. Path mode only. */
  | "indexing"
  /** A request is in flight, or a newer query is still debouncing. */
  | "searching"
  /** `rows` are final for `matchedQuery`. */
  | "ready";

export interface SearchPage<TRow extends SearchRow> {
  readonly mode: SearchOverlayMode;
  readonly rows: readonly TRow[];
  /**
   * The exact query string `rows` were computed for. The renderer highlights
   * against THIS, never against the live input. Adopted correction 1 of D10:
   * highlighting half-typed input is a real class of visual bug
   * (Mesura Code reports it as `searchedQuery`, queries.ts:294).
   */
  readonly matchedQuery: string;
  /** More results exist than the cap returned. Path mode computes it by
   *  asking fff for `limit + 1` (WorkspaceSearchIndex.ts:173). Content mode
   *  sets it when the cap or the time budget stopped the child (§6.3). */
  readonly truncated: boolean;
  /** Distinct files in `rows`. Content mode only; 0 elsewhere. */
  readonly fileCount: number;
  readonly phase: SearchPhase;
  /** Human-readable failure, already localized. Null on success. */
  readonly error: string | null;
  /** The pattern did not compile. Content mode only. Renders as
   *  "Invalid regular expression". */
  readonly invalidRegex: boolean;
  /** Monotonic per mode. The renderer drops any page whose id is lower than
   *  the highest already applied. */
  readonly requestId: number;
}
```

**Two states, not one boolean.** Report 17 row 21 records that Mesura Code
distinguishes `"Indexing workspace files…"` from `"Searching workspace files…"`
and the file manager shows only `"Scanning…"` (`fm/qml/…/FuzzyFinderPopup.qml:197-203`).
`SearchPhase` carries that distinction as one field rather than two booleans,
so an impossible pair cannot be represented.

**`gitStatus` is normalized in the main process, never passed through raw.**
`12-synthesis.md:57` records the live defect: `fff` emits English words
(`modified`), the Qt badge switch expects porcelain characters, so every file
falls to the `default` branch. The main process maps `fff`'s word to a
`GitStatusChar` before the row crosses the IPC boundary. The renderer's badge
component receives an already-valid character or `null`.

---

## 3. The preview pane

This is the file manager's one decisive advantage. Report 17 row 12 states it
plainly: Mesura Code has no equivalent in any search surface.

### 3.1 Which modes show it

| Mode | Preview | Reason |
|---|---|---|
| `path` | **yes** | the existing behaviour, and the reason the finder is a browse-and-inspect surface rather than a jump-to-file |
| `content` | **yes**, opened at the matched line | a grep hit without context is a line number; with context it is an answer |
| `command` | **no** | a command has no file. The pane collapses and the dialog narrows to 672 px |

### 3.2 The two-stage debounce, unchanged

Keep the file manager's own invention (report 17 row 3, and D10 adopts it
explicitly as correction 6):

| Stage | Delay | What it gates |
|---|---|---|
| 1 | **100 ms** after the last keystroke | the search request itself (`fm/qml/…/FuzzyFinderPopup.qml:350-358`) |
| 2 | **150 ms** after the highlighted row changes | the preview request (`fm/qml/…/FuzzyFinderInfoPanel.qml:27-33`) |

The two timers are independent. Holding `j` moves the highlight without issuing
a single preview read; the preview lands 150 ms after the key is released. The
cheap operation runs at the fast interval, the expensive one at the slow
interval. Mesura Code debounces once, at 120 ms, on the whole target
(`mesura/apps/web/src/state/queries.ts:34,242`), and has no second stage
because it has nothing expensive to gate.

### 3.3 What a content hit shows

The same shared router, driven by one extra field.

```ts
export interface PreviewRequest {
  readonly absolutePath: string;
  /** 1-based. The preview scrolls so this line is centred, and paints a
   *  persistent band behind it. Ignored by every non-text preview type. */
  readonly revealLine?: number;
  /** Ranges over the revealed line, inverted on top of the syntax colours.
   *  Empty for a path-mode preview. */
  readonly highlightRanges?: readonly MatchRange[];
}
```

Behaviour per row kind:

- **`content` row** — `{ absolutePath, revealLine: row.lineNumber,
  highlightRanges: row.matchRanges }`. The text preview scrolls the line to the
  vertical centre. `ripgrep` skips binary files by default, so a content row is
  always a text preview in practice; the other preview types accept and ignore
  `revealLine` rather than special-casing.
- **`path` row, file** — `{ absolutePath }`. Whatever type the router picks.
- **`path` row, directory** — `{ absolutePath }`. The router lists the
  directory, exactly as it does today
  (`fm/qml/…/PreviewContent.qml:130-195`).

**Overlaying match ranges on syntax-highlighted tokens is a solved problem, and
the solution gets copied.** `normalizeRanges` and `splitToken`
(`mesura/apps/web/src/components/search/HighlightedSearchLine.tsx:29,52`) merge
overlapping ranges and split every highlighter token at the range boundaries, so
a match can straddle two token colours. Report 17 §D.3 lists them as
copy-verbatim logic. The file manager needs them in two places: the result row
and the previewed line.

### 3.4 How it reuses the shared router

The rule from `CLAUDE.md` survives the port: **`PreviewContent` is the single
file-preview router, and a consumer never re-implements type routing.** The
React shape is one component with one prop object.

```tsx
<PreviewRouter request={previewRequest} />
```

Two consumers mount it: the Miller pane and the overlay's preview pane. A new
preview type added to the router appears in both without touching either
consumer. The overlay's pane adds only the wrapper: the fixed 360 px width, the
metadata grid above it, and the scroll forwarding below.

The metadata grid stays what the Qt panel shows — **Size**, **Type**, **Git**,
**Modified** (`fm/qml/…/FuzzyFinderInfoPanel.qml:70-125`) — because those four
are the fields report 17 row 11 records the file manager keeping and Mesura Code
discarding. For a `content` row the grid gains a fifth cell, **Line**, showing
`lineNumber`.

### 3.5 Preview-scroll keys — the gap neither product has

Report 17 row 19: the Qt info pane installs no key handler at all
(`fm/qml/…/FuzzyFinderInfoPanel.qml:138-142`), so the preview cannot be
scrolled and `Ctrl+R` cannot be reached there
(`fm/qml/…/PreviewContent.qml:41-43`).

Specification:

| Key | Effect |
|---|---|
| `Ctrl+D` | preview half page down |
| `Ctrl+U` | preview half page up |

**Why `Ctrl+D`/`Ctrl+U` and not `PageDown`/`PageUp`.** In normal mode those two
keys half-page the file list (`KeyRegistry.js:169-184`). The vim meaning is "half
a page of the thing you are reading". Inside the overlay the list already has
four navigation keys (`↑`, `↓`, `Ctrl+K`, `Ctrl+J`) plus `PageUp`/`PageDown`
and `Home`/`End` (§4), so the thing the user is reading with `Ctrl+D` is the
preview. The meaning of the key is preserved; only its target moves.

**The preview never takes DOM focus.** The query input keeps focus for the whole
life of the overlay. The overlay's key handler calls an imperative handle on the
preview:

```ts
export interface PreviewScrollHandle {
  scrollByPages(fraction: number): void; // 0.5 / -0.5 for half pages
  resetScroll(): void;                   // called when the highlighted row changes
}
```

**Why focus must not move.** A focusable preview creates a mode where typing
does nothing until the user presses a key to get back. That is a mouse-shaped
design, and vision principle 6 rejects it. It is also why the Qt panel has no
handler today: there was no way to install one without a focus scope.

---

## 4. The keyboard model

### 4.1 Precedence against the existing cascade

The overlay is a **modal**. It enters the cascade at the top, at the position
the fuzzy finder already occupies.

The Qt cascade, in order (`fm/qml/…/FileList.qml:373-402`):

1. **modal open → swallow everything** (`:374-378`)
2. bookmark sub-mode
3. chord RESOLUTION
4. flash navigation
5. `KeyRegistry.dispatch` — which itself runs bare-modifier → picker pre-pass →
   binding scan (`KeyRegistry.js:574-587`)

The overlay sits at step 1. While it is open, **no key reaches steps 2 to 5**,
and the overlay's own table below is the complete keyboard. This is exactly
today's behaviour for `modalFuzzyFinder`
(`fm/qml/Symmetria/FileManager/UI/services/WindowState.qml:308`), so nothing in
the cascade changes.

**Three rules the port must not break:**

1. **Chord resolution stays in the cascade, before `dispatch`.** `CLAUDE.md`
   marks this load-bearing, and the code comment gives the failure
   (`fm/qml/…/FileList.qml:386-388`): moving it into the registry lets the
   picker pre-pass suppress `d` before the `g`+`d` chord can resolve.
2. **A binding whose `when()` is false does NOT consume its key.** It falls
   through (`KeyRegistry.js:573-576`). §5.4 explains why the palette must not
   reuse this.
3. **Miller swallows a stray Escape; the tree does not.** `miller.escapeSwallow`
   exists for that (`KeyRegistry.js:319-321`), and the tree deliberately lets
   Escape propagate to the host's close handling. The overlay's Escape never
   reaches either, because it never leaves step 1.

### 4.2 The Escape stack inside the overlay

Last entered, first exited:

1. a non-empty **content-mode option pop-over**, if one is ever added — not in
   v1 (§8)
2. the **`>` sigil**, removed by Backspace rather than Escape — the sigil is a
   character, and deleting a character is Backspace's job
3. **a switched mode** → return to `originMode` (§1.1). See **OPEN-3**
4. **the overlay** → close, restore focus to the view that opened it

Escape never clears the query. Neither product does that, and the file manager's
own `/`-search does not either, so the behaviour is already learned.

### 4.3 Keys shared by all three modes

| Key | Action | Notes |
|---|---|---|
| `↓`, `Ctrl+J` | next row | `Ctrl+J`/`Ctrl+K` are the file manager's own pair (`fm/qml/…/FuzzyFinderPopup.qml:167-178`); Mesura Code lacks them (report 17 row 18) |
| `↑`, `Ctrl+K` | previous row | |
| `PageDown` | forward one visible page of rows | new — report 17 records both products lack it |
| `PageUp` | back one visible page of rows | new |
| `Home` | first row | new |
| `End` | last row | new |
| `Enter` | confirm the highlighted row | **blocked while a newer query is in flight** — §4.7 |
| `Escape` | §4.2 | |
| `Ctrl+D` | preview half page down | no effect in command mode |
| `Ctrl+U` | preview half page up | no effect in command mode |
| `>` on an empty query | switch to command mode | §1.2 |
| `Ctrl+F` | toggle to content mode | `ToggleMode`, so a second press closes |
| `Ctrl+Shift+P` | toggle to command mode | `ToggleMode` |
| every other key | inserted into the query | the input keeps focus for the whole life of the overlay |

Navigation does **not** wrap. Mesura Code's content dialog wraps
(`ProjectContentSearchDialog.tsx:196-201`) and its picker does not. Wrapping
inside a 500-row list turns one extra `Ctrl+J` into a jump to the far end, which
is worse than a no-op.

### 4.4 Path mode

| Key | Action | Notes |
|---|---|---|
| `Enter` | file: navigate to the parent directory and focus the file. Directory: navigate into it | the existing confirm (`fm/qml/…/FuzzyFinderPopup.qml:311-326`) |
| `Tab`, `→` | **drill in**: re-root `searchRoot` at the highlighted directory, clear the query, keep the overlay open | the gap report 17 row 15 records on both sides |
| `Shift+Tab`, `←` | **drill up**: re-root at `parentDir(searchRoot)`, clear the query | |
| `Backspace` on an empty query | drill up | Mesura Code's submenu-pop precedent (`CommandPalette.tsx:2194-2197`) |
| `Shift+Enter` | confirm, and copy the path to the clipboard first | mirrors `miller.shiftEnter` (`KeyRegistry.js:303-315`) |

**Why drill and confirm are different keys.** Confirming a directory closes the
overlay and moves the pane — that is a navigation, and the user asked for it.
Drilling keeps the overlay open and narrows the search — that is a refinement.
Collapsing them onto Enter would make it impossible to search inside a
subdirectory without leaving and re-entering the finder, which is the actual
complaint behind report 17 row 15.

**Drill re-roots the engine, not a filter.** Re-rooting calls the main process
to acquire the index for the new root (§7). Because the index map is keyed by
directory with an idle timeout (adopted correction 4), drilling into and back
out of a directory hits a warm index the second time.

**The ranking record is written on confirm, never on drill.** `recordOpen`
fires with the absolute path and the query that produced the row (see
`FuzzyFinder::recordOpen` and its QML call site). A drill is not an open, so it
teaches nothing.

⚠ It writes fff's **query tracker**, not frecency. This document said frecency;
that was wrong. The record is keyed on the index root plus the query, so the
learning is per-`(root, query)` and is not shared with a host indexing a
different root. See `20-spike-search-topology.md` §2.1.

### 4.5 Content mode

| Key | Action | Notes |
|---|---|---|
| `Enter` | open the file at `lineNumber`, close the overlay | |
| `Alt+C` | toggle case sensitivity | `--case-sensitive` vs `--smart-case` |
| `Alt+W` | toggle whole word | `--word-regexp` |
| `Alt+R` | toggle regular expression | drops `--fixed-strings` |
| `Ctrl+]` | next file group | jump the highlight to the first row of the next path group |
| `Ctrl+[` | previous file group | |

**Why the option toggles are keys and not the three buttons Mesura Code draws**
(`ProjectContentSearchDialog.tsx:167-190`). Vision principle 6. The three flags
also render as three lit sigils in the footer gutter, so their state is visible
without a mouse target.

`Alt` is free: no registry row uses it (`KeyRegistry.js:471-480` declares the
`"Alt"` mask, and no binding claims it).

### 4.6 Command mode

| Key | Action | Notes |
|---|---|---|
| `Enter` | run the highlighted command; close unless `keepOpen` | a rejected `run()` raises a toast and never closes — ported from `CommandPalette.tsx:2213-2222` |
| `Enter` on a disabled row | no-op | `enabled === false` |
| `Backspace` deleting the leading `>` | return to `originMode` | §1.2 |

### 4.7 Blocking Enter while a newer query is in flight

Adopted correction 6 of D10. The predicate:

```ts
const canConfirm =
  page.phase === "ready" &&
  page.matchedQuery === liveQuery &&
  page.requestId === highestAppliedRequestId;
```

Mesura Code applies this to content search only (`canOpenMatches`,
`ProjectContentSearchDialog.tsx:122`, with the reasoning at `:203-205`: the
visible matches belong to the previous query, so opening one jumps to a result
the user did not ask for). **This specification applies it to path mode too.**
The bug class is identical, and the file manager has escaped it so far only
because its search is in-process. Over IPC it is no longer in-process.

Command mode has no in-flight state — filtering is a pure function over an
array already in the renderer — so `canConfirm` is always true there.

The blocked state is visible: the footer's Enter hint dims, and the status line
reads `Searching…`. A blocked Enter must never look like a broken keyboard.

---

## 5. Feeding the palette from the keybinding registry

### 5.1 What already works and needs nothing

- **One array, several consumers** is proven. `HelpPopup.qml` already reads
  `HELP_GROUPS`, `bindingsFor(kind)`, `MODES` and `isSuppressedInPicker`. The
  palette is the third consumer of the same array.
- **`id`, `label`, `icon`, `group`, `keycap` map one-to-one** onto Mesura
  Code's `value`, `title`, `icon`, group label and shortcut label
  (report 17 §C.2).
- **View scoping** by `CORE` / `MILLER_ONLY` / `TREE_ONLY` through
  `bindingsFor(viewKind)` (`KeyRegistry.js:445-447`) is better than Mesura
  Code's `if`-guarded pushes, and the palette reuses it verbatim: the palette
  lists the active view's bindings, not both views'.
- **Picker suppression** through `isSuppressedInPicker`
  (`KeyRegistry.js:547-568`) is reused unchanged, so the palette never
  advertises a key the picker pre-pass eats.
- **A test already fails an incomplete row** (`fm/plugin/tests/tst_keyregistry.qml`).
  Extend it; do not regress to Mesura Code's imperative 170-line push block
  (`CommandPalette.tsx:1489-1639`).

### 5.2 The changed row shape

Three additions, exactly the three D10 named, plus `keepOpen` which is a
one-word copy from Mesura Code and not a structural change.

```ts
// packages/file-manager-core/src/keys/registry.ts

export type ModSpec = "" | "Ctrl" | "Shift" | "Alt" | "Ctrl+Shift" | "*";

/**
 * Everything a command needs that does NOT depend on a mounted view. The
 * palette builds this from anywhere: a global shortcut, a menu, an IPC
 * command, a test.
 */
export interface CommandContext {
  readonly windowState: WindowState;
  readonly viewKind: "miller" | "tree";
  readonly services: {
    readonly fileManager: FileManagerService;
    readonly config: ConfigService;
    readonly paths: PathUtils;
  };
}

/**
 * The view-divergent capabilities. The focused view publishes this into the
 * window store on mount; `getDispatchContext()` reads it back. In the
 * standalone one view is always mounted (D3: one window, tabs), so this is
 * always available. The windowState-less embedded tree path bypasses the
 * registry entirely and therefore has no palette — see §8.
 */
export interface ViewAdapter {
  readonly root: ViewRoot;
  readonly view: ListHandle;
  readonly pasteProcess: ProcessRunner;
  readonly clipboardCopyProcess: ProcessRunner;
  activateCurrent(): void;
  halfPageCount(): number;
  nav(fn: () => void): void;
  invalidateFlashCache(): void;
}

export type DispatchContext = CommandContext & ViewAdapter;

export interface KeyBinding {
  readonly id: string;
  readonly keys: readonly KeyName[];
  readonly mods: ModSpec;
  readonly keycap: string;
  readonly label: string;
  readonly icon: IconName;
  readonly group: HelpGroup;

  /**
   * NEW — curated synonyms for the palette's substring matcher. REQUIRED.
   * searchTerms[0] MUST be `label`, because the rank formula weights earlier
   * terms higher (§5.3). The test fails a row that omits the field, that
   * repeats a term, or whose first term is not the label.
   */
  readonly searchTerms: readonly string[];

  /**
   * UNCHANGED — the EXECUTION gate. False means "not consumed": the key falls
   * through to the next handler. Read §5.4 before touching this.
   */
  readonly when?: (ctx: DispatchContext) => boolean;

  /**
   * NEW — the DISPLAY gate, for the palette only. False renders the row
   * greyed and blocks Enter; the row is never hidden. Must be cheap and pure:
   * it runs for every row on every keystroke of the palette query. Absent
   * means always enabled.
   */
  readonly enabled?: (ctx: CommandContext) => boolean;

  /** NEW — the overlay stays open after run() resolves. Default false. */
  readonly keepOpen?: boolean;

  readonly run: (ctx: DispatchContext) => void | Promise<void>;
}
```

**Nothing else changes.** `matchKey`, `matchBinding`, `_pickerPrePass` and
`dispatch` (`KeyRegistry.js:487-587`) port line for line. The palette calls
neither `matchBinding` nor `dispatch`; it calls `run(ctx)` directly, because the
user chose the row rather than pressing a key.

### 5.3 The palette pipeline

1. `rows = bindingsFor(ctx.viewKind)`
2. drop rows where `isSuppressedInPicker(row, services.fileManager)` is true
3. drop rows whose `group === "Chords"` — a chord prefix is not a command.
   Instead, flatten `windowState.chordBindings` into ordinary rows with ids like
   `chord.g.d`, exactly as `HelpPopup.qml` already renders them
4. map each to a `CommandRow`, computing `enabled` and the live `keycap`
5. filter and rank with Mesura Code's formula
   (`CommandPalette.logic.ts:258-289`), copied as-is:
   - normalize: lowercase, trim, collapse whitespace runs (`:141`)
   - keep a row when `searchTerms.join(" ")` **contains** the normalized query
   - `rank = 1000 - fieldIndex * 100 + fieldRank`, where `fieldRank` is 3 for an
     exact field match, 2 for a prefix, 1 for containment
   - ties break by declaration order
6. group by `group`, ordered by `HELP_GROUPS` (`KeyRegistry.js:455-456`)

**Substring matching, not fuzzy matching.** Report 17 §C.3 is explicit: over a
60-item list a fuzzy matcher adds noise. The intelligence comes from the curated
`searchTerms`, not from the algorithm.

### 5.4 Why `when()` must not be reused for display

**The semantics are load-bearing, and they are the opposite of what a palette
needs.**

In the registry, a false `when()` means *"do not consume this key; let it fall
through to the next handler"*. The header states it
(`KeyRegistry.js:59-63`), the dispatcher implements it
(`KeyRegistry.js:573-586`: a non-matching binding returns `false`, so
`event.accepted` is never set), and two shipped behaviours depend on it:

- **`n` and `N` fall through.** Both rows carry
  `when: !searchActive && matchIndices.length > 0` (`KeyRegistry.js:241-248`).
  With no active search, `n` must reach nothing and do nothing — not be eaten.
- **Escape propagates out of the tree.** The tree deliberately has no
  Escape-swallowing row, so Escape reaches the host's close handling.
  `miller.escapeSwallow` (`KeyRegistry.js:319-321`) exists precisely because
  Miller wants the opposite, which proves the fall-through is a designed
  behaviour rather than an accident.

A palette asks a different question: *"should this row be shown, and should it be
runnable right now?"* The two questions differ in three ways that cannot be
reconciled in one field.

1. **A row can be legitimately unbound but runnable.** `enabled` is about the
   command; `when` is about the key.
2. **A false `when()` must still appear in the help.** The header says so
   (`KeyRegistry.js:62-63`). Reusing `when()` for display would silently make
   the cheat-sheet lie about half the registry.
3. **They run at different rates against different contexts.** `when()` runs
   once per key press against a `DispatchContext`. `enabled()` runs for every
   row on every keystroke of the palette query, against a `CommandContext`, so
   it must be cheap and free of side effects.

**The concrete regression that follows from merging them.** Suppose the palette
reused `when()`. An author who wants `match.next` visible in the palette while
no search is active would loosen its `when()` to `true`. That single edit makes
bare `n` **consume** the key in normal mode instead of falling through — and the
loss is silent, because nothing else is bound to `n`. The `when()` field is a
dispatch decision that happens to look like a predicate about availability. The
two must stay apart.

Mesura Code has exactly this split and it is worth recording as independent
confirmation: `when` gates *keybindings*
(`mesura/packages/contracts/src/keybindings.ts:143-170`), `disabled` gates
*palette rows* (`mesura/apps/web/src/components/CommandPalette.tsx:1578`), and
they are separate mechanisms that never read each other.

### 5.5 Three worked examples

**(a) `finder.fuzzy` — the minimal migration.** Only `searchTerms` is added.

Before (`KeyRegistry.js:256-263`):

```js
{ id: "finder.fuzzy", keys: [Qt.Key_F], mods: "", keycap: "f",
  label: "Fuzzy finder", icon: "manage_search", group: "Search & jump",
  run: function(ctx) {
      if (ctx.viewKind === "miller")
          ctx.windowState.saveCursor(ctx.windowState.currentPath, ctx.view.currentIndex);
      ctx.windowState.requestFuzzyFinder();
  } }
```

After:

```ts
{
  id: "finder.fuzzy",
  keys: ["f"],
  mods: "",
  keycap: "f",
  label: "Fuzzy finder",
  icon: "manage_search",
  group: "Search & jump",
  searchTerms: ["Fuzzy finder", "find file", "goto file", "quick open", "search files", "fzf"],
  run: (ctx) => {
    if (ctx.viewKind === "miller") {
      ctx.windowState.saveCursor(ctx.windowState.currentPath, ctx.view.currentIndex);
    }
    ctx.windowState.requestFuzzyFinder();
  },
}
```

**Non-obvious consequence.** Running this row *from the palette* must not open
a second overlay on top of the first. `requestFuzzyFinder()` therefore
dispatches `{ _tag: "SwitchMode", mode: "path" }` when the overlay is already
open, and `{ _tag: "Open", … }` when it is not. The reducer in §1.1 already
expresses both; the row body does not need to know which one ran.

**(b) `match.next` — the `when` / `enabled` split, on one predicate.**

Before (`KeyRegistry.js:241-244`):

```js
{ id: "match.next", keys: [Qt.Key_N], mods: "", keycap: "n",
  label: "Next match", icon: "arrow_downward", group: "Search & jump",
  when: function(ctx) { return !ctx.windowState.searchActive && ctx.windowState.matchIndices.length > 0; },
  run: function(ctx) { ctx.windowState.nextMatch(); } }
```

After:

```ts
{
  id: "match.next",
  keys: ["n"],
  mods: "",
  keycap: "n",
  label: "Next match",
  icon: "arrow_downward",
  group: "Search & jump",
  searchTerms: ["Next match", "next search result", "find next", "n"],
  // EXECUTION gate — false means the key falls through, which is what keeps
  // bare `n` from being swallowed when no search is active. Do not widen this
  // to make the palette row runnable; add `enabled` instead.
  when: (ctx) =>
    !ctx.windowState.searchActive && ctx.windowState.matchIndices.length > 0,
  // DISPLAY gate — same predicate today, different reason and different
  // context type. The row stays visible and greys out; it never disappears.
  enabled: (ctx) => ctx.windowState.matchIndices.length > 0,
  run: (ctx) => ctx.windowState.nextMatch(),
}
```

The two predicates are deliberately **not** identical: `when` also requires
`!searchActive`, because while the incremental search input is open the key
belongs to that input. `enabled` drops that clause, because opening the palette
already closed the search input. One field could not have expressed both.

**(c) `miller.toggleHidden` — a symbol key, and `keepOpen`.**

Before (`KeyRegistry.js:345-347`):

```js
{ id: "miller.toggleHidden", keys: [Qt.Key_Period], mods: "*", keycap: ".",
  label: "Toggle hidden files", icon: "visibility", group: "View",
  run: function(ctx) { ctx.services.config.fileManager.showHidden = !ctx.services.config.fileManager.showHidden; ctx.services.config.save(); } }
```

After:

```ts
{
  id: "miller.toggleHidden",
  keys: ["."],
  // mods "*" is preserved verbatim. On the Spanish Latin-American layout the
  // modifiers that PRODUCE a glyph are layout-dependent, so a strict "" match
  // silently drops the key. See the header rule at KeyRegistry.js:65-76.
  mods: "*",
  keycap: ".",
  label: "Toggle hidden files",
  icon: "visibility",
  group: "View",
  searchTerms: ["Toggle hidden files", "show hidden", "dotfiles", "hidden", "show dot files"],
  // The overlay stays open: toggling hidden files is a setting the user often
  // flips twice, and closing the palette to flip it back is a wasted round trip.
  keepOpen: true,
  run: (ctx) => {
    ctx.services.config.fileManager.showHidden = !ctx.services.config.fileManager.showHidden;
    ctx.services.config.save();
  },
}
```

### 5.6 Tests to extend

`tst_keyregistry` already fails a row that lacks help metadata, uses an
unrenderable `group`, or collides with another unconditional row on the same
key and modifiers. Add four assertions:

1. every row declares a non-empty `searchTerms`;
2. `searchTerms[0] === label`;
3. no two rows in one view share a normalized `searchTerms[0]`;
4. `enabled`, when present, is a function of arity 1 and does not touch a
   `ViewAdapter` member — enforced by calling it with a `CommandContext` proxy
   that throws on any unexpected property read.

Assertion 4 is the mechanical guard for §5.4. It fails the exact mistake an
author makes when they copy a `when()` body into `enabled`.

---

## 6. The `ripgrep` invocation

### 6.1 The argv

Built as an array, never as a shell string. No shell is spawned.

```ts
function buildRipgrepArgv(req: ContentSearchRequest): string[] {
  const argv = [
    "--json",
    "--line-number",
    "--no-heading",
    "--color", "never",
    "--no-messages",
    "--max-count", String(MAX_MATCHES_PER_FILE),   // 100
    "--max-filesize", "10M",
    "--engine", "auto",                            // see OPEN-5
  ];

  if (req.caseSensitive) argv.push("--case-sensitive");
  else argv.push("--smart-case");

  if (req.wholeWord) argv.push("--word-regexp");
  if (!req.useRegex) argv.push("--fixed-strings");
  if (req.includeHidden) argv.push("--hidden");
  if (req.includeIgnored) argv.push("--no-ignore-vcs");
  for (const glob of req.globs) argv.push("--glob", glob);

  // `--regexp` (not a positional) so a pattern beginning with `-` is never
  // read as a flag. `--` so a searchRoot beginning with `-` is never read as
  // one either.
  argv.push("--regexp", req.query);
  argv.push("--", req.searchRoot);
  return argv;
}
```

Flag notes, each verified against `ripgrep 15.2.0` on this machine:

- **`--max-count` is per file**, and it is the whole of the
  `maxMatchesPerFile` requirement. Mesura Code enforces its cap in JavaScript
  (`CONTENT_SEARCH_MAX_MATCHES_PER_FILE`, `WorkspaceSearchIndex.ts:34`);
  `ripgrep` enforces it in the engine, so no JavaScript runs at all for the
  discarded matches.
- **`--word-regexp` implements the correct whole-word rule.** Report 17 §B.1
  documents Mesura Code's `isWholeWordRange` post-filter and the trap it avoids
  (a consuming `(?:^|\W)` boundary swallows the separator between adjacent
  matches and widens the reported ranges). `ripgrep` does not have that
  problem, so **do not port `isWholeWordRange`** unless the backend is ever
  swapped back to `fff`.
- **`--smart-case` replaces `buildContentSearchQuery`'s lowercase/`(?i)` split**
  (`WorkspaceSearchIndex.ts:233-246`). `ripgrep` applies smart case to both
  literal and regex patterns, so the two-branch helper is not needed.
- **`--no-messages` suppresses per-file permission errors on stderr**, which
  otherwise flood a search rooted at `/` or `~`. Real failures (a pattern that
  does not compile, a missing root) still print and still exit 2.
- **`--sort` is deliberately absent.** It disables parallelism. Ordering is
  handled in §6.6.
- **`--max-columns` is deliberately absent.** Measured on this machine: in
  `--json` mode `-M` has **no effect** — a 607-character line is emitted in
  full with `-M 100 --max-columns-preview`. The long-line guard therefore runs
  in JavaScript (§6.5). This is not documented anywhere and it is the kind of
  thing an implementer will otherwise discover through a UI stall.

### 6.2 Parsing the JSON stream

`--json` emits **one JSON object per line**, newline-delimited. Never
`JSON.parse` the whole output; split on `\n` and parse each line.

Object types, in the order they appear per file: `begin`, then zero or more
`match` (and `context`, which is never requested), then `end`. A final `summary`
object closes the run.

```ts
// Measured shape, ripgrep 15.2.0.
type RgLine =
  | { type: "begin"; data: { path: RgText } }
  | { type: "match"; data: {
        path: RgText;
        lines: RgText;                 // includes the trailing "\n"
        line_number: number;           // 1-based
        absolute_offset: number;
        submatches: Array<{ match: RgText; start: number; end: number }>;  // BYTE offsets
      } }
  | { type: "end"; data: { path: RgText; binary_offset: number | null; stats: RgStats } }
  | { type: "summary"; data: { elapsed_total: RgDuration; stats: RgStats } };

/** ripgrep emits `text` for valid UTF-8 and `bytes` (base64) otherwise. */
type RgText = { text: string } | { bytes: string };
```

Only `match` produces rows. `begin` opens a group. `end` closes it and gives the
per-file match count for the sticky header.

**The `bytes` variant is real and must be handled.** Measured: a Latin-1 line
came back as `{"bytes":"Y2Fm6SBuZWVkbGUgbGF0aW4xCg=="}`. Decode it with
`Buffer.from(value.bytes, "base64")` and continue with the same conversion as
§6.4. A path that arrives as `bytes` is **skipped** in v1, with the reason in §8.

### 6.3 Enforcing the 250 ms budget and the caps against a stream

`ripgrep` has no cursor to page and no time budget flag. That is a
simplification, not a loss: killing a child is simpler than Mesura Code's
`do…while` cursor loop (`WorkspaceSearchIndex.ts:473-522`), which exists only
because the `fff` cursor advances by *file* and a whole page can come back empty
after post-filtering.

```
on request:
  requestId := ++counter
  kill any previous child with SIGTERM, detach its handlers
  child := spawn("rg", argv, { stdio: ["ignore", "pipe", "pipe"] })
  budgetTimer  := setTimeout(250 ms)   -> softStop("budget")
  matches      := 0

  on each parsed `match` line:
      if requestId is stale: return                    // late line from a dead child
      push a row
      matches += 1
      if matches >= 500: softStop("cap")

  softStop(reason):
      truncated := true
      child.kill("SIGTERM")
      killTimer := setTimeout(250 ms) -> child.kill("SIGKILL")

  on child exit(code, signal):
      clear both timers
      flush the pending batch
      phase := "ready"
      if signal is set:            // we killed it; not an error
          error := null
      else if code === 0 or code === 1:
          error := null            // 1 means "no matches", which is a valid answer
      else:                        // code 2
          if stderr matches /regex parse error/: invalidRegex := true
          else: error := first non-empty stderr line
```

Verified exit codes on this machine: `0` with matches, `1` with none, `2` on a
pattern that does not compile (`rg: regex parse error: … unclosed group`).

**A killed child must never surface as an error.** Node reports a signalled exit
as `code === null, signal === "SIGTERM"`. Reading only `code` would render
`null` as a failure and hide 500 perfectly good rows behind an error banner.

**Streaming beats Mesura Code's single-shot RPC, and that is the point.** Rows
are pushed to the renderer in batches — every **32 matches** or every **40 ms**,
whichever comes first. The first rows paint long before the budget expires. An
indexed backend cannot do this, because it returns a page. This is the
compensation for `fff`'s per-keystroke advantage (10–21 ms against 24–53 ms,
report 17 §B.3): the file manager loses on total latency and wins on
time-to-first-row.

### 6.4 Byte offsets to string indices

`ripgrep`'s `submatches[].start` and `.end` are **byte offsets** into the raw
line, not string indices. Measured: for the line `holañ mundo needle here`, the
match `needle` reports `start: 13`, while its UTF-16 string index is `12` —
`ñ` occupies two bytes and one code unit.

Port `mapContentMatchRanges` (`WorkspaceSearchIndex.ts:247-256`) unchanged:

```ts
export function mapMatchRanges(
  lineBytes: Buffer,
  byteRanges: ReadonlyArray<readonly [number, number]>,
): MatchRange[] {
  // Fast path: a pure-ASCII line has byte offset === string index. Mesura Code
  // does not do this; on a typical source file it removes almost every
  // conversion.
  const line = lineBytes.toString("utf8");
  if (lineBytes.length === line.length) {
    return byteRanges.map(([start, end]) => ({ start, end }));
  }
  const toStringIndex = (byteOffset: number) =>
    lineBytes.subarray(0, byteOffset).toString("utf8").length;
  return byteRanges.map(([start, end]) => ({
    start: toStringIndex(start),
    end: toStringIndex(end),
  }));
}
```

**Why re-decoding the prefix is exact, including for invalid bytes.** The
decoder processes bytes left to right and is deterministic. The number of UTF-16
code units it emits for the prefix `[0, byteOffset)` is therefore exactly the
number it emits for those same bytes inside the full line — including any
`U+FFFD` replacements. Both the full string and the prefix come from one
decoder, so they cannot disagree.

**Cost.** `subarray(0, n).toString()` is O(n) per range. Bounded by
`--max-count 100` per file and 500 rows in total, and skipped entirely on ASCII
lines. Mesura Code's own comment flags this as a real cost on a dense line; the
ASCII fast path is what removes it.

Strip the trailing `\n` from `lines.text` **after** the conversion. The newline
sits at the end, so no range can be affected, but keeping the order fixed
removes the question.

### 6.5 The long-line guard

Because `-M` does nothing in `--json` mode (§6.1), the main process truncates:

- If `lineContent.length <= 500`, emit it as-is with `lineTruncatedAt: null`.
- Otherwise, take a window of 500 characters starting 80 characters before the
  first match range (clamped to 0), rebase every range that falls inside the
  window, drop the ranges that fall outside, and set `lineTruncatedAt` to the
  window's start index.

**Why 500.** It is wider than any pane the row can render at 1080 px, so the
truncation is never visible for a normal line, and it caps the cost of a minified
bundle at 500 characters instead of two megabytes.

### 6.6 Ordering and grouping

`ripgrep` searches in parallel, so files complete in an arbitrary order.
**Blocks are never interleaved**: measured over `/usr/include` (44 282 files),
19 matching files produced 19 contiguous `begin`…`end` blocks with zero
interleaving violations. So:

- group rows by `path` **in arrival order**, exactly as `groupMatches` does
  (`ProjectContentSearchDialog.tsx:42-54`);
- a group, once opened, never gains rows after a later group has opened, so the
  list never reflows above the cursor;
- the group order is not deterministic between two runs of the same query. That
  is acceptable and it is the price of parallelism; `--sort path` would buy
  determinism for roughly a 2× wall-clock cost.

Rows mount in **windows of 100** (`VISIBLE_MATCH_WINDOW`,
`ProjectContentSearchDialog.tsx:28`), grown by an `IntersectionObserver`
sentinel or by the keyboard moving past the rendered window
(`:132-151`). The file manager will syntax-highlight its rows too, so it hits
the same stall Mesura Code's own comment records (`:22-27`).

### 6.7 The constants, in one place

| Constant | Value | Source of the value |
|---|---|---|
| `CONTENT_SEARCH_TIME_BUDGET_MS` | 250 | `WorkspaceSearchIndex.ts:33` |
| `MAX_MATCHES_PER_FILE` | 100 | `WorkspaceSearchIndex.ts:34`, applied as `--max-count` |
| `CONTENT_SEARCH_MATCH_LIMIT` | 500 | `queries.ts:37` |
| `CONTENT_SEARCH_DEBOUNCE_MS` | 100 | the file manager's stage-1 debounce, not Mesura Code's 120 |
| `PREVIEW_DEBOUNCE_MS` | 150 | `fm/qml/…/FuzzyFinderInfoPanel.qml:29-33` |
| `PATH_SEARCH_LIMIT` | 200 | `fm/plugin/…/fuzzyfinder.hpp:132`; request `201` to compute `truncated` |
| `VISIBLE_MATCH_WINDOW` | 100 | `ProjectContentSearchDialog.tsx:28` |
| `QUERY_MAX_LENGTH` | 256 | `mesura/packages/contracts/src/project.ts:43` |
| `MAX_LINE_LENGTH` | 500 | this specification, §6.5 |
| `RG_MAX_FILESIZE` | `10M` | matches `fff`'s own default (report 17 §B.1) |
| `SIGKILL_GRACE_MS` | 250 | this specification, §6.3 |
| `BATCH_SIZE` / `BATCH_MS` | 32 / 40 | this specification, §6.3 |

---

## 7. State ownership

The renderer is sandboxed. It has no `fs`, no `child_process` and no path
knowledge beyond the strings the main process hands it.

### 7.1 The split

| State | Owner | Why |
|---|---|---|
| Overlay open / mode / `originMode` / `searchRoot` | renderer | pure UI state; the reducer is 30 lines and must respond within one frame |
| Per-mode query drafts | renderer | typing must never wait on IPC |
| `selectedIndex`, `visibleCount`, preview scroll offset | renderer | |
| The keybinding registry array and the palette filter/rank | renderer | the rank formula is pure, and the `run()` bodies drive renderer state |
| `enabled(ctx)` evaluation | renderer | it reads `windowState`, which is renderer state |
| The `fff` index, keyed by base path, with an idle timeout | main | adopted correction 4. Also: LMDB refuses a second open of one frecency environment **within a process** (spike 1, `18-spike-results.md:17-40`), so the index owner is a single process |
| The frecency store path, and every `trackQuery` write | main | D2 requires exactly one owner of that path |
| The `ripgrep` child process and its lifetime | main | `child_process` is unavailable in a sandboxed renderer |
| Byte-offset conversion, long-line truncation, git-status normalization | main | all three need the raw bytes, and doing them once at the boundary keeps the renderer's row type honest |
| Path validation for the picker and portal flows | main | a renderer must never widen its own filesystem scope |

**Where the `fff` index actually runs is settled elsewhere and only referenced
here.** Spike 1 measured that several indices can share one frecency store
across processes but not within one, and recommends a `utilityProcess` per
index (`18-spike-results.md:56-62`). This specification is indifferent to that
choice: it addresses "the main process", and whether the main process forwards
to a `utilityProcess` is an implementation detail behind the same IPC surface.

### 7.2 The IPC surface

Registered inside the file manager's own feature layer, not in a shared contract
file. `12-synthesis.md:128-131` records the reason: `packages/contracts/src/ipc.ts`
carries a written warning, and the fork-cheap variant is two lines instead of six
files.

```ts
// preload → window.symmetriaFm.search
export interface SearchBridge {
  /** Acquire (or warm) the fff index for a root. Idempotent. Resolves as soon
   *  as the index exists; `phase` reports whether it is still scanning. */
  acquireIndex(root: string): Promise<{ readonly phase: "indexing" | "ready" }>;

  /** Path search. Request/response — fff answers in 10–20 ms, so a plain
   *  invoke is right. Revisit only if a measured p95 passes ~80 ms. */
  searchPaths(req: PathSearchRequest): Promise<SearchPage<PathSearchRow>>;

  /** Content search. STREAMING. Returns a handle that owns one child process. */
  startContentSearch(req: ContentSearchRequest): Promise<ContentSearchHandle>;

  /**
   * Query-tracker write, NOT a frecency write — the frecency writer is not
   * exported by the shipped library. Fire and forget; never awaited on the
   * confirm path.
   */
  recordOpen(req: { readonly absolutePath: string; readonly query: string }): void;

  /** Index phase push, so the status line can move from "indexing" to
   *  "searching" without polling. */
  onIndexPhase(
    listener: (event: {
      readonly root: string;
      readonly phase: SearchPhase;
      readonly scannedFiles: number;
    }) => void,
  ): () => void;
}

export interface PathSearchRequest {
  readonly root: string;
  /** Trimmed. An empty query is a VALID, deliberate request: fff answers it
   *  with the frecency-ranked list, which is what the finder shows before the
   *  first keystroke (fm/plugin/…/fuzzyfinder.cpp:407-408, 417-418). */
  readonly query: string;
  /** 200. The main process asks fff for `limit + 1` to compute `truncated`. */
  readonly limit: number;
  readonly requestId: number;
}

export interface ContentSearchRequest {
  readonly root: string;
  /** NOT trimmed. Whitespace is significant in a content query
   *  (mesura/packages/contracts/src/project.ts:41-43). Max 256 characters. */
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly useRegex: boolean;
  readonly includeHidden: boolean;
  readonly includeIgnored: boolean;
  readonly globs: readonly string[];
  readonly requestId: number;
}

export interface ContentSearchHandle {
  readonly requestId: number;
  /** Batches of rows, in arrival order. */
  onRows(listener: (rows: readonly ContentSearchRow[]) => void): void;
  /** Terminal. Fires exactly once. */
  onDone(listener: (summary: {
    readonly truncated: boolean;
    readonly fileCount: number;
    readonly error: string | null;
    readonly invalidRegex: boolean;
  }) => void): void;
  /** Kills the child. Safe to call after onDone. */
  cancel(): void;
}
```

**Which calls stream:** `startContentSearch` only. `searchPaths` is
request/response. `onIndexPhase` is a push channel, not a stream of results.

**Transport for the stream.** Recommended: one `MessageChannelMain` port per
search, transferred to the renderer by `startContentSearch`. See **OPEN-6**.

**Cancellation is guaranteed on three events**, and all three call
`handle.cancel()`:

1. the query changes (a new `startContentSearch` supersedes the old handle);
2. the overlay leaves content mode or closes;
3. the renderer that owns the handle goes away — the main process listens for
   `webContents.on("destroyed")` and reaps any child still running, so a closed
   window can never leave an orphaned `ripgrep` walking `/`.

---

## 8. Deliberately not in v1

Each omission carries its reason. None of them is "we ran out of time".

| Omitted | Reason |
|---|---|
| **`fff` content indexing** | Reversed by D10 on measurement: 8.3× the scan time and 28× the resident memory, and it only pays back when one directory is searched many times. A file manager opens arbitrary directories once. |
| **`multiGrep`, fuzzy content mode, `classifyDefinitions`, `beforeContext`/`afterContext` from `fff`** | They belong to the engine that was not chosen. Listing them keeps the door open (report 17 §B.2); building against them now would re-couple the design to the index. |
| **Context lines (`rg -C`) in the result list** | The preview pane already shows the match in its file, with syntax colours and scroll keys. That is the file manager's advantage over Mesura Code, and duplicating it as extra rows would multiply the row count for information already on screen. |
| **Search and replace across files** | A bulk mutation. Vision principle 3's corollary requires it to be explicit, bounded and to show progress; that is a feature with its own confirmation surface, not a flag on a search box. |
| **Palette submenu views** (Mesura Code's `kind: "submenu"` + Backspace pop) | Chord bindings flatten into ordinary rows instead (§5.3), which makes every chord leaf directly searchable. Backspace-on-empty is already spent on the directory drill-up, which is the more valuable use of the key in a file manager. |
| **Query history (`↑` for the previous query)** | `↑` is result navigation. A second meaning needs a mode, and `fff`'s `getHistoricalQuery` is available whenever that mode is designed. |
| **User-editable keybindings and the `when` AST** | Report 17 §D.2: adopt the AST only when bindings must round-trip through a config file. Vision: "No configuration dialogs for preferences that could be a sensible default." |
| **`Ctrl+R` HTML render inside the overlay preview** | The overlay preview is a glance surface. `Ctrl+R` is available the instant the file is opened, and spinning a Chromium render out of a search box contradicts principle 3. |
| **Paging past the caps ("load more", `pageIndex`)** | Both products leave `fff`'s paging unused, and the honest contract is 200 rows plus a `truncated` flag. A user who needs result 201 should narrow the query, which is faster than paging. |
| **A palette in the windowState-less embedded tree** | That path bypasses the registry entirely and keeps a legacy navigation-only switch (`KeyRegistry.js:34-37`). Giving it a palette means giving it the registry first, which is a separate change. |
| **Cross-root or multi-tab search** | One `searchRoot` at a time. Vision principle 4: constraining the surface constrains the mess. |
| **Searching from the enclosing git repository root instead of the tab cwd** | The panel knows nothing about git (vision principle 2). Finding a repository root is git knowledge, and it would have to come from the injected host — which the standalone does not have. |
| **Mouse-driven mode tabs and the three option toggle buttons Mesura Code draws** | Vision principle 6. Clicking a row stays supported; the mode and the options are keys plus a status sigil. |
| **Score, frecency and `matchType` columns** | Four `fff` roles that no UI reads today (report 17 §A.2). They are debug output, and the info panel already answers "why this row" better than a number would. |
| **A second sigil for the content mode** | See **OPEN-2**. Deferring it costs one keystroke and avoids inventing a convention the user has no muscle memory for. |

---

## 9. Open points

Seven judgement calls the inputs did not settle. Each lists the options and a
recommendation.

**OPEN-1 — the key that opens the command palette.**
The overlay's own `Ctrl+K` and `Ctrl+J` move the highlight, so the palette key
cannot be `Ctrl+K` — a toggle-closed press would be swallowed by the list.

| Option | For | Against |
|---|---|---|
| `Ctrl+Shift+P` | VS Code and Mesura Code muscle memory; a letter key, so the modifiers are the user's intent and no layout trap applies | three fingers |
| `:` | vim register; matches the PRD's never-built "command mode" | a symbol key, so it needs `mods: "*"`; on the Latin-American layout `:` is Shift+`.` and Qt reports `Key_Colon` rather than `Key_Period`, which is correct but is exactly the class of assumption that broke `/`-search once |
| `Ctrl+K` | Mesura Code's `⌘K` | collides with the overlay's own previous-row key |

**Recommendation: ship both `Ctrl+Shift+P` and `:` as two registry rows on one
command.** The registry already has this precedent —
`clip.paste`/`clip.pasteCtrl` (`KeyRegistry.js:216-221`) and
`miller.tabNext`/`miller.tabNextCtrl` (`:389-394`). Verify the `:` row against
the real Latin-American layout before merging, as `tst_keyregistry.qml` does for
the other glyph bindings.

**OPEN-2 — a query sigil for the content mode.**
Options: (a) key-only entry, `>` remains the only sigil; (b) add a second sigil
such as `#` or `'`. **Recommendation: (a) for v1.** D10 named only `>`, and a
second sigil steals a literal first character from a `ripgrep` pattern for a
convention nobody has learned yet.

**OPEN-3 — Escape from a switched mode.**
Options: (a) Mesura Code exactly — Escape from any non-command mode returns to
the command mode (`CommandPalette.tsx:428-442`); (b) one-deep origin — return to
the mode the overlay was opened in; (c) always close. **Recommendation: (b),
which §1.1 already encodes as `originMode`.** Option (a) is wrong here because
the file manager's primary surface is the finder, not the palette: a user who
pressed `f` and then `Ctrl+F` should land back on `f`, not on a palette they
never opened.

**OPEN-4 — do the per-mode query drafts survive *closing* the overlay?**
Options: (a) all drafts cleared on close; (b) all drafts kept for the session;
(c) the content draft is kept, the path draft is cleared. **Recommendation:
(c).** A content query is expensive to retype and is often refined across
several visits. A path query is cheap, and the empty state is not empty — it is
the frecency-ranked browse, which is frequently the answer on its own.

**OPEN-5 — `--engine auto`.**
Options: (a) include it, so a pattern with look-around or a back-reference falls
back to PCRE2 instead of failing; (b) omit it, keeping the Rust engine's linear
time guarantee. **Recommendation: (a).** PCRE2 is compiled into the `ripgrep`
on this machine (`+pcre2`, JIT available). The risk is a pathological pattern
running slowly, and the 250 ms budget already bounds that. If `ripgrep` is ever
shipped rather than taken from the system, confirm the shipped build has PCRE2 —
without it, `--engine` errors out and every search fails.

**OPEN-6 — transport for the content-search stream.**
Options: (a) one `MessageChannelMain` port per search; (b)
`ipcRenderer.on("fm.search.content.chunk")` with a `requestId` filter.
**Recommendation: (a).** There is more than one renderer — the picker window is
a second one — and a broadcast channel would push grep chunks into a renderer
that never asked for them. A port also tears down naturally when the handle is
dropped, which removes a class of leak. Option (b) is simpler and acceptable if
the port transfer proves awkward through the preload boundary.

**OPEN-7 — the preview pane width.**
Options: (a) keep 360 px, the Qt value; (b) widen to about 420–480 px, since the
row is now HTML and elides better than a Qt `Text` in `RichText` mode.
**Recommendation: (a) for v1**, because 360 px is a measured value with a
recorded failure mode behind it (`fm/qml/…/FuzzyFinderPopup.qml:240-246`), and
widening it is a one-line change once the real surface can be looked at.
