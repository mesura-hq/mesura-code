# 01 — Navigation, View Modes, Keyboard, Selection, Per-Window State

Scope: how the user MOVES and SELECTS. Previews and file operations are covered by
other documents. This document is the specification a React/Electron port is
written from.

All paths are relative to the repository root
`/home/jc/projects/symmetria-file-manager` (read from the worktree
`/home/jc/.t3/worktrees/symmetria-file-manager/t3code-a2a6aa9b`).

Every feature entry records three extra fields:
- **Layer** — QML, C++, or both.
- **Gotcha** — non-obvious behaviour a re-implementation gets wrong.
- **Port** — trivial / mechanical / needs design work, with one line of reasoning.

---

## 1. View modes

### 1.1 There are exactly TWO view modes, not three

`WindowState.qml:399-411` declares the enum:

| Constant | Value | Meaning |
|---|---|---|
| `viewMillerColumns` | 0 | Miller columns (default) |
| `viewTree` | 1 | Recursive file tree |

`viewMode` is a per-tab `int` on `WindowState`. `FileManager.qml:42-48` swaps the
`Loader.sourceComponent` between `millerComponent` and `treeComponent` on that
value.

The "single pane" is NOT a third mode. It is the wrapper `Item` that
`FileManager.qml:67-133` puts around `FileTreeView` so the tree floats as one
rounded card, matching one Miller column. `CLAUDE.md` calls it "the single-pane
view in `FileManager.qml`" only as the fourth copy of the pane-surface idiom.

A THIRD consumer surface exists but is not a mode: the **windowState-less
embedded tree** (`FileTreeView` with `windowState: null`), used by the
Symmetria-IDE sidebar. It has no chords, no registry dispatch, no selection, no
search — see §4.5.

- **Layer**: QML only.
- **Gotcha**: `WindowState.toggleViewMode()` (`WindowState.qml:403-411`) clears
  search AND flash before flipping. Row indices in `matchIndices` /
  `flashCurrentMatchMap` address the OUTGOING view's row model (Miller's
  `fsModel.entries` vs the tree's flattened `_rows`) and are meaningless against
  the incoming one.
- **Port**: mechanical. Two React component trees behind one enum in a store.

### 1.2 Miller columns

`MillerColumns.qml` — a 3-column `RowLayout`, `anchors.margins: FmTheme.padding.md`,
`spacing: FmTheme.padding.sm`.

| Column | Component | `Layout.preferredWidth` (flex ratio) | Role |
|---|---|---|---|
| Left | `ParentPanel` | 2 | Passive listing of the parent directory |
| Center | `FileList` | 5 | The cursor lives here; owns `Keys.onPressed` |
| Right | `PreviewPanel` | 3 | Passive preview of the cursor entry |

Each column is a `StyledRect` with `radius: FmTheme.rounding.lg`,
`color: FmTheme.palette.surface`, `border.color: FmTheme.overlay.subtle`,
`border.width: 1`. The content is inset by `FmTheme.padding.md` inside that
surface.

`MillerColumns.qml:11-26` re-exports for the enclosing `FileManager`:
`currentEntry`, `fileCount`, `currentItemBottomY`, `currentColumnX`,
`currentColumnWidth`.

The left column doubles as the which-key HUD host: `ParentPanel.opacity` goes to 0
while `windowState.chordActive`, and `WhichKeyPopup` fades in over the same rect
(`MillerColumns.qml:66-82`).

`ParentPanel` runs its OWN `FileSystemModel` on `Paths.parentDir(currentPath)`
(`ParentPanel.qml:66-73`). Its highlight is not user-driven: `_syncHighlight()`
(`ParentPanel.qml:103-120`) always forces `currentIndex` onto the entry whose
`name` equals the current directory's basename, and `onCurrentIndexChanged`
re-runs it through `Qt.callLater` so a stray click cannot desync it. At `/` the
parent list is hidden and a `PreviewStateIndicator` reading "Root" is shown.

- **Layer**: QML only.
- **Gotcha**: the parent column is a **third live `FileSystemModel`** with its own
  `QFileSystemWatcher`, not a slice of a cached listing. It sorts with the same
  `windowState.sortBy` / `sortReverse` as the center column.
- **Port**: mechanical. CSS flex `2 / 5 / 3` with three independent directory
  subscriptions.

### 1.3 File tree

`FileTreeView.qml` — one full-width `ListView` over a flattened DFS row array
`root._rows`. Each row is a plain JS object built in `TreeModel.rebuildRows`
(`handlers/TreeModel.js:704-731`):

```js
{ path, name, isDir, depth, expanded, entry }   // `entry` is the C++ FileSystemEntry
```

Expansion state machine lives in `handlers/TreeModel.js`. Key facts:

- One `FileSystemModel` instance is created **per expanded directory**, lazily on
  first expand (`TreeModel.expand`, `TreeModel.js:160`). Each carries its own
  `QFileSystemWatcher`, which is where live updates come from.
- `_expanded` is a `{path: true}` map; `_models` is `{path: FileSystemModel}`;
  `_modelHandlers` is `{path: fn}` so signal handlers can be disconnected before
  a model is destroyed.
- Auto-expand priority ladder at mount, mutually exclusive
  (`TreeModel.beginMount`, `TreeModel.js:89`):
  1. `restoreExpandedPaths` (non-empty) — ancestor-first replay of a saved set.
  2. `lazyExpand: true` — expand one directory at a time until the viewport is
     covered plus `LAZY_BUFFER_ROWS` (8) of overscroll.
  3. `initialExpandDepth` — BFS fan-out, `0` = collapsed (default), `N` = N
     levels, `-1` = recursive capped by `maxExpandDepth` (default 8).
- Guardrails are constants in `TreeModel.js`, deliberately NOT properties:
  `FANOUT_CAP`, `MODEL_CEILING`, `NODE_CEILING`, `SKIP_NAMES` (`.git` etc.),
  `LAZY_BUFFER_ROWS`. Each hit emits one `Logger.info`.
- Filtering per row in `rebuildRows`: hidden names (`showHidden`), gitignored
  paths (`respectGitignore` + `_ignored[parentPath]`), and an optional
  `pathFilter` membership map. The `pathFilter` map MUST include every ancestor —
  the FM does not compute ancestor closure.
- `compactScale` (default `1.0`) multiplies every size in the row delegate. The
  IDE sidebar passes ~0.6–0.75.

Standalone-only chrome: `FileManager.qml:67-133` wraps the tree in a card and
overlays `WhichKeyPopup` on it (the tree has no side column to host the HUD).

- **Layer**: QML + JS for the state machine; C++ for each directory listing.
- **Gotcha 1**: `rebuildRows` re-anchors the viewport on the row that was at the
  **viewport top**, never on the cursor (`TreeModel.js:775-820`). There is an
  explicit regression comment: anchoring on the cursor makes the tree snap
  upward on every scroll tick, because lazy-expand fires from
  `onContentYChanged`. Keyboard navigation never showed the bug because it moves
  the cursor with the scroll.
- **Gotcha 2**: `view.forceLayout()` before restoring `contentY` is load-bearing —
  a fresh model leaves `contentHeight` stale, so the clamp would run against
  stale geometry.
- **Gotcha 3**: search in the tree matches only **currently-visible rows**
  (`TreeModel.computeMatches`, `TreeModel.js:864`). Collapsed subtrees are out of
  scope by spec.
- **Port**: needs design work. The per-directory-watcher model, the lazy-expand
  cycle driven by scroll position, and the viewport-top re-anchor are all
  imperative and interact with layout timing; React's reconciliation does not
  give you `forceLayout()`.

### 1.4 Behavioural differences between the two views

| Concern | Miller | Tree |
|---|---|---|
| `h` / `←` | `windowState.goUp()` — navigates the whole view up one directory | Collapse current dir if expanded, else jump to parent ROW (`TreeModel.jumpToParent`) |
| `l` / `→` | Enter directory (files do nothing) | Expand dir; if already expanded move down one row; if a file, `fileActivated(path)` |
| `Enter` | `_activateCurrentItem()` — picker confirm, or navigate, or exec shell script, or `FileOpener.open` | `TreeModel.activate` — dirs TOGGLE, files emit `fileActivated` |
| `Escape` unmatched | Swallowed by `miller.escapeSwallow` | Falls through to the host's close-window handling (deliberate — no such binding) |
| `nav(fn)` adapter | `root._saveCursorAndNavigate(fn)` — saves the cursor first | passthrough `fn()` — no cursor save |
| Paste/create target dir | `windowState.currentPath` | hovered dir, or hovered file's parent (`FileTreeView.fileOpsTargetDir`, `FileTreeView.qml:266-270`) |
| Pending-paste focus | `_pendingFocusName` consumed on next `entriesChanged` | **no-op** — a pasted item can land at any depth (`FileTreeView.qml:275-276`) |
| `.` key | Toggle hidden files | Toggle `.gitignore` filter |
| Toggle hidden | `.` (`miller.toggleHidden`) | `Shift+H` (`tree.toggleHidden`) |
| Tabs, zoxide, context menu, HTML render, audio toggle | available | **absent** |
| Flash columns | 3 (`current`, `preview`, `parent`) | 1 (`current`) |
| Half-page metric | `NormalModeHandler._halfPageCount(view)` | `TreeModel.halfPageCount()` — same formula, but ignores `compactScale` |

- **Gotcha**: `TreeModel.halfPageCount` (`TreeModel.js:857`) divides by
  `Config.fileManager.sizes.itemHeight` with NO `compactScale` factor, while the
  rendered row height IS scaled (`TreeModel.rowHeight`, `TreeModel.js:652`).
  Ctrl+D/Ctrl+U therefore jump the wrong distance in a compact tree. That is a
  latent bug worth NOT reproducing.

---

## 2. Navigation model

### 2.1 Cursor movement

The cursor is the `ListView.currentIndex` of the active view's inner `ListView`
(`FileList.qml:263` `id: view`, `FileTreeView.qml:430` `id: view`). There is no
separate cursor state object.

`keyNavigationEnabled: false` on both lists — Qt's built-in arrow handling is
disabled so the registry owns every key.

Movement primitives, all in `KeyRegistry.js`:
- `nav.down` / `nav.up` — `currentIndex ± 1`, clamped, no wrap.
- `nav.bottom` (`Shift+G`) — `currentIndex = count - 1` + `positionViewAtIndex(…, ListView.End)`.
- `gg` chord — `currentIndex = 0` + `positionViewAtIndex(0, ListView.Beginning)`
  (`ChordHandler.js:75-78`).
- `nav.halfDown` / `nav.halfUp` (`Ctrl+D` / `Ctrl+U`) — `± ctx.halfPageCount()`,
  clamped, then `positionViewAtIndex(…, ListView.Contain)`.
- `miller.tabBoundary` (`Tab`) — jump to the FIRST entry of the opposite kind
  (`NormalModeHandler._jumpToDirFileBoundary`, `NormalModeHandler.js:87-94`).
  Because directories always sort before files, this is "jump to the dir/file
  boundary".

Half-page formula (`NormalModeHandler.js:74-76`):
```js
Math.max(1, Math.floor(view.height / Config.fileManager.sizes.itemHeight / 2))
```
`itemHeight` is **20** (`config/FileManagerConfig.qml:19`).

- **Layer**: QML/JS only.
- **Gotcha**: `nav.down`/`nav.up` do NOT call `positionViewAtIndex`. Qt's
  `ListView` auto-scrolls to keep `currentItem` visible via `highlightRangeMode`
  defaults. A DOM list must scroll the cursor into view explicitly.
- **Port**: trivial.

### 2.2 Cursor cache (per-directory memory)

`WindowState.qml:20-28`:
```qml
property var _cursorCache: ({})            // { path → index }
function saveCursor(path, index)           // _cursorCache[path] = index
function restoreCursor(path)               // _cursorCache[path] ?? 0
```

`saveCursor` is called before every Miller navigation
(`FileList._saveCursorAndNavigate`, `FileList.qml:133-136`), before a tab switch
(`FileList.qml:75-90`), before opening the fuzzy finder and zoxide, and before
closing a tab.

Restoration happens in the `fsModel.onEntriesChanged` handler
(`FileList.qml:300-351`) and, for a same-path tab switch, directly in
`onWindowStateChanged` (`FileList.qml:96-111`).

- **Layer**: QML only. The cache is a plain JS object mutated in place — it is
  NOT reactive, and nothing binds to it, so mutation is safe here.
- **Gotcha**: the cache is unbounded and never evicted; it lives for the tab's
  lifetime.
- **Port**: trivial. A `Map<string, number>` in the tab store.

### 2.3 The `_pathJustChanged` handshake

`FileList.qml:46, 294-351`. This is the single most fragile piece of the
navigation flow.

1. `fsModel.path` is bound to `windowState.currentPath`.
2. `onPathChanged` sets `root._pathJustChanged = true` **synchronously**.
3. The C++ model emits `entriesChanged` **twice** on a path change: first with
   `count === 0` (stale-entry clear), then with the real entries after the async
   `QtConcurrent` scan.
4. The handler `return`s early on the `count === 0` emission so the flag is not
   consumed by a cursor clamped to 0.
5. On the real emission: consume the flag, apply `_pendingFocusName` if set, else
   `restoreCursor(fsModel.path)` clamped to `count - 1`, then
   `positionViewAtIndex(…, ListView.Beginning)`.
6. When the flag is false (same-directory refresh from the watcher): clamp the
   cursor if it now exceeds `count`, and apply `_pendingFocusName` with
   `ListView.Contain`.

There is an explicit **DO NOT** comment (`FileList.qml:295-299`): never add an
`onLoadingChanged` handler that clears `_pathJustChanged`, because
`loadingChanged(false)` fires BEFORE `applyChanges()` populates entries
(`filesystemmodel.cpp:625-636`).

- **Layer**: both. The double-emit is C++ behaviour; the handshake is QML.
- **Gotcha**: an Electron port that fetches a directory listing with one
  `await` and one state update removes the double-emit entirely — but must then
  reproduce the *cursor restore timing*, i.e. restore only after the new rows are
  committed to the DOM, not before.
- **Port**: mechanical, and simpler than the original.

### 2.4 History

`WindowState.qml:13-73`. A linear array plus an index — standard browser history.

| Member | Definition |
|---|---|
| `_history` | `[initialPath]` |
| `_historyIndex` | `0` |
| `canGoBack` | `_historyIndex > 0` |
| `canGoForward` | `_historyIndex < _history.length - 1` |

`navigate(path)`:
- returns immediately if `path === currentPath` (**load-bearing**: several callers
  rely on this no-op, e.g. the fuzzy finder's same-directory case);
- `clearSearch()`, `clearFlash()`, `closeModal()` if a modal is open;
- truncates forward history: `_history.slice(0, _historyIndex + 1).concat([path])`;
- `_historyIndex = _history.length - 1`; `currentPath = path`.

`back()` / `forward()` do the same clear + `closeModal` then step the index.
`goUp()` returns at `/`, clears search/flash, then `navigate(Paths.parentDir(currentPath))`.

History is **unbounded** and per-tab.

Keys: `Shift+S` / `Shift+D` (CORE) and `-` / `=` (Miller only) are aliases for
back/forward. The PathBar also carries clickable back/forward buttons
(`PathBar.qml:59-98`).

Zoxide is trained on every visit: `FileManager.qml:194-208` runs
`zoxide add -- <path>` on `currentPathChanged`, with a one-slot `_pendingPath`
queue so rapid navigation does not drop visits.

- **Layer**: QML only.
- **Gotcha**: `navigate()` calls `closeModal()` internally. `ZoxidePopup._confirmSelection`
  (`ZoxidePopup.qml:276-282`) relies on that — it never closes the popup itself.
- **Port**: trivial.

### 2.5 Path bar

`PathBar.qml`. It is a **breadcrumb bar, NOT an editable text field.** There is no
`:`-command mode and no path text input anywhere in the codebase — the PRD
describes one (`PRD.md:369-381`) but it was never built.

Contents left to right:
1. Back button — `StateLayer` with `disabled: !canGoBack`, icon `arrow_back`,
   colour `onSurface` when enabled / `outline` when not.
2. Forward button — mirror of the above with `arrow_forward`.
3. Breadcrumb pill (`PillSurface`, `color: FmTheme.palette.surface`), containing
   centred segments built by `_segments` (`PathBar.qml:18-46`):
   - `path === home` → `[{name: "~", path: home, isHome: true}]`
   - under home → `~` plus one segment per relative component, each carrying the
     accumulated absolute path
   - outside home → `/` plus one segment per component
   Every segment except the last is clickable (`navigate(segment.path)`); the
   last renders in `onSurface`, earlier ones in `onSurfaceVariant`. Separator
   `/` is drawn between segments.
4. Hidden-files toggle — icon `visibility` / `visibility_off`, sets
   `Config.fileManager.showHidden` and calls `Config.save()`.

- **Layer**: QML only.
- **Gotcha**: `Config.save()` is a **no-op** (`config/Config.qml:8-10`, "config
  persistence deferred to later phase"). The hidden-files toggle does NOT
  persist, despite the PRD claiming it does. The default is
  `showHidden: true` (`config/FileManagerConfig.qml:4`) — hidden files are shown
  on every fresh start.
- **Port**: trivial.

### 2.6 Bookmarks

`services/BookmarkService.qml` — a `pragma Singleton`, **global**, not per-window.

Storage: `~/.config/symmetria-fm/bookmarks.json`
(`BookmarkService.qml:12`). Format is a flat JSON object:

```json
{
  "h": { "path": "/home/jc",           "label": "Home"      },
  "d": { "path": "/home/jc/Downloads", "label": "Downloads" }
}
```

- Keys are single lowercase letters `[a-z]`.
- `label` is `Paths.basename(path) || path`, computed at add time.
- Reserved keys that can never be assigned: `["g", "n", "x"]` (`_reservedKeys`,
  `BookmarkService.qml:16`) — `gg` = Top, `gn` = New bookmark, `gx` = Delete
  bookmark.
- Defaults seeded on first run (`_defaultBookmarks`, `BookmarkService.qml:19-22`):
  `h` → `$HOME`, `d` → `$HOME/Downloads`. Both are user-deletable.

**Hot reload**: a C++ `FileWatcher` element with `watchChanges: true` reads the
file into `text` at construction and re-reads on `fileChanged`
(`BookmarkService.qml:109-123`). `onLoadFailed` on first run seeds the defaults
and writes them. Writes go through a `ShellRunner` running
`sh -c 'mkdir -p "$(dirname "$1")" && printf %s "$2" > "$1"'` with a one-slot
`_pendingPayload` queue (`BookmarkService.qml:126-148`).

Icon per bookmark: `iconForPath` (`BookmarkService.qml:66-78`) matches the path
relative to `$HOME` against `_knownDirectoryIcons`:

| Relative path | Icon |
|---|---|
| `""` (home itself) | `home` |
| `Downloads` | `download` |
| `Documents` | `description` |
| `Pictures` | `image` |
| `Pictures/Screenshots` | `screenshot_monitor` |
| `Videos` | `video_library` |
| `Music` | `library_music` |
| `Desktop` | `desktop_windows` |
| `.config` | `settings` |
| anything else | `bookmark` |

- **Layer**: QML for the logic, C++ (`FileWatcher`) for the hot reload.
- **Gotcha 1**: `FileWatcher` mitigates the atomic-replace inotify drop by
  watching the file AND its parent directory and re-arming
  `removePath; addPath` on every change, with a 100 ms retry timer
  (`plugin/src/Symmetria/FileManager/Models/filewatcher.cpp`). An Electron port
  using bare `fs.watch` will lose the watch on `:w` in an editor.
- **Gotcha 2**: the file is written by an external process, so the watcher fires
  on the service's own writes too. `_applyBookmarks` is idempotent, so this is
  harmless — do not "optimise" it into a write-suppression flag.
- **Port**: mechanical. `chokidar` + a JSON read/write in the main process.

### 2.7 Flash jump (`s`)

Port of Flash.nvim. Two implementations sharing one pure algorithm:
- `FlashLogic.js` — `.pragma library`, pure, no QML scope.
- `handlers/FlashHandler.js` — Miller, three columns.
- `handlers/TreeFlashHandler.js` — tree, one column.

**Algorithm** (`FlashLogic.computeFlash`, `FlashLogic.js:25-78`):

1. Case-insensitive **substring** match of `query` against every entry `name`
   across all columns. Record `matchStart`.
2. Collect **continuation characters**: the character immediately after EVERY
   occurrence of `query` in EVERY matching name (`_continuationChars`,
   `FlashLogic.js:82-100`). Add every character of the query itself.
3. Build the label pool: `LABEL_CHARS = "asdfghjklqwertyuiopzxcvbnm"` minus the
   continuations. Home-row priority order is preserved.
4. Sort matches by priority (`_sortByPriority`, `FlashLogic.js:103-123`):
   column order `current(0) → preview(1) → parent(2)`; within `current`, by
   `|index - cursorIndex|`; within the others, by `index`.
5. Assign labels (`_assignLabels`, `FlashLogic.js:127-173`):
   - Phase 1: one 1-character label per match while the pool lasts.
   - Phase 2: 2-character labels for the remainder. **Critical**: a 2-character
     label's FIRST character must not already be a 1-character label, otherwise
     the 1-character match always wins and the 2-character target is unreachable.
   - If no prefixes remain, later matches stay unlabeled — deliberate graceful
     degradation.

The label makes the search→jump transition implicit: **if the typed character is
a label it jumps; if it is a continuation it extends the query.**

**Key handling** (`FlashHandler.handleKey`, `FlashHandler.js:16-125`):

| Key | Effect |
|---|---|
| bare Shift/Ctrl/Alt/Meta | swallowed, no effect |
| `Escape` | restore `_preFlashIndex`, `clearFlash()` |
| `Backspace` with a pending 2-char label | cancel the pending label only |
| `Backspace` with a non-empty query | drop last char, recompute |
| `Backspace` with an empty query | restore `_preFlashIndex`, `clearFlash()` |
| non-printable (`event.text === ""`) | swallowed |
| second char of a pending 2-char label | jump if the full label exists, else ignore |
| a character in `flashLabelChars`, exact 1-char match | jump |
| a character in `flashLabelChars` that prefixes a 2-char label | set `flashPendingLabel` |
| query empty, OR char in `flashContinuations` | append to query, recompute |
| anything else | dropped with a `Logger.warn` |

**Entry cache**: `_cachedAllEntries` is a module-level variable rebuilt only on
invalidation. Invalidated by directory change, watcher update
(`FileList.qml:350`), `previewDirectoryEntries` change (`FileList.qml:62`),
tab switch (`FileList.qml:84`), and pressing `s` (`ctx.invalidateFlashCache()`).
Preview-column entries are included ONLY when `previewDirectoryPath !== ""`,
which avoids searching stale entries inside the preview's 150 ms debounce window
(`FlashHandler.js:143`).

**Cross-column jump** (`FlashHandler.handleJump`, `FlashHandler.js:222-240`):

| Column | Action |
|---|---|
| `current` | set `currentIndex`, `positionViewAtIndex(…, Contain)` |
| `preview` | `saveCursor(previewDirectoryPath, index)` then `_saveCursorAndNavigate(navigate(previewDirectoryPath))` |
| `parent` | `saveCursor(parentDir(currentPath), index)` then `_saveCursorAndNavigate(goUp())` |

**Order is load-bearing** for `parent` and `preview`: the target-path
`saveCursor` MUST run BEFORE `_saveCursorAndNavigate`, which saves the cursor for
`currentPath` — a different key in the same cache.

Rendering: a match's name is rewritten as rich text — the matched substring gets a
`secondaryContainer` background, and the label REPLACES the following
`label.length` characters with a `primary`-background bold mono span
(`FileListItem._highlightFlash`, `FileListItem.qml:41-61`; the identical copy in
`TreeFlashHandler.highlightFlash`, `TreeFlashHandler.js:194-210`). Non-matching
rows dim to `opacity: 0.25`.

Per-column match maps (`flashCurrentMatchMap`, `flashParentMatchMap`,
`flashPreviewMatchMap`) exist so each `ListView`'s delegates only re-evaluate
when their OWN column's matches change.

- **Layer**: QML/JS only. Pure algorithm, zero C++.
- **Gotcha 1**: `TreeFlashHandler.js` is imported by BOTH `FileTreeView.qml` and
  `FileTreeRow.qml`. Non-library JS is per-importer, so `FileTreeRow`'s copy of
  `_cachedAllEntries` stays permanently null — harmless, but it means the cache
  is not a singleton (`TreeFlashHandler.js:9-13`).
- **Gotcha 2**: `WindowState.clearFlash()` (`WindowState.qml:139-149`) carries a
  NOTE — if you add a `flashXxxMatchMap` property you must reset it there too.
- **Gotcha 3**: the two `highlightFlash` implementations are acknowledged
  duplicates pending consolidation (`TreeFlashHandler.js:182-189`).
- **Port**: mechanical for the algorithm (it is already pure JS and directly
  reusable), needs design work for the rendering — the label overwrites
  characters in the name, so a naive `<mark>` wrapper is wrong.

### 2.8 Fuzzy finder and zoxide as navigation entry points

Both are modals that end in a `windowState.navigate(...)`.

`ZoxidePopup` (`z`, Miller only) — runs `zoxide query`, debounced 100 ms,
`Repeater`-rendered, max 10 rows. Keys: `Escape` closes, `Enter` confirms,
`Down`/`Ctrl+J` and `Up`/`Ctrl+K` move. `_confirmSelection` calls
`navigate(path)`, which closes the modal as a side effect.

`FuzzyFinderPopup` (`f`, both views) — backed by the Rust `fff` engine. Same key
set. `_confirmSelection` (`FuzzyFinderPopup.qml:285`):
- reads the row data BEFORE `closeModal()` (the Loader deactivates and clears the
  model);
- calls `fuzzyModel.recordOpen(index, query)` to teach frecency;
- if `externalActivation`, emits `activated(path, isDir)` and STOPS — the
  embedding host owns navigation from there;
- if the pick is a directory, `navigate(fullPath)`;
- if the pick is a file, emits `windowState.fuzzyFinderNavigated(name)` BEFORE
  `navigate(parentDir)` so the consumer can stash `_pendingFocusName` first.

Consumers of `fuzzyFinderNavigated`: `FileList.qml:195-209` (scan current entries
first, fall back to `_pendingFocusName`) and `TreeModel.focusFuzzyResult`
(`TreeModel.js:928-939`, matches `name` at `depth === 0` only).

- **Layer**: QML for the popups; C++ (`FuzzyFinder`) for the search engine.
- **Gotcha**: the emit-before-navigate ordering is required because `navigate()`
  is a no-op on an unchanged path, so the same-directory case never produces an
  `entriesChanged` to consume the pending name against.
- **Port**: needs design work only for the fff engine binding; the popup itself is
  mechanical.

---

## 3. The complete keybinding table

Source: `qml/Symmetria/FileManager/UI/modules/filemanager/handlers/KeyRegistry.js`.

**Counts**: 28 CORE + 20 MILLER_ONLY + 6 TREE_ONLY = **54 registry rows**.
A Miller view sees 48; a tree view sees 34.

`mods` values: `""` (exactly none), `"Ctrl"`, `"Shift"`, `"Alt"`,
`"Ctrl+Shift"`, `"*"` (ignore modifiers entirely).

**The `mods: "*"` rule is load-bearing** (`KeyRegistry.js:65-76`). Every
punctuation/symbol glyph binding MUST use `"*"`. The modifiers that PRODUCE a
glyph are layout-dependent: on the Spanish Latin-American layout `/` is `Shift+7`
and `=` is `Shift+0`, so the event arrives as `Qt.Key_Slash + ShiftModifier`. A
strict `mods: ""` match rejects it and the key silently does nothing — this is
exactly the regression that broke `/`-search when the registry landed. Letter and
real chord bindings keep precise modifiers, because there the modifier is the
user's intent.

`matchKey` (`KeyRegistry.js:487-495`) compares only
`Ctrl|Shift|Alt|Meta` — `Keypad` and `GroupSwitch` (which arrow keys may carry)
are masked out.

A row whose `when()` returns false does **NOT** consume the key. It falls
through, which is what preserves `n`/`N` fall-through and the tree's
Escape-propagates-to-close behaviour.

### 3.1 CORE — active in BOTH views (28 rows)

| # | Key(s) | Mods | keycap | id | Group | Help label | `when()` | Calls |
|---|---|---|---|---|---|---|---|---|
| 1 | `J`, `Down` | `""` | `j  ↓` | `nav.down` | Navigation | Move down | — | `view.currentIndex++` if `< count-1` |
| 2 | `K`, `Up` | `""` | `k  ↑` | `nav.up` | Navigation | Move up | — | `view.currentIndex--` if `> 0` |
| 3 | `G` | `Shift` | `G` | `nav.bottom` | Navigation | Jump to bottom | — | `currentIndex = count-1`; `positionViewAtIndex(count-1, ListView.End)` |
| 4 | `Return`, `Enter` | `""` | `⏎` | `nav.activate` | Navigation | Open / enter | — | `ctx.activateCurrent()` |
| 5 | `D` | `Ctrl` | `⌃d` | `nav.halfDown` | Navigation | Half-page down | — | `currentIndex = min(currentIndex + halfPageCount(), count-1)`; `positionViewAtIndex(…, Contain)` |
| 6 | `U` | `Ctrl` | `⌃u` | `nav.halfUp` | Navigation | Half-page up | — | `currentIndex = max(currentIndex - halfPageCount(), 0)`; `positionViewAtIndex(…, Contain)` |
| 7 | `S` | `Shift` | `⇧S` | `hist.back` | History | Back | — | `ctx.nav(() => windowState.back())` |
| 8 | `D` | `Shift` | `⇧D` | `hist.forward` | History | Forward | — | `ctx.nav(() => windowState.forward())` |
| 9 | `D` | `""` | `d` | `op.delete` | File | Trash | — | `_deleteAction` — selection if `selectedCount > 0` (then `clearSelection()`), else `currentEntry.path` |
| 10 | `R` | `""` | `r` | `op.rename` | File | Rename | — | `windowState.requestRename(currentEntry.path, false)` |
| 11 | `A` | `""` | `a` | `op.create` | File | New file / folder | — | `windowState.requestCreate(ctx.root.fileOpsTargetDir())` |
| 12 | `R` | `Ctrl` | `⌃r` | `op.pickerSaveEdit` | File | Edit save name | `fileManager.pickerSaveMode` | `fileManager.saveNameEditing = true` |
| 13 | `Y` | `""` | `y` | `clip.yank` | Clipboard | Yank (copy) | — | `_yankAction` — selection or `currentEntry` |
| 14 | `X` | `""` | `x` | `clip.cut` | Clipboard | Cut | — | `_cutAction` — selection or `currentEntry` |
| 15 | `P` | `""` | `p` | `clip.paste` | Clipboard | Paste | — | `_pasteAction` |
| 16 | `V` | `Ctrl` | `⌃v` | `clip.pasteCtrl` | Clipboard | Paste | — | `_pasteAction` |
| 17 | `Space` | `""` | `␣` | `sel.toggle` | Selection | Select / mark | — | `_toggleSelectionAction` |
| 18 | `Escape` | `""` | `Esc` | `sel.clear` | Selection | Clear selection | `windowState.selectedCount > 0` | `windowState.clearSelection()` |
| 19 | `Slash` | `*` | `/` | `search.start` | Search & jump | Search | — | `root._preSearchIndex = currentIndex`; `windowState.startSearch()` |
| 20 | `N` | `""` | `n` | `match.next` | Search & jump | Next match | `!searchActive && matchIndices.length > 0` | `windowState.nextMatch()` |
| 21 | `N` | `Shift` | `⇧N` | `match.prev` | Search & jump | Previous match | `!searchActive && matchIndices.length > 0` | `windowState.previousMatch()` |
| 22 | `S` | `""` | `s` | `flash.enter` | Search & jump | Flash jump | — | `root._preFlashIndex = currentIndex`; `ctx.invalidateFlashCache()`; `windowState.startFlash()` |
| 23 | `F` | `""` | `f` | `finder.fuzzy` | Search & jump | Fuzzy finder | — | Miller only: `saveCursor(currentPath, currentIndex)`; then `windowState.requestFuzzyFinder()` |
| 24 | `G` | `""` | `g` | `chord.go` | Chords | Go to / bookmarks… | — | `windowState.activeChordPrefix = "g"` |
| 25 | `C` | `""` | `c` | `chord.copy` | Chords | Copy to clipboard… | — | `windowState.activeChordPrefix = "c"` |
| 26 | `Comma` | `*` | `,` | `chord.sort` | Chords | Sort by… | — | `windowState.activeChordPrefix = ","` |
| 27 | `E` | `Ctrl` | `⌃e` | `view.toggle` | View | Toggle Miller / tree view | — | `windowState.toggleViewMode()` |
| 28 | `Question` | `*` | `?` | `help.open` | Help | Keyboard help | — | `windowState.openHelp()` |

### 3.2 MILLER_ONLY (20 rows)

| # | Key(s) | Mods | keycap | id | Group | Help label | `when()` | Calls |
|---|---|---|---|---|---|---|---|---|
| 1 | `H`, `Left` | `""` | `h  ←` | `miller.up` | Navigation | Up a directory | — | `ctx.nav(() => windowState.goUp())` |
| 2 | `L`, `Right` | `""` | `l  →` | `miller.into` | Navigation | Enter directory | — | `root._navigateIntoCurrentItem()` (no-op unless `currentEntry.isDir`) |
| 3 | `Return`, `Enter` | `Ctrl` | `⌃⏎` | `miller.contextMenu` | Navigation | Context menu | — | if `currentEntry && !isDir`: `windowState.requestContextMenu(path, mimeType)` |
| 4 | `Return`, `Enter` | `Shift` | `⇧⏎` | `miller.shiftEnter` | Navigation | Open (copy path in picker) | — | picker: `NormalModeHandler._copyPickerPathToClipboard(…, cb = _activateCurrentItem)`; else `_activateCurrentItem()` |
| 5 | `Tab` | `""` | `⇥` | `miller.tabBoundary` | Navigation | Jump dir / file boundary | — | `NormalModeHandler._jumpToDirFileBoundary(root, view)` |
| 6 | `Escape` | `""` | `Esc` | `miller.escapeSwallow` | Navigation | Dismiss | — | empty body — swallows a stray Escape so it does not propagate |
| 7 | `AsciiTilde` | `*` | `~` | `miller.home` | History | Go home | — | `ctx.nav(() => windowState.navigate(Paths.home))` |
| 8 | `Minus` | `*` | `-` | `miller.back` | History | Back | — | `ctx.nav(() => windowState.back())` |
| 9 | `Equal` | `*` | `=` | `miller.forward` | History | Forward | — | `ctx.nav(() => windowState.forward())` |
| 10 | `R` | `Shift` | `⇧R` | `miller.renameExt` | File | Rename (with extension) | — | `windowState.requestRename(currentEntry.path, true)` |
| 11 | `Period` | `*` | `.` | `miller.toggleHidden` | View | Toggle hidden files | — | `Config.fileManager.showHidden = !…`; `Config.save()` |
| 12 | `R` | `Ctrl` | `⌃r` | `miller.htmlRender` | View | Render HTML preview | `!!currentEntry && fileManager.isHtmlFile(currentEntry.mimeType)` | `windowState.toggleHtmlRender()` |
| 13 | `Z` | `""` | `z` | `miller.zoxide` | Search & jump | Zoxide jump | — | `saveCursor(currentPath, currentIndex)`; `windowState.requestZoxide()` |
| 14 | `P` | `Ctrl` | `⌃p` | `miller.audioToggle` | Tools | Play / pause audio | — | `windowState.audioPlaybackToggle()` |
| 15 | `T` | `""` | `t` | `miller.tabNew` | Tabs | New tab | — | `tabManager.createTab(windowState.currentPath)` |
| 16 | `Q` | `Ctrl` | `⌃q` | `miller.tabClose` | Tabs | Close tab | — | `saveCursor(…)`; `if (!tabManager.closeTab(activeIndex)) root.closeRequested()` |
| 17 | `BracketLeft` | `*` | `[` | `miller.tabPrev` | Tabs | Previous tab | — | `tabManager.prevTab()` |
| 18 | `BracketRight` | `*` | `]` | `miller.tabNext` | Tabs | Next tab | — | `tabManager.nextTab()` |
| 19 | `Tab` | `Ctrl` | `⌃⇥` | `miller.tabNextCtrl` | Tabs | Next tab | — | `tabManager.nextTab()` |
| 20 | `Backtab` | `Ctrl+Shift` | `⌃⇧⇥` | `miller.tabPrevCtrl` | Tabs | Previous tab | — | `tabManager.prevTab()` |

Note the deliberate `Ctrl+R` precedence: `op.pickerSaveEdit` (CORE, index 12) is
scanned BEFORE `miller.htmlRender` (MILLER_ONLY, index 12) because `bindingsFor`
returns `CORE.concat(MILLER_ONLY)`. In a save picker the save-name edit wins; on
a non-HTML file `miller.htmlRender`'s `when()` is false so `Ctrl+R` falls through
entirely.

### 3.3 TREE_ONLY (6 rows)

| # | Key(s) | Mods | keycap | id | Group | Help label | `when()` | Calls |
|---|---|---|---|---|---|---|---|---|
| 1 | `H`, `Left` | `""` | `h  ←` | `tree.collapseOrParent` | Navigation | Collapse / parent | — | expanded dir → `TreeModel.collapse(root, path)`; else `TreeModel.jumpToParent(root)` |
| 2 | `L`, `Right` | `""` | `l  →` | `tree.expandOrActivate` | Navigation | Expand / open | — | dir not expanded → `TreeModel.expand`; dir expanded → `currentIndex++`; file → `root.fileActivated(path)` |
| 3 | `O` | `""` | `o` | `tree.toggleExpand` | Navigation | Toggle expand | — | dirs only: `TreeModel.toggle(root, path)` |
| 4 | `H` | `Shift` | `⇧H` | `tree.toggleHidden` | View | Toggle hidden files | — | `root.showHiddenToggleRequested()` |
| 5 | `Period` | `*` | `.` | `tree.toggleGitignore` | View | Toggle .gitignore filter | — | `root.respectGitignore = !root.respectGitignore` |
| 6 | `R` | `Shift` | `⇧R` | `tree.refreshAll` | View | Refresh tree | — | `TreeModel.refreshAll(root)` |

### 3.4 Help metadata contract

- `HELP_GROUPS` (`KeyRegistry.js:455-456`) is the canonical section order:
  `["Navigation", "History", "File", "Clipboard", "Selection", "Search & jump",
  "Chords", "View", "Tabs", "Tools", "Help"]`.
- `HelpPopup` filters `"Chords"` out and renders the expanded chord tree from
  `windowState.chordBindings` instead (`HelpPopup.qml:65, 92-112`).
- `MODES` (`KeyRegistry.js:460-464`) are three static, non-executable help rows
  for the text-input modes:

| keycap | label | icon |
|---|---|---|
| `s` | Flash jump — type letters to jump, Esc cancels | `bolt` |
| `/` | Search — type to filter, n/N to cycle, Enter confirms | `search` |
| `gn / gx` | Bookmarks — assign / delete with a letter | `bookmark` |

`plugin/tests/tst_keyregistry.qml` FAILS the build if a row lacks any of
`id / keys / mods / keycap / label / icon / group / run`, uses a `mods` value
outside the allowed set, uses a group outside `HELP_GROUPS`, has a duplicate
`id`, or collides on `(key, mods)` with another unconditional row in the same
view.

### 3.5 Chords

Chords are NOT registry rows. A registry row sets
`windowState.activeChordPrefix`; RESOLUTION happens in the outer cascade via
`ChordHandler.resolveChord` (`ChordHandler.js:48-68`).

**There is NO chord timeout in the file-manager path.** `activeChordPrefix`
persists until the next non-modifier key arrives, or until the view loses focus
(`FileList.qml:404-411`, `FileTreeView.qml:471-478`), or until a tab switch
(`FileList.qml:86-87`). The only 500 ms chord timer in the codebase is `ggTimer`
in `FileTreeView.qml:347-351`, and it serves ONLY the windowState-less embedded
tree.

Resolution rules (`ChordHandler.js:48-68`):
- Bare Shift/Ctrl/Alt/Meta are swallowed and do not resolve the chord.
- The prefix is cleared unconditionally before dispatch.
- `Escape` cancels without executing.
- Case handling: for the `,` prefix the RAW `event.text` is used (case is the
  ascending/descending signal); for every other prefix the text is lowercased.
- All current prefixes are considered safe in picker mode — no destructive chord
  exists yet.

#### `g` — "go to"

Static binds from `WindowState._staticChordBindings` (`WindowState.qml:198-224`)
plus the merged user bookmarks (`WindowState.chordBindings`, `WindowState.qml:227-266`).

| Chord | Label | Icon | Handler | Notes |
|---|---|---|---|---|
| `gg` | Top | `vertical_align_top` | `ChordHandler.js:75-78` | `currentIndex = 0`, `positionViewAtIndex(0, Beginning)` |
| `gn` | New bookmark | `bookmark_add` | `ChordHandler.js:80` | enters `bookmarkSubMode = "create"` |
| `gx` | Delete bookmark | `bookmark_remove` | `ChordHandler.js:82` | enters `bookmarkSubMode = "delete"` |
| `g<letter>` | user bookmark label | `iconForPath(path)` | `ChordHandler.js:86-89` | `_saveCursorAndNavigate(navigate(bookmarkPath))`; unknown letter = silent no-op |
| `gh` (default) | Home | `home` | seeded bookmark | deletable |
| `gd` (default) | Downloads | `download` | seeded bookmark | deletable |

`chordBindings` merge rules (`WindowState.qml:227-266`):
- shallow-clone the map and slice the `g` binds array so `_staticChordBindings`
  is never mutated;
- `usedKeys` is seeded from `BookmarkService._reservedKeys` plus the existing
  static binds;
- a bookmark on a used key REPLACES the matching static row rather than
  appending;
- a separator row is appended, then the `gn` and `gx` action rows, always last.

#### `c` — "copy to clipboard"

| Chord | Label | Icon | Behaviour |
|---|---|---|---|
| `cc` | File path | `link` | selection → `paths.join("\n")`; else `currentEntry.path` |
| `cf` | Filename | `description` | selection → basenames joined by newline; else `currentEntry.name` |
| `cn` | Name without extension | `label` | as `cf` with `_stripExtension` (strips from the LAST `.`, and only if `dotIndex > 0` — a dotfile keeps its name) |
| `cd` | Directory path | `folder` | `windowState.currentPath` — **ignores selection entirely** |
| `ci` | Copy image | (gated) | copies the hovered image's BYTES, not its path |

`ci` is inserted by `services/ImageChord.js` → `copyGroupWithImageRow`, gated on
`windowState.currentEntryIsImage`, which the active view keeps in sync via
`windowState.syncImageCursor(entry)`. Three sync triggers are needed:
`onCurrentEntryChanged`, `onWindowStateChanged` (tab switch), and
`Component.onCompleted` (the initial value does not fire the change handler).

`ci` guards (`ChordHandler.js:103-124`): rejects a non-image with "Not an image",
and rejects an image whose `mimeType` does not start with `image/` with "Can't
copy this image format" — `isImage` is a content sniff independent of MIME, so an
`.rpgmvp` is `isImage` but carries `application/octet-stream`.

Every `c` chord bails early if `clipboardCopyProcess.running`, and bails if there
is neither a selection nor a `currentEntry`.

#### `,` — "sort by"

`ChordHandler.js:166-183`. Lowercase = ascending (`sortReverse = false`),
uppercase = descending (`sortReverse = true`). The reverse test is
`keyChar === keyChar.toUpperCase()`.

| Chord | `sortBy` | Enum value | Label | Icon |
|---|---|---|---|---|
| `,a` / `,A` | `FileSystemModel.Alphabetical` | 0 | Alphabetical | `sort_by_alpha` |
| `,m` / `,M` | `FileSystemModel.Modified` | 1 | Modified date | `schedule` |
| `,s` / `,S` | `FileSystemModel.Size` | 2 | Size | `straighten` |
| `,e` / `,E` | `FileSystemModel.Extension` | 3 | Extension | `extension` |
| `,n` / `,N` | `FileSystemModel.Natural` | 4 | Natural | `format_list_numbered` |

An unmapped letter is a silent no-op.

**Total chord combinations**: 3 prefixes; `g` = 3 built-ins + N bookmarks (2 by
default) = 5 by default; `c` = 5 (4 always + `ci` gated); `,` = 10 (5 keys × 2
cases). **20 chord invocations by default.**

#### Bookmark sub-mode

`ChordHandler.handleBookmarkSubMode` (`ChordHandler.js:8-45`). Entered by `gn` or
`gx`, exited on the very next key.

- bare modifiers: swallowed, sub-mode stays active;
- `Escape`: cancel;
- a single `[a-z]` character:
  - create: reject with `"'x' is reserved"` if
    `BookmarkService.isReservedKey(letter)`; else show
    `"Bookmark 'x' → ~/path"` and `addBookmark`;
  - delete: `"Bookmark 'x' deleted"` or `"No bookmark on 'x'"`;
- any other key (digit, Return, …): cancel silently.

Messages go through `WindowState.showTransientMessage(msg)`
(`WindowState.qml:188-191`), which sets `transientMessage` and restarts a 2000 ms
one-shot `Timer` created with `Qt.createQmlObject`. The property is typed `var`
rather than `Timer` on purpose — `Qt.createQmlObject` is typed as returning
`QObject`, which trips qmllint's incompatible-type check.

- **Layer**: QML/JS only.
- **Gotcha**: `chordBindings` is a `readonly property var` computed expression. It
  depends on `BookmarkService.bookmarks` and `currentEntryIsImage`, so it
  re-evaluates on every bookmark write and every cursor move onto/off an image.
- **Port**: mechanical. A prefix-state string in the store plus a lookup table.

### 3.6 Which-key HUD

`WhichKeyPopup.qml`. `opacity: chordActive || bookmarkSubModeActive ? 1 : 0`,
animated. `_binds` (`WhichKeyPopup.qml:10-31`):
- `bookmarkSubMode === "delete"` → only user bookmarks, sorted by key
  (`localeCompare`);
- `bookmarkSubMode === "create"` → empty list, header prompt only;
- otherwise `chordBindings[activeChordPrefix].binds`.

Header shows a keycap badge (`gn` / `gx` / the prefix) and the group label
("go to" / "copy to clipboard" / "sort by"), or, in create mode,
`"assign letter for ~/path"`.

Rows render keycap badge, Material icon, and label. User bookmarks get a
`primary`-tinted badge; `isAction` rows (`gn`, `gx`) render at 0.6 alpha;
`isSeparator` rows render a 1 px `overlay.subtle` line instead.

Placement differs: Miller shows it over the parent column
(`MillerColumns.qml:78-82`), tree shows it over the tree card
(`FileManager.qml:126-130`).

### 3.7 Keys handled OUTSIDE the registry

| Key | Where | Effect |
|---|---|---|
| any key while a modal is open | `FileList.qml:374-378`, `TreeKeyHandler.js:27-30` | swallowed (`event.accepted = true`) |
| any key in bookmark sub-mode | `ChordHandler.handleBookmarkSubMode` | consumed |
| any key with an active chord prefix | `ChordHandler.resolveChord` | consumed |
| `Ctrl+E` in the tree | `TreeKeyHandler.js:46-50` | `toggleViewMode()` — runs BEFORE flash |
| any key in flash mode | `FlashHandler` / `TreeFlashHandler` | consumed |
| search-mode keys | `StatusBar.searchInput.Keys.onPressed` (`StatusBar.qml:326-342`) | `Enter` confirms, `Escape` cancels, `Down`/`Up` cycle matches |
| save-name edit keys | `StatusBar.saveNameInput.Keys.onPressed` (`StatusBar.qml:211-227`) | `Enter` confirm+save, `Escape` revert, `Tab` toggles basename/full selection |
| `Escape` / `?` in the help popup | `HelpPopup.qml:42-46` | close; everything else swallowed |
| popup navigation (`Escape`, `Enter`, `Down`/`Ctrl+J`, `Up`/`Ctrl+K`) | `ZoxidePopup.qml:137-153`, `FuzzyFinderPopup.qml:160-180` | move / confirm / cancel |
| everything in the embedded tree | `TreeKeyHandler.js:86-238` legacy switch | see §4.5 |

---

## 4. Dispatch cascade and precedence

### 4.1 Miller cascade — `FileList.qml:373-402`

```
ListView.Keys.onPressed(event):
  1. activeModal !== modalNone            → event.accepted = true; RETURN (swallow)
  2. bookmarkSubModeActive                → ChordHandler.handleBookmarkSubMode; RETURN
  3. activeChordPrefix !== ""             → ChordHandler.resolveChord;          RETURN
  4. flashActive                          → FlashHandler.handleKey;             RETURN
  5. NormalModeHandler.handleKey → KeyRegistry.dispatch
```

### 4.2 Tree cascade — `TreeKeyHandler.handleKey`, `TreeKeyHandler.js:17-81`

```
  1. windowState && activeModal !== modalNone → swallow; RETURN
  2. windowState && bookmarkSubModeActive     → ChordHandler.handleBookmarkSubMode; RETURN
  3. windowState && activeChordPrefix !== ""  → ChordHandler.resolveChord;          RETURN
  4. Ctrl+E                                   → toggleViewMode();  accepted;        RETURN
  5. windowState && flashActive               → TreeFlashHandler.handleKey;         RETURN
  6. windowState                              → KeyRegistry.dispatch;               RETURN
  7. (no windowState)                         → legacy navigation-only switch
```

Step 4 is the only structural difference from Miller: the tree resolves `Ctrl+E`
before flash. (Miller's `Ctrl+E` is the CORE `view.toggle` row, reached at step 5.)

**Load-bearing rule** (stated in `KeyRegistry.js:26-37`): chord resolution must
run in the cascade BEFORE `dispatch`'s internal picker-suppression pre-pass. If
it did not, a chord like `g` then `d` would break, because `d` is a
picker-suppressed key and would be eaten before the chord resolver saw it. Do NOT
move chord resolution into the registry.

### 4.3 Inside `KeyRegistry.dispatch` — `KeyRegistry.js:574-587`

```
  a. isBareModifier(event)                    → return false (NOT consumed)
  b. fileManager.pickerMode && _pickerPrePass → return true  (consumed)
  c. matchBinding(event, ctx)
       - iterate bindingsFor(viewKind) = CORE.concat(MILLER_ONLY | TREE_ONLY)
       - skip if !matchKey(b, event)
       - skip if b.when && !b.when(ctx)        ← a false when() does NOT consume
       - first match wins
  d. no match                                 → return false (NOT consumed)
  e. b.run(ctx); event.accepted = true        → return true
```

Consequence: CORE always beats a view-specific row on the same `(key, mods)`, and
within a list the first declared row wins.

### 4.4 Picker pre-pass — `_pickerPrePass`, `KeyRegistry.js:516-541`

Runs only when `fileManager.pickerMode` is true.

1. `Escape`:
   - if `pickerMultiple && selectedCount > 0` → `clearSelection()`;
   - else → `cancelPickerMode()`;
   - always consumed.
2. if NOT `pickerFileOps`:
   - `_PICKER_SUPPRESSED_KEYS = [Y, X, P, Space, T, BracketLeft, BracketRight]`
     are consumed and dropped, with two exemptions:
     - `Space` when `pickerMultiple` (marking before confirm);
     - `P` when `Ctrl` is held (audio toggle) — only bare `p` (paste) is
       suppressed;
   - `Ctrl+V` is consumed and dropped separately.
3. otherwise fall through to the binding scan.

`Key_C` is deliberately absent from the suppressed list — it starts the harmless
copy-path chord.

`pickerFileOps` is the opt-in escape hatch for an embedding host (the Symmetria
IDE) that wants a FULL file manager riding the picker's open/cancel routing
(`FileManagerService.qml:89-97`).

`isSuppressedInPicker(binding, fileManager)` (`KeyRegistry.js:547-568`) mirrors
these exemptions EXACTLY so the `?` cheat-sheet never advertises a key that is
currently suppressed, and never hides one that still works.

### 4.5 Embedded tree path (no `windowState`)

`TreeKeyHandler.js:86-238`. This bypasses the registry entirely and is the
authoritative handler for the IDE sidebar. Supported keys:

| Key | Effect |
|---|---|
| `j` / `Down` | cursor down |
| `k` / `Up` | cursor up |
| `Shift+G` | last row |
| `g` `g` within 500 ms (`ggTimer`) | first row |
| `h` | collapse expanded dir, else jump to parent row |
| `Shift+H` | `showHiddenToggleRequested()` |
| `Left` | collapse / jump to parent (no Shift branch) |
| `l` / `Right` | expand dir / move down if expanded / `fileActivated` |
| `Return` / `Enter` | `TreeModel.activate` |
| `Ctrl+D` / `Ctrl+U` | half page |
| `o` | toggle expand |
| `Shift+R` | `TreeModel.refreshAll` |
| `.` | toggle `respectGitignore` |

The `Shift+D`, `/`, `s`, `Shift+S`, `n`, `Shift+N`, and `f` cases in that switch
are all guarded by `if (root.windowState)` and are therefore **dead code** on the
embedded path — they are only reachable if the switch is ever entered with a
windowState, which the step-6 early return prevents.

### 4.6 Escape priority stack

Last-entered-first-exited, as actually implemented:

| Priority | Condition | Handler | Effect |
|---|---|---|---|
| 1 | a modal is open | popup's own `Keys.onPressed` (the view swallows anything that leaks) | close the modal |
| 2 | bookmark sub-mode | `ChordHandler.handleBookmarkSubMode` | cancel sub-mode |
| 3 | chord prefix active | `ChordHandler.resolveChord` | cancel the chord without executing |
| 4 | flash active | `FlashHandler` / `TreeFlashHandler` | restore `_preFlashIndex`, `clearFlash()` |
| 5 | picker mode, multiple, marks present | `_pickerPrePass` | `clearSelection()` |
| 6 | picker mode, otherwise | `_pickerPrePass` | `cancelPickerMode()` |
| 7 | `selectedCount > 0` | `sel.clear` (CORE) | `clearSelection()` |
| 8 | Miller | `miller.escapeSwallow` | swallow, nothing happens |
| 8' | tree | (no binding) | falls through to the host's close-window handling |

**Search is NOT in this stack.** During search the `TextInput` in the StatusBar
holds active focus, so the view's `Keys.onPressed` never sees the key.
`StatusBar.qml:331-334` handles `Escape` by emitting `searchCancelled()` then
`clearSearch()`. `CLAUDE.md` lists Escape priority as "chord → search → flash →
picker → close window"; the real mechanism for search is focus, not a cascade
step, and flash sits ABOVE picker.

- **Layer**: QML/JS only.
- **Gotcha**: the search TextInput steals focus, so restoring focus is explicit
  everywhere. `onSearchCancelled`, `onSearchConfirmed`, and
  `onActiveModalChanged` all call `Qt.callLater(() => view.forceActiveFocus())`
  (`FileList.qml:161-185`, `FileTreeView.qml:359-382`). The comment at
  `FileTreeView.qml:372-378` explains why: popups are top-level `Loader`s at
  `FileManager` scope, outside the view's `FocusScope`, so closing one leaves
  focus orphaned and the keyboard appears dead.
- **Port**: mechanical for the cascade, needs design work for focus. A React port
  should keep ONE keydown listener at the window level plus an explicit mode
  stack, rather than relying on DOM focus, because DOM focus does not give you
  the "swallow everything while a modal is open" guarantee for free.

---

## 5. Selection model

### 5.1 Data shape

`WindowState.qml:271-296`:

```qml
property var selectedPaths: ({})   // { "/abs/path": true, ... }
property int _selectionCount: 0
readonly property int selectedCount: _selectionCount
```

Selection stores **absolute paths**, not indices, so it **persists across
directory changes**. It is cleared only explicitly.

### 5.2 Immutable-update convention

```qml
function toggleSelection(path) {
    const copy = Object.assign({}, selectedPaths);
    if (copy[path]) { delete copy[path]; _selectionCount--; }
    else            { copy[path] = true; _selectionCount++; }
    selectedPaths = copy;              // reassignment triggers bindings
}
```

Mutating `selectedPaths[path] = true` in place does NOT fire the property notify
signal, so no binding re-evaluates. Every delegate binding reads `selectedPaths`
in its expression precisely to register the object-reference dependency
(`FileList.qml:361-362`).

`_selectionCount` is an explicit counter rather than `Object.keys(...).length`
because both `StatusBar` and `FileList` bind to `selectedCount`, and
`Object.keys` would allocate a temporary array on every read.

`clearSelection()` sets `selectedPaths = {}` and `_selectionCount = 0`.
`getSelectedPathsArray()` returns `Object.keys(selectedPaths)`.

### 5.3 Toggle behaviour — `_toggleSelectionAction`, `KeyRegistry.js:132-146`

1. no-op if `!root.currentEntry`;
2. **picker type-filter**: if `pickerMode && !pickerSaveMode && !pickerFileOps &&
   pickerDirectory !== currentEntry.isDir` → refuse. A file picker marks only
   files; a directory picker marks only directories;
3. `windowState.toggleSelection(currentEntry.path)`;
4. advance the cursor one row if not already at the last row.

### 5.4 There is NO visual mode

The PRD specifies `v` / `V` visual mode (`PRD.md:360-367`). None was implemented.
`Space`-toggled multi-select is the only multi-selection mechanism. No range
select, no `Shift+click`, no `Ctrl+click`.

### 5.5 Rendering

`FileListItem.qml`:

| Layer (bottom to top) | Rule |
|---|---|
| search-match tint | `Rectangle`, `radius: rounding.full`, `color: palette.onSurface`, `opacity: isSearchMatch ? 0.06 : 0`, `Behavior on opacity { Anim {} }` |
| current-item highlight | `Rectangle`, `radius: rounding.full`, `color: FmTheme.pillStrong.background`, `border.color: FmTheme.pillStrong.border`, `border.width` and `opacity` gated on `ListView.isCurrentItem` |
| clipboard indicator strip | `IndicatorStrip`, left edge, 5 px, `FmTheme.indicator.cut` (`#e57373`) or `.yank` (`#4caf7d`) depending on `clipboardMode`, active from `FileManagerService._clipboardSet[path]` |
| selection indicator strip | `IndicatorStrip`, left edge, `FmTheme.indicator.selection` (`#f0c674`), active from `isSelected` — drawn ABOVE the clipboard strip so selection wins visually |
| `StateLayer` | hover / click; single click sets `ListView.view.currentIndex`, double click emits `activated()` |
| content `RowLayout` | `opacity: flashActive && !isFlashMatch ? 0.25 : 1.0` |

`IndicatorStrip.qml` is a 5 px clipped `Item` containing a Rectangle wider than
its parent by `FmTheme.rounding.sm`, so only the LEFT corners read as rounded.
`opacity: active ? 0.85 : 0` with an `Anim` behaviour.

`FileTreeRow.qml` mirrors this with two differences: the current-item highlight
uses `palette.secondaryContainer` at `opacity 0.35` with `radius: rounding.sm`,
and the search-match tint uses `palette.primary` at `0.08`. The tree row reads
`windowState.selectedPaths` DIRECTLY rather than taking a bound `isSelected`
input, because it already holds a `windowState` reference
(`FileTreeRow.qml:213-220`).

**There is NO zebra striping in either view.** Both files carry a prominent
comment saying it was removed by user decision with the flat-aesthetic move, and
that the `overlay.zebra` token was retired with it. Restoring it is a revert of
one commit; change both files together or neither.

**Performance constraint** stated in both files: the current-item highlight is a
plain `Rectangle` with NO gradient and NO `Behavior`, because a per-delegate
colour animation or a GPU shadow node causes visible stutter during rapid j/k
navigation. `FileListItem.qml:114-131` records that an inlined claymorphism rim
gradient survived the flat-aesthetic sweep precisely because it was inlined for
that performance reason and therefore invisible to the shared-token change.

- **Layer**: QML only.
- **Gotcha**: the state layers are stacked `Rectangle`s with independent
  opacity, not mutually exclusive classes. A row can simultaneously be the
  current item, a search match, selected, and in the clipboard — and all four
  cues render together.
- **Port**: trivial for the data model; mechanical for rendering. The stutter
  constraint translates directly: do not put a CSS `transition` on a virtualised
  row's background colour.

---

## 6. Search, filter, sorting, hidden files

### 6.1 Incremental search (`/`)

State on `WindowState` (`WindowState.qml:75-114`):

| Property | Meaning |
|---|---|
| `searchActive` | the input has focus |
| `searchQuery` | the raw typed string |
| `matchIndices` | array of ROW INDICES that match, in row order |
| `currentMatchIndex` | index INTO `matchIndices` (not a row index) |
| `_matchIndexSet` | `readonly`, derived `{index: true}` map for O(1) delegate lookups |

`startSearch()` calls `clearSearch()` and `clearFlash()` first, then sets
`searchActive = true`.

Matching is a **case-insensitive substring on `name`** — not fuzzy, not a regex,
not a filter. Non-matching rows stay visible; they are simply not tinted.

- Miller: `SearchHandler.computeMatches(root, view, preservePosition)`
  (`SearchHandler.js:8-40`) over `fsModel.entries`.
- Tree: `TreeModel.computeMatches(root, preservePosition)`
  (`TreeModel.js:864-895`) over `root._rows` — visible rows only.

`preservePosition` semantics: `false` (a keystroke in the input) resets
`currentMatchIndex` to 0; `true` (a model reload or a row rebuild) tries to keep
the cursor's current row selected by looking it up in the new `matchIndices`,
falling back to 0.

**`computeMatches` always calls `jumpToCurrentMatch` at the end**, even when
`currentMatchIndex` did not change numerically. The `onChanged` signal will not
fire on 0→0, but the target row is different because `matchIndices` changed.
Removing that call is a known regression.

`jumpToCurrentMatch` (`SearchHandler.js:42-49`) is shared by both views — it takes
`root` and `view` and reads `root.windowState`, so it is source-agnostic.

Cycling: `nextMatch()` / `previousMatch()` wrap modulo `matchIndices.length`
(`WindowState.qml:104-114`).

UI (`StatusBar.qml:299-378`): a `/` prefix glyph, a `TextInput` bound bi-directionally
to `searchQuery` through a `_suppressTextSync` guard, and a counter reading
`"<currentMatchIndex+1>/<matchIndices.length>"`, or `"No matches"` in
`palette.error` when the query is non-empty and there are none.

Search-hit rendering: `FileListItem._highlightMatches` (`FileListItem.qml:18-39`)
rewrites the name as rich text, wrapping EVERY occurrence of the query in a
`secondaryContainer`/`onSecondaryContainer` span, HTML-escaping the rest through
`handlers/HighlightUtils.js`. The delegate flips `textFormat` between
`Text.RichText` and `Text.PlainText` and disables eliding while highlighted.

- **Layer**: QML/JS only.
- **Gotcha 1**: `_preSearchIndex` is saved when `/` is pressed and restored on
  cancel, so Escape returns the cursor to where it was.
- **Gotcha 2**: the search input is a rich-text rewrite, not a `<mark>` — the
  delegate must switch text mode, because rich text disables `elide` and forces
  `clip`.
- **Port**: trivial for the matching, mechanical for the highlight.

### 6.2 There is NO filter mode

Nothing hides rows based on the query. `FileSystemModel` DOES expose a
`Filter` enum (`NoFilter`, `Images`, `Files`, `Dirs`) and a `nameFilters`
`QStringList` (`filesystemmodel.hpp:169-175, 153-154`), but the file manager UI
never sets either — they exist for other consumers (Symmetria Shell's wallpaper
grid uses `Images`).

### 6.3 Sorting

Enum: `FileSystemModel::SortBy` (`filesystemmodel.hpp:160-167`) —
`Alphabetical(0)`, `Modified(1)`, `Size(2)`, `Extension(3)`, `Natural(4)`.

`WindowState` stores `sortBy` as a plain `int` (default **1 = Modified**) and
`sortReverse` as a `bool` (default **true**) so it does not depend on the C++
plugin module (`WindowState.qml:151-158`). The C++ class's own defaults differ
(`m_sortBy = Natural`, `m_showHidden = false`, `filesystemmodel.cpp:285-287`),
but QML always drives them.

`sortLabel` is `_sortLabels[sortBy]` where
`_sortLabels = ["Alphabetical", "Modified", "Size", "Extension", "Natural"]` —
index-aligned to the enum by hand.

**Comparison rule** — `FileSystemModel::compareEntries`, `filesystemmodel.cpp:910-953`:

```cpp
// Directories ALWAYS sort before files, regardless of sort direction.
if (a->isDir() != b->isDir()) return a->isDir();
```

Then, per mode, producing an `int cmp`:

| Mode | Primary comparison | Tie-break |
|---|---|---|
| `Alphabetical` | `a->relativePath().localeAwareCompare(b->relativePath())` | none |
| `Modified` | `a->modifiedDate()` vs `b->modifiedDate()` | `localeAwareCompare` on `relativePath` |
| `Size` | `a->size()` vs `b->size()` | `localeAwareCompare` on `relativePath` |
| `Extension` | `a->suffix().localeAwareCompare(b->suffix())` | `localeAwareCompare` on `relativePath` |
| `Natural` | `QCollator` with `setNumericMode(true)` and `setCaseSensitivity(Qt::CaseInsensitive)`, `thread_local` static | none |

Final step: `return m_sortReverse ? cmp > 0 : cmp < 0;`

Sorting runs on the GUI thread in `resort()` (`filesystemmodel.cpp:495-497`) via
`std::sort`.

- **Layer**: C++ for the comparison; QML for the state and the label.
- **Gotcha 1**: comparisons are on `relativePath()`, not `name()`. For a
  non-recursive listing they are equal, but in `recursive: true` mode they are
  not — a recursive consumer sorts by relative path.
- **Gotcha 2**: `localeAwareCompare` is locale-dependent. A JS port must decide
  between `Intl.Collator` (closest) and a plain `<` (wrong for accents).
  `Natural` maps to `new Intl.Collator(undefined, {numeric: true, sensitivity: "base"})`.
- **Gotcha 3**: the dirs-first rule is NOT reversed by `sortReverse`. Descending
  Size still puts directories on top.
- **Port**: mechanical.

### 6.4 Hidden files

`Config.fileManager.showHidden` — a global singleton property, **default `true`**
(`config/FileManagerConfig.qml:4`). It is bound into `fsModel.showHidden`
(`FileList.qml:290`), `parentModel.showHidden` (`ParentPanel.qml:69`), and
`FileTreeView.showHidden` (`FileManager.qml:116`).

C++ side (`filesystemmodel.cpp:462-483, 685-705`): `showHidden` adds
`QDir::Hidden` to the `QDir::Filters`. The base filters are
`QDir::Dirs | QDir::Files | QDir::NoDotAndDotDot` for `NoFilter`.

Tree side (`TreeModel.rebuildRows`, `TreeModel.js:722`): `TreeModel.isHidden(name)`
filters rows in JS — the tree's per-directory models are created without an
explicit `showHidden` in most paths, so hiding happens at row-build time.
`onShowHiddenChanged: TreeModel.refreshAllExpanded(root)` rebuilds everything.

Toggles: `.` in Miller, `Shift+H` in the tree (which emits
`showHiddenToggleRequested()` and lets `FileManager.qml:119` flip the config), and
the PathBar's eye icon.

- **Layer**: both.
- **Gotcha**: the C++ worker captures `showHidden` by value at scan start and, in
  the recursive-listing helper, re-checks `showHidden == m_showHidden` before
  applying the result (`filesystemmodel.cpp:477-481`), discarding a scan whose
  flag changed mid-flight.
- **Port**: trivial, except that `Config.save()` is a no-op — see §2.5.

### 6.5 Directory watching semantics (what drives live updates)

Two documented `QFileSystemWatcher` pitfalls the C++ model works around. A port
must reproduce the BEHAVIOUR, not the workaround.

1. **Atomic replace drops the watch.** `FileWatcher` (used for `bookmarks.json`
   and `color-scheme.json`) watches both the file AND its parent directory and
   re-arms with `removePath; addPath` on every change signal, plus a 100 ms
   `QTimer` retry. Regression test: `atomicReplaceTenTimes`.
2. **Directory watches are deaf to in-place content writes.** Qt's directory
   inotify mask omits `IN_MODIFY` / `IN_CLOSE_WRITE`, so a file that GROWS after
   it was first listed emits no `directoryChanged`. The symptom was a streamed
   download (`curl -O`, `wget`, `yt-dlp`) stuck at 0 bytes with no preview.
   Fix: `syncFileWatches()` adds a per-file watch (non-recursive only, capped at
   `kMaxFileWatches = 2048`) so `fileChanged` fires on growth, debounced by
   `m_fileChangedDebounce` into a rescan; and the background diff compares
   `(size, mtime)` per path, rebuilding same-path changes as remove+add so
   entries stay immutable snapshots (`filesystemmodel.cpp:652-767`).
   Regression test: `growingFileRefreshesSize`.
   Known limitation: an in-place overwrite to the SAME size within the same mtime
   tick is not detected.

`FileSystemEntry` is an **immutable snapshot** — its `QFileInfo` is stat'd once at
construction and every property is `CONSTANT` except `relativePath`. This is why
a changed file is modelled as remove + add.

- **Layer**: C++ only.
- **Port**: needs design work. Node's `fs.watch` has the same inotify limitations
  plus platform inconsistency; `chokidar` with `awaitWriteFinish` is the usual
  answer but changes the timing contract.

---

## 7. Tabs and windows

### 7.1 Ownership graph

```
Window (host/standalone/main.qml)
 └─ FileManager.qml                       one per window
     ├─ TabManager                        one per window
     │   └─ tabs: [WindowState, …]        one WindowState per tab
     ├─ TabBar          (windowState-free; reads tabManager)
     ├─ PathBar         (windowState = tabManager.activeTab)
     ├─ Loader → MillerColumns | tree card
     ├─ StatusBar       (windowState = tabManager.activeTab)
     └─ 7 modal popups  (windowState = tabManager.activeTab)
```

Global singletons shared by ALL windows and tabs:
`FileManagerService` (clipboard, picker mode, formatting utilities),
`BookmarkService`, `Config`, `FmTheme`, `Logger`, `Paths`.

Per-tab state (`WindowState`): navigation + history + cursor cache, search, flash,
sort, chord prefix, bookmark sub-mode, transient message, selection, active
modal + modal payloads, HTML render flag, view mode.

- **Gotcha**: the clipboard is GLOBAL. Yanking in one tab and pasting in another,
  or in another window, works by design.

### 7.2 TabManager — `services/TabManager.qml`

| Member | Notes |
|---|---|
| `tabs: []` | array of `WindowState` objects |
| `activeIndex: 0` | |
| `activeTab` | `tabs.length > 0 ? tabs[activeIndex] : null` |
| `count` | `tabs.length` |
| `showBar` | `count > 1` — the tab bar is hidden with a single tab |
| `aboutToSwitchTab()` | signal emitted BEFORE `activeIndex` changes |

`createTab(path)`:
- stamps a `WindowState` from `_windowStateComponent` with both `initialPath` AND
  `currentPath` set;
- inserts **right after the active tab**, not at the end;
- emits `aboutToSwitchTab()` if there was already more than one tab;
- sets `activeIndex = insertIndex`.

`closeTab(index) -> bool`:
- returns `true` for an out-of-range index (nothing to close, but do not signal
  "last tab");
- if this was the LAST tab: set `tabs = []` FIRST so the `activeTab` binding
  resolves to `null` before the object is freed, then `destroy()`, then return
  **`false`** — the caller must close the window;
- otherwise adjust `activeIndex` (closing a tab to the left decrements it;
  closing the active tab moves left, clamped to `newTabs.length - 1`, and emits
  `aboutToSwitchTab()` first), **assign `activeIndex` BEFORE `tabs`** so the
  binding never points at the spliced-out slot, then `destroy()` and return `true`.

`activateTab(index)` refuses when the index is out of range, already active, or
`_hasActiveModal()`. `_hasActiveModal` deliberately EXCLUDES `modalZoxide` —
tab switching is allowed while the zoxide popup is open.

`nextTab()` / `prevTab()` wrap modulo `count`, and no-op at `count <= 1`.

`aboutToSwitchTab` consumer — `FileList.qml:72-91`: saves the cursor, then
cancels every transient mode on the departing tab (search, flash + cache
invalidation, chord prefix, bookmark sub-mode).

`onWindowStateChanged` (`FileList.qml:96-111`): re-syncs the image-chord gate,
then, if the new tab's path equals the model's CURRENT path and `count > 0`,
restores the cursor immediately — because the model will not re-scan and no
`entriesChanged` will arrive.

### 7.3 TabBar — `TabBar.qml`

Label per tab: `"<index+1> <basename>"`, where basename is `~` for home, `/` for
root, else the last path segment. Width
`max(120, textWidth + (hovered ? closeBtnWidth + spacing : 0) + padding.lg*2)`,
animated. The active tab is a raised `PillSurface` (`elevated: true`,
`pillMedium.background`); inactive tabs are transparent with an `outlineVariant`
border. A close button fades in on hover; clicking it calls `closeTab` and, on
`false`, emits `closeRequested()`.

### 7.4 Window spawning

`host/standalone/server.cpp` owns a `QLocalServer` at
`$XDG_RUNTIME_DIR/symmetria-fm.sock`. It validates incoming IPC commands and
emits Qt signals that `host/standalone/main.qml` listens to
(`main.qml:152-180`):

| Signal | Handler |
|---|---|
| `openRequested(initialPath)` | `_spawnFileManager(path)` |
| `openOverlayRequested(initialPath)` | `_spawnFileManager(path)` — no layer-shell in the standalone host |
| `createPickerRequested(options)` | `_spawnPicker(options)` |
| `closePickerRequested(fifoPath)` | close the picker if its fifo matches |

`_spawnFileManager` (`main.qml:105-115`) creates a `Window` from
`_fileManagerWindowComponent`: `1100×720`, `color: FmTheme.windowBackdrop`
(pure black at 0.6 alpha), title "File Manager", `onClosing: destroy()`. The
window is parented to `root`, so the host owns its lifetime; no tracking array.

`_spawnPicker` (`main.qml:117-150`): at most ONE picker at a time globally. A
second request is REJECTED, not queued — its fifo is enqueued in
`_pendingRejectFifos` and answered with `__PICKER_CANCELLED__` through a serialised
drain, and the existing picker is raised. Without that, the requesting
application hangs on the portal's 300 s timeout. The picker window is
`900×600`, `Qt.Dialog | Qt.WindowStaysOnTopHint`, and calls `requestActivate()`
on completion to claim Wayland focus.

The daemon exits when the last window closes (by design, `main.cpp`) — which is
what killed `wl-copy`'s serving fork before the `systemd-run` fix in
`FileManagerService._clipboardLauncherPrefix`.

- **Layer**: C++ for the socket and validation; QML for windowing.
- **Gotcha**: every window starts a fresh `TabManager` with exactly one tab.
  Tabs are NOT shared or moved between windows, and there is no tab persistence.
- **Port**: mechanical. Electron `BrowserWindow` per window, an IPC socket or a
  single-instance lock in the main process.

---

## 8. Status bar and path bar contents

### 8.1 PathBar

See §2.5. Everything it displays derives from `windowState.currentPath`,
`canGoBack`, `canGoForward`, and `Config.fileManager.showHidden`.

### 8.2 StatusBar — `StatusBar.qml`

Inputs: `windowState`, `fileCount` (required int), `currentEntry` (required var).
`FileManager.qml:50-55` feeds the latter two off `viewLoader.item`, so they come
from whichever view is active.

Derived visibility gate (`StatusBar.qml:16-21`):
`_normalVisible = !searchActive && !flashActive && transientMessage === ""`.

| Slot | Visible when | Content | Source |
|---|---|---|---|
| Transient message | `transientMessage !== "" && !searchActive && !flashActive` | the message, `palette.primary`, mono | `WindowState.transientMessage` (2 s auto-clear) |
| Accept button | `pickerMode && _normalVisible` | label = `pickerAcceptLabel` ?? `"Save"` (save mode) ?? `"Select (N)"` (multi + marks) ?? `"Select"`. Enabled when save mode, or multi with marks, or `currentEntry` matches the picker's type | `FileManagerService`, `selectedCount`, `currentEntry.isDir` |
| Item count | `_normalVisible && (!pickerMode \|\| pickerMultiple)` | `"N items"` (singular `"1 item"`), plus `"  ·  N selected"`; colour `indicator.selection` when marks exist, else `onSurfaceVariant` | `fileCount`, `selectedCount` |
| Sort indicator | `_normalVisible && !pickerMode` | `sortLabel + (sortReverse ? " ↓" : " ↑")`, mono | `WindowState.sortLabel`, `sortReverse` |
| Save-name field | `_normalVisible && pickerSaveMode && (pickerSuggestedName !== "" \|\| saveNameEditing)` | `"Save as:"` label plus an inline `TextInput`, read-only until `Ctrl+R`. `Enter` confirms+saves, `Escape` reverts, `Tab` toggles basename-vs-full selection, double-click enters edit mode. Empty/whitespace name reverts rather than saving `""` | `FileManagerService.pickerSuggestedName`, `saveNameEditing` |
| Current entry info | `_normalVisible && !pickerSaveMode && currentEntry !== null` | dir → `"<name>/"`; file → `"<name>  <formatSize(size)>"`, mono | `currentEntry`, `FileManagerService.formatSize` |
| Cancel button | `pickerMode && _normalVisible` | `"Cancel"` → `FileManagerService.cancelPickerMode()` | — |
| Search prefix | `searchActive` | `"/"`, `palette.primary`, mono | — |
| Search input | `searchActive` | the `TextInput` bound to `searchQuery` | see §6.1 |
| Match counter | `searchActive` | `""` on empty query; `"No matches"` in `palette.error` when none; else `"<i+1>/<n>"` | `currentMatchIndex`, `matchIndices` |
| Flash indicator | `flashActive` | bold `"S"` in `palette.primary`, then `flashQuery`, then `"N matches"` (singular `"1 match"`) or `"No matches"` in `palette.error` | `flashQuery`, `flashMatches` |
| Abbreviated path | ALWAYS | `Paths.shortenHome(currentPath)`, `elide: Text.ElideMiddle`, `Layout.maximumWidth: root.width * 0.3` | `WindowState.currentPath` |
| Help icon | `_normalVisible && windowState !== null` | Material `help` glyph; hover tints to `palette.primary`; click calls the SAME `windowState.openHelp()` as the `?` key | — |

`formatSize` (`FileManagerService.qml:253-261`): `< 1024` → `"N B"`;
`< 1 MiB` → `"X.X K"`; `< 1 GiB` → `"X.X M"`; else `"X.X G"`. Binary units with
single-letter suffixes.

- **Layer**: QML only.
- **Gotcha**: the item count reads `fileCount`, which is `view.count` in Miller
  (entries in the current directory) but `_rows.length` in the tree (every
  visible row across every expanded directory). The same label means two
  different things per view.
- **Port**: mechanical. Many conditional slots, but all pure derived state.

---

## 9. Contradictions with CLAUDE.md and PRD.md

Recorded so a port does not inherit stale documentation.

1. **Chord timeout.** `CLAUDE.md` (Critical Pitfalls → "Vim chord detection" and
   Keyboard Event Handling → "Chords") says "Timer-based 500ms detection". The
   file-manager chord path in `ChordHandler.js` has **no timer at all**;
   `activeChordPrefix` persists indefinitely until the next key, an Escape, a
   focus loss, or a tab switch. The only 500 ms timer is `ggTimer`
   (`FileTreeView.qml:347-351`), used solely by the windowState-less embedded
   tree.
2. **Escape priority.** `CLAUDE.md` lists "chord → search → flash nav → picker →
   close window". The implemented order is modal → bookmark sub-mode → chord →
   flash → picker → clear-selection → swallow (Miller) / propagate (tree).
   Search is not a cascade step; it is handled by whichever `TextInput` holds
   focus.
3. **Hidden-files persistence.** `PRD.md:344` says `.` "Persists to config".
   `Config.save()` is a documented no-op (`config/Config.qml:8-10`), so the
   toggle is lost on restart. The default is `showHidden: true`.
4. **PRD keymap is largely aspirational.** `PRD.md:300-430` describes Visual mode
   (`v` / `V`), Command mode (`:` with `:q`, `:cd`, `:mkdir`, `:sort`, `:set
   hidden`), `H`/`M`/`L` viewport jumps, `yy`/`dd`/`pp` doubled chords, `b` /
   `'` / `m` marks, `A` for new directory, `o` for "Open with", `q` to close,
   and an editable PathBar. **None of these exist.** The shipped model is the
   `KeyRegistry.js` table plus three `g`/`c`/`,` chords.
5. **`WlrKeyboardFocus.Exclusive`.** The PRD's Focus Management section and the
   memory file assume it. It only existed under QuickShell's wlr-layer-shell; the
   standalone host uses `Qt.Dialog | Qt.WindowStaysOnTopHint` plus
   `requestActivate()` (`main.qml:78-88`), as `CLAUDE.md` correctly records.
6. **`windowrulev2` in a live comment.** `main.qml:82` still recommends
   `windowrulev2 = float, class:^(symmetria-fm)$`. `CLAUDE.md` says the
   Hyprland config uses the current `windowrule = <action>, match:<selector>`
   form. The comment is stale; no rule ships today either way.
7. **Latent bug, not a contradiction.** `TreeModel.halfPageCount`
   (`TreeModel.js:857`) omits `compactScale`, so `Ctrl+D`/`Ctrl+U` scroll the
   wrong distance in a compact tree. `TreeModel.rowHeight` (`TreeModel.js:652`)
   includes it and carries a comment saying the two "MUST stay equal".

---

## 10. Port difficulty summary

| Area | Difficulty | Reasoning |
|---|---|---|
| Keybinding registry + dispatch | trivial | It is already a pure declarative JS array with a hermetic `dispatch(event, ctx)`. Swap `Qt.Key_*` for `KeyboardEvent.code` and reuse it verbatim. |
| Chords, which-key HUD, help popup | trivial | Pure data plus two read-only renderers over the same source. |
| Selection model | trivial | A `Set<string>` in the store; the immutable-update convention is React's default. |
| Search matching and cycling | trivial | Substring scan plus modulo cycling. |
| History, cursor cache, bookmarks | trivial | Plain arrays and maps. |
| Sorting | mechanical | `Intl.Collator` for `localeAwareCompare` and `Natural`; the dirs-first rule is one line. |
| Miller layout, path bar, status bar, tab bar | mechanical | Flex layout plus derived state. |
| Flash jump | mechanical algorithm, design work for rendering | `FlashLogic.js` is already a pure library. The label OVERWRITES characters in the name, so a naive `<mark>` wrapper is wrong. |
| Tabs and window spawning | mechanical | `BrowserWindow` per window; tabs are an in-renderer array. |
| Focus and modal precedence | **needs design work** | Qt gives "swallow everything while a modal is open" from a `FocusScope`; the DOM does not. Use one window-level keydown listener plus an explicit mode stack, not DOM focus. |
| File-system watching semantics | **needs design work** | The in-place-growth and atomic-replace workarounds are inotify-level. Node's `fs.watch` has the same holes plus platform inconsistency. |
| Tree expansion + lazy expand + viewport re-anchor | **needs design work** | Per-directory watchers, a scroll-driven expansion cycle, and a viewport-top re-anchor that depends on synchronous layout (`view.forceLayout()`). React has no equivalent flush point; this needs a virtualiser with explicit scroll-anchor support. |

### The three hardest things to port

1. **Tree expansion, lazy expand, and viewport re-anchoring.** One
   `FileSystemModel` + watcher per expanded directory, a lazy cycle re-armed from
   `onContentYChanged`, and a `rebuildRows` that must call `forceLayout()` before
   restoring `contentY` against the viewport-TOP row (never the cursor — that is
   an explicit regression guard). Requires a virtualiser with scroll anchoring.
2. **Focus and the modal/mode cascade.** The whole design assumes Qt's
   `FocusScope` semantics and `Qt.callLater(() => view.forceActiveFocus())` to
   reclaim focus after every popup closes. In a DOM renderer this must become an
   explicit mode stack with a single window-level key listener, because focus
   alone will not swallow keys destined for a closed popup.
3. **Filesystem watch fidelity.** `QFileSystemWatcher` drops watches on atomic
   replace and never reports in-place content growth. The C++ model works around
   both (per-file watches capped at 2048, a `(size, mtime)` diff, a debounce
   timer, and immutable entry snapshots rebuilt as remove+add). A Node port must
   re-derive equivalent behaviour on top of a different watcher with different
   holes.
