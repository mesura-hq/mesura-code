# 17 — File search, content search (grep) and the command palette

Research for decision **D10** in `15-decisions.md` and for open question **#4**
("Which file-search and command-palette interface wins"). Read-only study. No
source file in either repository was modified.

**Path prefixes used in every citation below:**

| Prefix | Repository root |
|---|---|
| `mesura/` | `/home/jc/projects/mesura-code` |
| `fm/` | the Symmetria File Manager repository (this worktree: `/home/jc/.t3/worktrees/symmetria-file-manager/t3code-a2a6aa9b`; canonical checkout `/home/jc/projects/symmetria-file-manager`) |

**The engine is the same on both sides, so it is out of scope.** Mesura Code
calls the Rust `fff` engine through `@ff-labs/fff-node` 0.9.4 in
`mesura/apps/server/src/workspace/WorkspaceSearchIndex.ts`. The file manager
links the same engine's C ABI (`libfff_c`) from
`fm/plugin/src/Symmetria/FileManager/Models/fuzzyfinder.cpp`. Every difference
recorded here is a difference of **interface, feature set and index policy**.

---

## 0. Executive summary

1. **File search.** Neither interface wins outright. The file manager wins the
   *result surface* — it has a File Info panel with a real preview that Mesura
   Code has no equivalent of anywhere. Mesura Code wins the *plumbing* — server
   ownership of the index, a debounce that reports which query the visible rows
   belong to, a truncation flag, and a reusable palette chrome. Take the file
   manager's surface and Mesura Code's plumbing.
2. **Grep.** Do **not** copy Mesura Code's indexed-grep design into the file
   manager. Measurements below show `fff`'s content index costs 8× the scan time
   and pushes resident memory to 280 MB on a 44 000-file tree, while `ripgrep`
   answers the same question in 53 ms with 10 MB. Mesura Code's design is right
   for Mesura Code (a long-lived index over one project root) and wrong for a
   file manager (a short-lived index over an arbitrary directory).
3. **Command palette.** Copy the pattern, not the code. `KeyRegistry.js` is
   already 90 % of a command registry — it has ids, labels, icons, groups and
   `when()` gating — and it needs three additions to feed a palette.
4. **Shared package.** A `packages/file-search` can share the *engine access*
   and the *result shape*. It cannot share the *search UI*: Mesura Code's palette
   is welded to `@base-ui/react`, TanStack Router, Effect Atom and the
   `useRightPanelStore` singleton.

---

## A — The two file-search interfaces

### A.1 Mesura Code — the project file picker (⌘P)

**Surfaces involved.**

| File | Role |
|---|---|
| `mesura/apps/web/src/components/files/ProjectFilePicker.tsx` | the picker component |
| `mesura/apps/web/src/components/files/ProjectFilePicker.logic.ts` | row mapping + highlight index computation |
| `mesura/apps/web/src/components/files/projectFilesQueryState.ts:148` | `useProjectFilePickerQuery` |
| `mesura/apps/web/src/state/queries.ts:256` | `useProjectPathSearch`, the debounce |
| `mesura/apps/server/src/workspace/WorkspaceEntries.ts:245` | server-side `search` |
| `mesura/apps/server/src/workspace/WorkspaceSearchIndex.ts:451` | the `fff` call |

**How results are requested.** The picker is a thin client of an RPC. The chain
is `ProjectFilePicker.tsx:75` → `useProjectFilePickerQuery` →
`useProjectPathSearch` → the `projectEnvironment.searchEntries` Effect Atom →
websocket → `WorkspaceEntries.search` → `WorkspaceSearchIndex.search` →
`finder.fileSearch(query, { pageSize })`.

- **Debounce:** 120 ms, `PROJECT_PATH_SEARCH_DEBOUNCE_MS` at
  `mesura/apps/web/src/state/queries.ts:34`. The debounce is on the whole
  *target* (environment + cwd + query + kind + imageOnly), not only the query —
  `areProjectPathSearchTargetsEqual` at `queries.ts:242`.
- **Limit:** `PROJECT_FILE_PICKER_RESULT_LIMIT = 200`
  (`ProjectFilePicker.logic.ts:4`). The contract caps it at 200 as well
  (`PROJECT_SEARCH_ENTRIES_MAX_LIMIT`, `mesura/packages/contracts/src/project.ts:9`).
- **Paging:** none for the picker. The server asks `fff` for `limit + 1`
  (`WorkspaceSearchIndex.ts:454`) purely to compute a boolean `truncated`
  (`:173`). There is no cursor, no "load more". Note that `fff`'s
  `SearchOptions` does expose `pageIndex`/`pageSize`; the picker uses only
  `pageSize`.
- **Query normalization:** `normalizeSearchQuery(query, { trimLeadingPattern:
  /^[@./]+/ })` runs on the server (`WorkspaceEntries.ts:248`) and again on the
  client (`ProjectFilePicker.logic.ts:52`) so highlight positions match the
  server's matching. The client additionally strips all whitespace
  (`.replaceAll(/\s/g, "")`).

**Match highlighting.** Recomputed on the client, not returned by the server.
`findMatchIndices` (`ProjectFilePicker.logic.ts:22`) does a greedy,
case-insensitive first-subsequence walk, once over the bare filename and once
over the full relative path. `HighlightedFuzzyText`
(`ProjectFilePicker.tsx:23`) wraps each matched character in its own `<strong>`.
When the subsequence is not found the row still renders, unhighlighted
(`:66-67`) — the server matched it, the client just cannot place the marks.
Highlighting is suppressed entirely when the *matched* query is blank
(`hasMatchedQuery`, `ProjectFilePicker.tsx:87`).

**Row metadata.** Three elements only (`ProjectFilePicker.tsx:90-112`):

1. a file-type icon (`PierreEntryIcon`, resolved from the path extension),
2. the bare filename as the title, highlighted,
3. the full relative path as the description, highlighted.

No size, no mtime, no git status, no score, no frecency — even though `fff`'s
`FileItem` carries `size`, `modified`, `gitStatus` and three frecency scores
(`fff-node/dist/src/fff-api.d.ts:140-157`). `WorkspaceSearchIndex.toFileEntry`
(`:152`) discards all of it and keeps `{ path, kind }`, because that is the whole
of the `ProjectEntry` contract (`mesura/packages/contracts/src/project.ts:28`).

**Keyboard model.** Delegated to the Base UI `Autocomplete` primitive through
`mesura/apps/web/src/components/ui/command.tsx`. Arrow up/down navigate, Enter
runs, Escape closes (or falls back to the command mode — see §C). `autoHighlight="always"`
(`ProjectFilePicker.tsx:120`) keeps row 0 selected as the user types. The footer
advertises the three keys (`CommandPaletteContent.tsx:44-71`).

**Empty-query behaviour.** An empty query is a **valid, deliberate request**.
`useProjectFilePickerQuery` passes `{ allowEmptyQuery: true }`
(`projectFilesQueryState.ts:164`), and the contract documents why: "An empty
query is a bounded browse: the index returns frecency-ordered entries"
(`project.ts:19-20`). So opening ⌘P shows recent/frequent files immediately.
This matches the file manager exactly.

**Directory handling.** The picker asks for `kind: "file"`
(`projectFilesQueryState.ts:159`) and then filters again on the client
(`ProjectFilePicker.logic.ts:58`). **Directories never appear.** The server does
support `kind: "directory"` and a mixed mode
(`WorkspaceSearchIndex.ts:461-470`), and trims the trailing `/` that `fff` puts
on directory paths (`trimDirectorySeparator`, `:131`), but the file picker does
not use them. Directory navigation in Mesura Code is a different surface
(the composer path search and the add-project browse flow).

**Opening a result.** `useRightPanelStore.getState().openFile(target.threadRef,
match.path)` (`ProjectFilePicker.tsx:110`) — it opens the file in the thread's
right panel, not on disk.

**Frecency writes.** None. `FileFinder.create` is called with `basePath` and
scanning flags only (`WorkspaceSearchIndex.ts:306-315`); no `frecencyDbPath` and
no `historyDbPath` are passed, so `trackQuery` is never called and the frecency
DB is never initialized. **This confirms decision D2's finding:** the shared
frecency store does not exist yet on the Mesura Code side.

**Index lifecycle.** One `fff` index per `(cwd, variant)` pair, memoized by an
Effect `LayerMap` with a 15-minute idle TTL
(`WORKSPACE_INDEX_IDLE_TTL`, `WorkspaceSearchIndex.ts:32`;
`WorkspaceSearchIndexMap`, `:560`). Creation waits up to 15 s for
`waitForIndexReady` (`WORKSPACE_INDEX_SCAN_TIMEOUT_MS`, `:31`) and fails the
whole request if the scan does not finish. The index is **server-owned and
outlives the picker window**, which is why the picker's first keystroke is fast.

### A.2 The file manager — the fuzzy finder (`f`)

**Surfaces involved.**

| File | Role |
|---|---|
| `fm/qml/Symmetria/FileManager/UI/modules/filemanager/FuzzyFinderPopup.qml` | the popup, layout, keys, confirm |
| `fm/qml/Symmetria/FileManager/UI/modules/filemanager/FuzzyFinderResultDelegate.qml` | the row |
| `fm/qml/Symmetria/FileManager/UI/modules/filemanager/FuzzyFinderInfoPanel.qml` | the File Info panel |
| `fm/plugin/src/Symmetria/FileManager/Models/fuzzyfinder.cpp` | the engine wrapper |

Opened by the `finder.fuzzy` registry row — bare `f`, group "Search & jump"
(`fm/qml/.../handlers/KeyRegistry.js:256-263`).

**How results are requested.** In-process, synchronously against a warm index on
a `QtConcurrent` worker.

- **Debounce:** 100 ms one-shot `Timer`, restarted per keystroke
  (`FuzzyFinderPopup.qml:158`, `:350-358`).
- **Limit:** `FuzzyFinder::MaxResults = 200`
  (`fm/plugin/.../fuzzyfinder.hpp:132`), passed as `page_size` with
  `page_index = 0` (`fuzzyfinder.cpp:438-441`).
- **Paging:** none. Every query is a full model reset —
  `beginResetModel()` / swap / `endResetModel()` (`fuzzyfinder.cpp:480-486`).
- **Staleness:** two generation counters, `m_searchGeneration`
  (`fuzzyfinder.cpp:415`, checked `:477`) and `m_createGeneration` (`:356`,
  checked `:392`), discard superseded results.
- **Engine:** `fff_search_mixed`, not `fff_search`, so directories are returned
  (`fuzzyfinder.cpp:438`).

**Match highlighting.** `computeMatchIndices` (`fuzzyfinder.cpp:35-54`) does the
same greedy case-insensitive subsequence walk as Mesura Code, but over the
**relative path**, in C++, and exposes the result as a `matchIndices` role.
`FuzzyFinderResultDelegate.qml` splits the trimmed path at
`_nameStart = max(0, trimmedPath.length - name.length)` (`:48-49`) and calls
`_highlightRange` twice — once for the filename span (`:102-105`), once for the
parent-path span (`:130-133`). The highlight is a background-coloured
`secondaryContainer` run, not a bold weight (`:171-172`), and adjacent matched
characters are **coalesced into one span** rather than one span per character.
Because Qt cannot elide `RichText`, each label flips between
`RichText` + `clip` (match) and `PlainText` + elide (no match) — `:107-109`,
`:135-137`.

**Row metadata.** Three elements: icon, filename, parent path
(`FuzzyFinderResultDelegate.qml:72-143`). The icon is a real themed icon file
resolved lazily on the main thread and memoized (`IconPathRole`,
`fuzzyfinder.cpp:249-265`). **The row shows no more metadata than Mesura
Code's** — the difference is that the file manager moves the metadata to the
info panel instead of dropping it.

**The model exposes far more than the row uses.** Fourteen roles
(`fuzzyfinder.hpp:85-102`): `path`, `name`, `isDir`, `score`, `matchIndices`,
`fullPath`, `size`, `modified`, `gitStatus`, `frecencyTotal`, `isBinary`,
`scoreBreakdown`, `matchType`, `iconPath`. Four of them (`score`,
`frecencyTotal`, `scoreBreakdown`, `matchType`) are read by no QML at all.

**Keyboard model.** All keys on the `TextInput`
(`FuzzyFinderPopup.qml:160-180`):

| Key | Effect |
|---|---|
| `Escape` | `windowState.closeModal()` |
| `Return` / `Enter` | `_confirmSelection()` |
| `Down` / `Ctrl+J` | next result, `positionViewAtIndex(..., Contain)` |
| `Up` / `Ctrl+K` | previous result |

Everything else is swallowed by the `PillCard`'s catch-all
`Keys.onPressed: event.accepted = true` (`:102-104`), so no key leaks to the
file list underneath. **Absent:** PageUp/PageDown, Home/End, Ctrl+D/Ctrl+U, a
Tab/Right directory-drill, and any preview-scroll key. The info pane installs no
key handler at all (`FuzzyFinderInfoPanel.qml:138-142`), which is also why
`Ctrl+R` HTML render is unavailable there (`PreviewContent.qml:41-43`).

**Empty-query behaviour.** Identical intent to Mesura Code and documented twice
in C++: an empty query is never short-circuited, because `fff` answers it with
the frecency-ranked file list (`fuzzyfinder.cpp:407-408`, `:417-418`). The
popup sets `searchPath` in `Component.onCompleted` (`FuzzyFinderPopup.qml:42`),
so the frecency list is on screen before the first keystroke.

**Directory handling.** Directories **do** appear (mixed search), carry a
trailing `/` from `fff`, and are stripped for display by `_trimTrailingSlash`
(`FuzzyFinderResultDelegate.qml:154-156`). But there is **no in-popup drill**:
confirming a directory closes the popup and navigates the pane
(`FuzzyFinderPopup.qml:311-312`). `searchPath` is assigned exactly once and
never re-rooted while the popup is open.

Confirming a file navigates to `Paths.parentDir(fullPath)` and emits
`windowState.fuzzyFinderNavigated(name)` **before** `navigate()` — a documented,
load-bearing ordering (`FuzzyFinderPopup.qml:319-325`).

**Ranking writes.** Real, but they are **query-tracker** writes rather than
frecency writes — this section said frecency and was wrong.
`recordOpen(selectedIndex, searchInput.text)` fires on every confirm (see the
call site in `FuzzyFinderPopup.qml`), before `closeModal()` wipes the model. The
C++ side reads the absolute path synchronously then does a fire-and-forget
`fff_track_query` on a worker (see `FuzzyFinder::recordOpen`). What that writes
is one record per `(index root, query)` pair holding the selected file and an
open count; a later matching query adds `open_count × comboBoostMultiplier` to
the score. The frecency writer is not exported by the shipped library at all.
See `20-spike-search-topology.md` §2.1. Both databases live at
`SYMMETRIA_FM_FRECENCY_DIR` or `GenericDataLocation + "/symmetria/fff"`.

**Index lifecycle.** A **process-wide singleton** engine (`FffEngine`,
`fuzzyfinder.cpp:105-202`), because LMDB refuses a second open of one frecency
environment inside one process. `setSearchPath` swaps the base through
`fff_restart_index` (`:178`). Known limitation, documented at `:102-104`: two
finders open in different directories share one index and the last `acquire`
wins.

**The File Info panel — the feature Mesura Code has no equivalent of.**

`FuzzyFinderInfoPanel.qml` is modelled on `fff.nvim`. It is driven by the
`selectedEntry` plain object that `_refreshSelected()` rebuilds from seven roles
(`FuzzyFinderPopup.qml:331-347`), because `data()` is not a reactive binding
source. A **second, independent 150 ms debounce** inside the panel
(`FuzzyFinderInfoPanel.qml:27-33`) sets `_previewPath`, so holding `j`/`k` does
not construct a `FileSystemEntry` per keystroke. That path feeds a `FileInfo`
element (`:39-42`) whose `.entry` drives the shared `PreviewContent` router.

It displays:

- the filename, mono DemiBold, `ElideMiddle` (`:57-65`);
- a four-row label/value grid (`:70-125`) — **Size** (or `dir`), **Type**
  (extension or `directory`), **Git** (a `GitStatusBadge`, or `—`), **Modified**;
- a **live preview** of the highlighted result, filling all remaining height
  (`:127-143`) — the same `PreviewContent` router the Miller pane uses, so every
  preview type (syntax-highlighted text, image, archive listing, spreadsheet,
  directory listing) is available in the finder for free.

Layout: the panel is **hard-pinned at 360 px** (preferred, minimum and maximum
all 360, `fillWidth: false`) with a comment explaining that `preferredWidth`
alone let wide previews starve the result list
(`FuzzyFinderPopup.qml:240-246`). The dialog itself animates between 672 px (no
results) and 1080 px (results) (`:76-77`).

Not displayed: line count, permissions, owner, full path, score, match type,
`isBinary`, frecency.

**Result count.** `"<n> results"` plus a `"Scanning…"` indicator
(`FuzzyFinderPopup.qml:185-206`). **There is no truncation indicator** — a tree
with 5 000 matches reads "200 results" with nothing marking the cap.

### A.3 Feature-by-feature comparison

| # | Feature | Mesura Code (⌘P picker) | File manager (`f` finder) | Verdict |
|---|---|---|---|---|
| 1 | Engine | `fff` via `@ff-labs/fff-node`, `fileSearch` | `fff` via C ABI, `fff_search_mixed` | **Tie** — same matcher |
| 2 | Where the index lives | Server process, `LayerMap`, 15-min idle TTL, survives the dialog | Process-wide singleton, one base path at a time | **Mesura Code.** Keyed by cwd, so several roots stay warm. The FM's singleton means "last acquire wins" across two windows (`fuzzyfinder.cpp:102-104`) |
| 3 | Debounce | 120 ms, on the whole target | 100 ms, on the query; **plus** a second 150 ms before the preview | **File manager.** The two-stage debounce is the correct design — cheap search at 100 ms, expensive preview at 150 ms |
| 4 | Which query the rows belong to | Reported as `matchedQuery` and used for highlighting (`projectFilesQueryState.ts:171`) | Not reported; highlighting uses whatever `matchIndices` the C++ computed for the last completed query | **Mesura Code.** Highlighting against half-typed input is a real class of visual bug the FM has not hit only because the search is in-process |
| 5 | Result cap | 200, contract-enforced | 200, `MaxResults` | **Tie** |
| 6 | Truncation signalled | Yes — `truncated` boolean, computed by asking for `limit + 1` (`WorkspaceSearchIndex.ts:173`) | **No.** "200 results" is shown whether there are 200 or 20 000 | **Mesura Code** |
| 7 | Paging | None (server has `pageIndex` available, unused) | None | **Tie** — both leave `fff` paging on the table |
| 8 | Highlight computation | Client-side subsequence, per-character `<strong>` | C++ subsequence, coalesced background-coloured runs | **File manager.** Coalescing avoids one DOM/Item node per character; the background run is also easier to read than a weight change |
| 9 | Highlight coverage | Name **and** path, two independent index sets | Name **and** path, one absolute index set split at `_nameStart` | **Tie** in effect. The FM's single-set approach is cheaper; Mesura Code's two-set approach is more robust when the name is not a suffix of the path |
| 10 | Row metadata | icon, name, path | icon, name, path | **Tie** |
| 11 | Metadata available but unused | `size`, `modified`, `gitStatus`, frecency — all dropped at `toFileEntry` (`WorkspaceSearchIndex.ts:152`) | Same fields kept as model roles and shown in the info panel | **File manager** |
| 12 | **Preview of the highlighted result** | **None. No equivalent exists anywhere in Mesura Code's search surfaces.** `onItemHighlighted` only drives row styling (`ProjectFilePicker.tsx:126`) | Full `PreviewContent` router — text with syntax highlighting, images, archives, spreadsheets, directory listings | **File manager, decisively.** This is the single largest feature gap |
| 13 | Git status in the finder | No | Yes, `GitStatusBadge` in the info panel (`FuzzyFinderInfoPanel.qml:96-112`) | **File manager** |
| 14 | Directories in results | **No** — `kind: "file"`, filtered twice | Yes, mixed search, trailing slash trimmed for display | **File manager** |
| 15 | Directory drill inside the popup | N/A | **No** — confirming a directory closes the popup | **Neither.** A real gap on both sides |
| 16 | Empty query | Frecency-ordered browse, deliberate | Frecency-ordered browse, deliberate | **Tie.** Both got this right |
| 17 | Ranking writes | **None** — no `frecencyDbPath` passed, `trackQuery` never called | `recordOpen` → `fff_track_query` on every confirm, writing the **query tracker** (not frecency — see `20-spike-search-topology.md` §2.1) | **File manager.** Mesura Code's ranking never learns anything; ours learns a per-`(root, query)` open count |
| 18 | Keyboard | Arrow keys + Enter + Escape, via Base UI `Autocomplete` | Arrow keys + `Ctrl+J`/`Ctrl+K` + Enter + Escape | **File manager** by a nose (the vim pair). Both lack page-scroll keys |
| 19 | Preview scroll from the finder | N/A | **No** — the info pane installs no key handler | **Neither** |
| 20 | Error surface | `error` string from the RPC, shown in the empty state (`ProjectFilePicker.tsx:46`) | `error` property, rendered under the list in `palette.error` | **Tie** |
| 21 | Loading/scanning surface | `"Indexing workspace files…"` vs `"Searching workspace files…"` — distinguishes the two states | `"Scanning…"` only; `loading` is read but never surfaced as a spinner (`FuzzyFinderPopup.qml:261`) | **Mesura Code** |
| 22 | Chrome reuse | `CommandPaletteContent` is shared by three surfaces (palette, picker, content search) | The popup owns its own chrome | **Mesura Code.** One input, one footer, one panel, three modes |
| 23 | What Enter does | Opens the file in the thread's right panel | Navigates the pane and focuses the file, or navigates into the directory | **N/A** — different products |

**Overall verdict.** Twelve rows tie or split. Of the rest, the file manager
wins seven (11, 12, 13, 14, 17, 18, and the debounce staging in 3) and Mesura
Code wins six (2, 4, 6, 21, 22, and index lifetime in 2). The wins are not
symmetric in weight: **row 12 alone — a live preview of the highlighted
result — is worth more than Mesura Code's six combined**, because it changes
what the finder is for. Mesura Code's wins are all corrections that take a few
lines each (report the matched query, report truncation, distinguish indexing
from searching, share the chrome).

**Recommendation for the Electron rewrite:** keep the file manager's finder as
the design; adopt six specific things from Mesura Code.

1. Report the query the visible rows were computed for (`matchedQuery`), and
   highlight against it rather than against live input.
2. Report `truncated` and show it (`"200+ results"`), computed the same way — ask
   the engine for `limit + 1`.
3. Distinguish "indexing" from "searching" in the status line.
4. Key the index by base path with an idle TTL, instead of one global engine
   whose base path is swapped. This also removes the "two finders, last acquire
   wins" limitation.
5. Share one dialog chrome (input + panel + footer hint gutter) between the
   finder, the future content search and the future palette, as
   `CommandPaletteContent.tsx` does.
6. Keep the two-stage debounce (100 ms search / 150 ms preview) — that is the
   file manager's own invention and Mesura Code has no equivalent.

Additionally, fix the two gaps neither side has: an in-popup directory drill
(Tab or Right re-roots `searchPath` at the highlighted directory), and
preview-scroll keys in the info pane.

---

## B — Content search (grep)

The file manager has **none**. A grep of `fm/qml` and `fm/plugin/src` finds only
a `grep` call inside a shell command in `FileOpener.qml:32-33` and two comments.
`ripgrep` 15.2.0 is installed at `/usr/bin/rg` on this machine.

### B.1 Mesura Code's content search, in full

**The surfaces.**

| File | Role |
|---|---|
| `mesura/apps/server/src/workspace/WorkspaceSearchIndex.ts:473` | `searchContents` — the grep loop |
| `mesura/apps/server/src/workspace/WorkspaceSearchIndex.ts:233` | `buildContentSearchQuery` |
| `mesura/apps/server/src/workspace/WorkspaceEntries.ts:259` | acquires the `"content"` index variant |
| `mesura/packages/contracts/src/project.ts:40` | `ProjectSearchContentsInput` |
| `mesura/apps/web/src/state/queries.ts:313` | `useProjectContentSearch` |
| `mesura/apps/web/src/components/search/ProjectContentSearchDialog.tsx` | the ⇧⌘F dialog |
| `mesura/apps/web/src/components/search/HighlightedSearchLine.tsx` | per-line syntax highlighting |

**The two index variants.** This is the central design decision and it is
explicit in the code:

```
WORKSPACE_SEARCH_INDEX_VARIANTS = ["paths", "content"]   // :527
workspaceSearchIndexKey = (cwd, variant) => `${variant}\n${cwd}`   // :535
```

`createFinder` sets `disableContentIndexing: variant !== "content"`, with the
comment: *"Content indexing costs scan CPU and memory, so only the on-demand
content-search index pays for it; path-only consumers (file tree, composer path
search, file picker) keep the lightweight index"*
(`WorkspaceSearchIndex.ts:310-313`). The two variants are **separate `LayerMap`
resources with independent lifecycles** (`:530-536`), so opening ⇧⌘F once
creates a second `fff` index over the same directory, and it expires 15 minutes
after the last use.

Both variants also pass `disableMmapCache: true` (`:308`), `aiMode: false`,
`enableFsRootScanning: true` and `enableHomeDirScanning: true` (`:314-315`).

**Query syntax supported.**

| Capability | Supported? | Mechanism |
|---|---|---|
| Literal | Yes, the default | `mode: "plain"` — SIMD literal matching |
| Regex | Yes, opt-in | `useRegex` → `mode: "regex"` |
| Case-insensitive | Yes, the default | Plain mode: the query is lowercased and `smartCase: true` is passed (`:243-244`, `:492`). Regex mode: the pattern is prefixed with the inline flag `(?i)` (`:243`) |
| Case-sensitive | Yes, opt-in | `caseSensitive` → the query is passed through untouched and `smartCase` is off |
| Whole word | Yes, opt-in | **Post-filtered, not pattern-wrapped.** `isWholeWordRange` (`:268`) |
| Glob / path filters | **Not exposed.** `fff`'s `grep` accepts constraint syntax (`*.ts pattern`, `src/ pattern` — `finder.d.ts:184-186`) but Mesura Code never advertises it. A user who types `*.ts foo` gets whatever `fff` does with it, undocumented | — |
| Fuzzy content match | **Not exposed.** `GrepMode` includes `"fuzzy"` (Smith-Waterman per line) and Mesura Code never selects it | — |
| Multi-pattern OR | **Not exposed.** `multiGrep` (Aho-Corasick) is unused | — |
| Context lines | **Not exposed.** `beforeContext` / `afterContext` unused | — |
| Definition classification | **Not exposed.** `classifyDefinitions` unused | — |

The whole-word design deserves quoting, because it is a trap the file manager
would otherwise fall into (`WorkspaceSearchIndex.ts:259-267`): wrapping the
pattern in `(?:^|\W)` swallows the separator between adjacent matches and widens
the reported ranges, and `\b` cannot match a punctuation-edged query at all. So
whole-word runs as a post-filter that mirrors VS Code's rule: an edge is a
boundary when it touches the line edge, the neighbouring character is not a word
character, or the match's own edge character is not a word character.

**Whitespace is deliberately significant.** `ProjectSearchContentsInput.query`
uses `Schema.String`, not `TrimmedString`, with the comment *"Whitespace is
significant in content queries (' foo', regex trailing spaces), so the query is
deliberately not trimmed on the wire"* (`project.ts:41-43`). The client trims
only to decide whether the input is blank (`queries.ts:315-317`).

**The paging loop.** `searchContents` (`WorkspaceSearchIndex.ts:473-522`) is a
`do…while` over `finder.grep` with a `GrepCursor`:

```
deadline   = performance.now() + CONTENT_SEARCH_TIME_BUDGET_MS   // 250 ms
rawPageSize = wholeWord ? max(limit, 100) : limit
loop:
  remaining = max(1, ceil(deadline - now))
  result = finder.grep(searchQuery, {
    mode, smartCase,
    maxMatchesPerFile: min(100, rawPageSize),
    pageSize: rawPageSize,
    cursor: nextCursor,
    timeBudgetMs: remaining,
  })
  … map byte ranges to string indices, apply the whole-word filter …
  nextCursor = result.nextCursor
while (matches < limit && nextCursor !== null && now < deadline)
```

`GrepCursor` is an opaque branded type — `{ __brand: "GrepCursor"; _offset:
number }` (`fff-api.d.ts:366-371`) — carrying a raw file offset. `fff` searches
files **sequentially in frecency order**, so the cursor means "resume at file
number N" (`fff-api.d.ts:377-380`). The loop exists because the cursor advances
by *file*: when whole-word post-filtering discards every raw match in a file,
the page can come back empty and the loop must fetch the next one.

**Byte-to-string index conversion.** `fff` returns `matchRanges` as **byte**
offsets into `lineContent`. `mapContentMatchRanges` (`:247`) converts each to a
JavaScript string index by re-decoding the prefix
(`lineBytes.subarray(0, byteOffset).toString().length`). This is O(n) per range
and would be a real cost on a dense line; it is correct for non-ASCII.

**Every limit, in one place.**

| Constant | Value | Where | What it bounds |
|---|---|---|---|
| `CONTENT_SEARCH_TIME_BUDGET_MS` | 250 | `WorkspaceSearchIndex.ts:33` | Wall clock for the whole paging loop, also passed down as `timeBudgetMs` per call |
| `CONTENT_SEARCH_MAX_MATCHES_PER_FILE` | 100 | `:34` | Stops one dense file from consuming the page |
| `PROJECT_CONTENT_SEARCH_LIMIT` | 500 | `mesura/apps/web/src/state/queries.ts:37` | Matches requested by the client |
| `PROJECT_SEARCH_CONTENTS_MAX_LIMIT` | 500 | `mesura/packages/contracts/src/project.ts:10` | Contract ceiling on `limit` |
| query max length | 256 | `project.ts:43` | `Schema.isMaxLength` |
| `PROJECT_CONTENT_SEARCH_DEBOUNCE_MS` | 120 | `queries.ts:36` | Keystroke debounce |
| `VISIBLE_MATCH_WINDOW` | 100 | `ProjectContentSearchDialog.tsx:28` | Rows mounted at once |
| `WORKSPACE_INDEX_SCAN_TIMEOUT_MS` | 15 000 | `WorkspaceSearchIndex.ts:31` | Index readiness before the first search can run |
| `WORKSPACE_INDEX_IDLE_TTL` | 15 min | `:32` | How long the content index stays resident |
| `fff` `maxFileSize` default | 10 MB | `fff-api.d.ts:383` | Files larger than this are skipped. Mesura Code does not override it |
| `WORKSPACE_INDEX_MAX_ENTRIES` | 25 000 | `:28` | **Not a grep limit** — it caps the `list()` full-tree listing only |

**Grouping and presentation.** `groupMatches` (`ProjectContentSearchDialog.tsx:42`)
groups the flat match array by `path`, preserving server order and stamping each
match with its flat `resultIndex`. Each group renders as a `<section>` with a
**sticky header** carrying the file icon, the bare filename, the directory, and a
pill with the group's match count (`:252-269`). Each row is a 28 px button:
right-aligned tabular line number, then the matched line.

The line is **syntax-highlighted with Shiki and then overlaid with the match
ranges** — `HighlightedSearchLine.tsx` normalizes and merges the ranges
(`normalizeRanges`, `:29`), then splits every Shiki token at the range
boundaries (`splitToken`, `:52`) so a match can straddle token colours. This is
the reason for `VISIBLE_MATCH_WINDOW`: the file's own comment says mounting all
500 rows at once stalls the UI (`ProjectContentSearchDialog.tsx:22-27`). Rows
grow in windows of 100 driven by an `IntersectionObserver` sentinel (`:142-151`)
**or** by keyboard navigation moving past the rendered window (`:132-136`).

**Keyboard.** ArrowDown/ArrowUp wrap around the flat match list, Enter opens
(`:195-216`). Enter is **blocked while a newer query is debouncing or in
flight** (`canOpenMatches`, `:122`), with the comment: the visible matches belong
to the previous query, so opening one would jump to a result the user did not
ask for (`:203-205`). `openFile(threadRef, path, lineNumber)` opens at the line
(`:156`).

**Status line.** `"<n>[+] results in <m> files"`, or `"Searching…"`, or the
error, or `"Invalid regular expression"` (`:224-238`). The invalid-regex case
comes from `fff`'s `regexFallbackError`: when the pattern does not compile, the
engine **falls back to literal matching** and reports the compile error rather
than failing (`fff-api.d.ts:474-475`; surfaced at `WorkspaceSearchIndex.ts:514`
and `queries.ts:345`).

**The dialog resets on workspace change** via a React `key`
(`ProjectContentSearchDialog.tsx:314`).

### B.2 What `fff` offers that Mesura Code does not expose

Read from `@ff-labs/fff-node@0.9.4`'s
`dist/src/fff-api.d.ts` and `dist/src/finder.d.ts`.

| Unused capability | Where declared | Why it matters to a file manager |
|---|---|---|
| `multiGrep({ patterns, constraints })` | `fff-api.d.ts:483-515`, `finder.d.ts:235` | Aho-Corasick OR search over several literals in one pass. Faster than regex alternation. Natural fit for "find any of these extensions/strings" |
| `GrepOptions.beforeContext` / `afterContext` | `fff-api.d.ts:401-404` | Context lines. Every serious grep UI has them; Mesura Code shows one line |
| `GrepMode: "fuzzy"` | `fff-api.d.ts:360` | Smith-Waterman per line. A fuzzy content search is a distinctive feature |
| `GrepOptions.classifyDefinitions` → `GrepMatch.isDefinition` | `fff-api.d.ts:406-412`, `:452` | Marks a match line as a code definition, so definitions can be ranked first without a JS regex port |
| `GrepOptions.maxFileSize` | `fff-api.d.ts:383` | Defaults to 10 MB. A file manager browsing logs or datasets needs this configurable |
| Grep constraint syntax (`*.ts pattern`, `src/ pattern`) | `finder.d.ts:184-186` | Glob and directory filters, already in the engine. Mesura Code neither documents nor surfaces it |
| `GrepMatch.gitStatus`, `.size`, `.modified`, `.isBinary`, `.totalFrecencyScore` | `fff-api.d.ts:417-435` | Rich per-match file metadata, all discarded by `WorkspaceSearchIndex.ts:506-511` |
| `glob(pattern, options)` | `finder.d.ts:128` | SIMD glob prefilter with no fuzzy matching, "100 % compatible to npm `glob`". A file manager wants exactly this for `*.png`-style filtering |
| `SearchResult.location` (`file.ts:42:10`) | `fff-api.d.ts:186-217` | The engine parses `path:line:col` out of the query. A file manager could jump straight to a line |
| `SearchOptions.currentFile`, `comboBoostMultiplier`, `minComboCount` | `fff-api.d.ts:107-120` | Deprioritize the current file; boost query-history combos |
| `Score` breakdown | `fff-api.d.ts:161-182` | Nine ranking components. The file manager already maps these into `scoreBreakdown` and shows none |
| `refreshGitStatus()` | `finder.d.ts:307` | Refresh the git cache; returns the count of updated files |
| `getHistoricalQuery(offset)` | `finder.d.ts:324` | Query history — a finder could offer ↑ for the previous query |
| `getScanProgress()` → `{ scannedFilesCount, isScanning, isWatcherReady, isWarmupComplete }` | `fff-api.d.ts:287-296` | A real progress indicator instead of a boolean "Scanning…" |
| `healthCheck()` | `finder.d.ts:332` | Diagnostics: git availability, indexed-file count, DB sizes |
| `InitOptions.disableWatch` | `fff-api.d.ts:63-68` | **The file manager currently passes `watch: false`** (`fuzzyfinder.cpp:139`). Enabling the watcher keeps the index fresh without a rescan |
| `InitOptions.cacheBudgetMaxFiles` / `MaxBytes` / `MaxFileSize` | `fff-api.d.ts:82-90` | Direct control of the content-cache memory budget. **This is the lever that makes indexed grep affordable in a file manager** (see §B.4) |

### B.3 Measured cost — indexed grep vs `ripgrep`

Measured on this machine (Arch Linux, `ripgrep` 15.2.0, `@ff-labs/fff-node`
0.9.4, Node 26.7). `fff` was configured exactly as Mesura Code configures it —
`disableMmapCache: true`, `enableFsRootScanning: true`,
`enableHomeDirScanning: true` — varying only `disableContentIndexing`. The
benchmark script ran from a temporary file that was deleted afterwards; both
repositories are unmodified.

**Tree A — `mesura-code`, a git repository (16 160 files honouring `.gitignore`).**

| Measurement | `fff` paths-only | `fff` content | `ripgrep` |
|---|---|---|---|
| Index build (to `waitForIndexReady`) | 63 ms | 212 ms | n/a |
| RSS after index | 95 MB | 93 MB | n/a |
| First grep for `WorkspaceSearchIndex` | n/a | 21 ms | 24 ms total (0.20 s CPU across threads) |
| Second grep, same query | n/a | 10 ms | 24 ms (no state kept) |
| Files actually opened | n/a | 356 | 3 149 |
| RSS after grep | n/a | 124 MB | 10 MB |

**Tree B — `/usr/include`, not a git repository, no ignore file (44 282 files, 585 MB).**

| Measurement | `fff` paths-only | `fff` content | `ripgrep` |
|---|---|---|---|
| Index build | 110 ms | 916 ms | n/a |
| RSS after index | 70 MB | 109 MB | n/a |
| Grep for `PTHREAD_MUTEX_INITIALIZER` | n/a | 10 ms | 53 ms total (0.28 s CPU) |
| Second grep | n/a | 5 ms | 53 ms |
| Files opened | n/a | 1 534 | 44 282 |
| RSS after grep | n/a | **280 MB** | **10 MB** |

**What the numbers say.**

1. **The content index does prune.** On tree A it cut the candidate set from
   3 149 files to 356 — that is the bigram content index doing its job. Per
   keystroke, `fff` is genuinely faster (10–21 ms vs 24–53 ms) and the gap widens
   as the tree grows.
2. **The index is not free.** Enabling content indexing cost **8.3× the scan
   time** on tree B (110 ms → 916 ms) and **+39 MB resident** before a single
   search ran.
3. **Grep working memory is the real cost.** One grep over tree B took RSS from
   109 MB to **280 MB** — and `disableMmapCache: true` was set, so this is not
   the mmap warm cache. `ripgrep` did the same job in **10 MB**, a 28× ratio.
4. **End-to-end for a single search, `ripgrep` wins outright on tree B**:
   53 ms and 10 MB against 926 ms and 280 MB. `fff` only wins once the index cost
   is amortized over many searches in the same directory.

**Freshness.** `ripgrep` reads the filesystem at the moment of the search, so it
is never stale. `fff`'s index is a snapshot, refreshed by `scanFiles()` or by the
background watcher — and the file manager currently passes `watch: false`
(`fuzzyfinder.cpp:139`), so its index is stale the instant a file changes. A file
manager is *the tool that changes files*: the user renames, deletes, extracts an
archive, and then searches. Serving stale grep hits from a file manager is worse
than serving them from an editor.

### B.4 Recommendation for the file manager's grep

**Ship `ripgrep` as a subprocess. Do not enable `fff` content indexing.**

The reasoning, in order of weight:

1. **The workload is wrong for an index.** Mesura Code greps *one project root*
   that is already open, already indexed for the file picker, and will be
   searched many times over a long session. A file manager greps *whatever
   directory the user is standing in*, usually once, then moves on. The index
   cost is paid every time and amortized never.
2. **The memory profile is unacceptable for a resident daemon.** Decision D3
   settles on a single long-lived window backed by a resident process. A grep
   over one large directory taking that process to 280 MB — and holding it for
   the 15 minutes of an idle TTL — is a cost the daemon should not carry.
   `ripgrep` costs zero until invoked and returns to zero when it exits.
3. **Freshness is a correctness requirement here, not a nicety.**
4. **`ripgrep` has the features the user will ask for next**, already: `-g`
   globs, `-t` type filters, `-C` context lines, `--multiline`, `-w` whole word
   with correct semantics, `--json` for structured output, `--hidden`,
   `--no-ignore`, `-z` for compressed files. Every one of them is a flag rather
   than an engine change.
5. **`--json` gives the same result shape** Mesura Code builds by hand.
   `rg --json` emits one `match` object per line with `line_number`,
   `lines.text`, and `submatches[].start`/`.end` as **byte offsets** — the exact
   shape of `ProjectContentMatch` plus the same byte-to-string conversion problem
   (`mapContentMatchRanges`, `WorkspaceSearchIndex.ts:247`). Port that function
   as-is.
6. **`ripgrep` is already installed here** and is a normal Linux dependency, so
   there is no native-module packaging problem — which is a real problem for
   `fff` (see §D.4).

**What to copy from Mesura Code's design anyway** — the *interface* is right even
though the *engine* choice is not:

- The **250 ms time budget** and a hard match limit. With `ripgrep` this becomes
  "kill the child process when the budget expires", which is simpler than a
  cursor loop.
- **`maxMatchesPerFile`** so one dense file cannot own the page (`rg -m N`).
- **Grouping by file with a sticky header** and a per-file match count.
- **Windowed row mounting** (`VISIBLE_MATCH_WINDOW = 100`). The file manager will
  syntax-highlight lines too, and will hit the same stall.
- **The whole-word post-filter** (`isWholeWordRange`) — but only if the file
  manager does its own filtering. `rg -w` already implements the correct rule, so
  prefer the flag.
- **Blocking Enter while a newer query is in flight** (`canOpenMatches`).
- **The regex fallback story.** `fff` silently degrades to literal matching and
  reports the error; `ripgrep` exits non-zero with the compile error on stderr.
  Show the same `"Invalid regular expression"` state, driven by the exit code.
- **Whitespace is significant** in the query; do not trim it on the wire.
- **Reset on directory change**, the way the dialog resets on workspace change.

**Keep one door open.** If a future measurement shows repeat-search latency
matters (the user greps the same project repeatedly), `fff` content indexing can
be added *behind the same result contract* for directories that are git
repositories, with `cacheBudgetMaxBytes` set to a hard ceiling
(`fff-api.d.ts:87-88`) — the lever Mesura Code does not use. Design the grep
result type as a plain `{ path, lineNumber, lineContent, matchRanges }` array
now, exactly like `ProjectContentMatch` (`project.ts:58-64`), so the backend can
be swapped without touching the UI.

---

## C — The command palette

### C.1 Mesura Code's palette

**One overlay, three mutually exclusive modes.** The reducer is the whole
architecture (`mesura/apps/web/src/components/CommandPalette.logic.ts:38-77`):

```
SearchOverlayMode = "command" | "files" | "content"
```

`reduceCommandPaletteUiState` guarantees the three surfaces can never stack, and
that re-pressing a mode's shortcut toggles it closed (`ToggleMode`, `:66-69`).
`SetOpen(true)` always lands on `"command"`. The mode-to-shortcut mapping is a
three-entry table (`CommandPalette.tsx:382-386`):

| Command | Mode |
|---|---|
| `commandPalette.toggle` | `command` |
| `filePicker.toggle` | `files` |
| `projectSearch.toggle` | `content` |

**How commands are registered.** They are **not** registered — they are *built
imperatively into an array on every render*. `CommandPalette.tsx:1489` declares
`const actionItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> =
[]` and the following 170 lines push into it (`:1497` … `:1639`). Gating is a
plain `if` around the `push` (for example `if (projects.length > 0)` at `:1491`,
`if (wslAddProjectEnvironmentOption)` at `:1586`) or a `disabled: <expr>` field
(`:1578`). There is **no `when`-expression language for commands**.

An item's shape (`CommandPalette.logic.ts:85-113`):

```
{ kind: "action" | "submenu", value, searchTerms[], title, description?,
  icon, disabled?, timestamp?, titleLeadingContent?, titleTrailingContent?,
  shortcutCommand?,
  // action:
  keepOpen?, run: () => Promise<void>
  // submenu:
  addonIcon, groups[], initialQuery? }
```

**`when` expressions exist — but for keybindings, not commands.** The `when`
language lives in `mesura/packages/contracts/src/keybindings.ts:143-170` as a
four-node AST — `identifier`, `not`, `and`, `or` — capped at depth 64 and 256
characters. `evaluateWhenNode` (`mesura/apps/web/src/keybindings.ts:140`)
evaluates it against a flat boolean context; `true`/`false` are reserved
identifiers and any unknown identifier is `false`. The context in use today is
four booleans: `terminalFocus`, `terminalOpen`, `previewFocus`, `previewOpen`
(`keybindings.ts:29-35`).

`resolveShortcutCommand` (`keybindings.ts:214`) walks the rules **backwards** —
last rule wins — skipping any whose `when` is false, and returns the first
command whose shortcut matches. `findEffectiveShortcutForCommand` (`:177`) walks
backwards too but additionally tracks a `claimedShortcuts` set, so a command
whose binding has been shadowed by a later rule reports *no* shortcut rather than
a lie. That is how `CommandPaletteResultRow` can render the correct shortcut
label next to a palette row (`CommandPaletteResults.tsx:167-169`).

**Fuzzy matching of command names — there is none.** It is substring matching
with a rank. `filterCommandPaletteGroups` (`CommandPalette.logic.ts:291`):

1. A leading `>` switches to actions-only mode (`:298-299`), VS Code style.
2. `normalizeSearchText` lowercases, trims and collapses runs of whitespace
   (`:141`).
3. An item survives if `searchTerms.join(" ")` **contains** the normalized query
   (`:336-338`).
4. Rank = `1000 - fieldIndex * 100 + fieldRank`, where `fieldRank` is 3 for an
   exact field match, 2 for prefix, 1 for containment
   (`rankSearchFieldMatch`, `:258`; `rankCommandPaletteItemMatch`, `:272`).
   So earlier `searchTerms` entries dominate later ones, and ties fall back to
   declaration order (`:347`).

`searchTerms` are hand-written synonym lists — for example the content-search
action carries `["search project", "find in files", "grep", "content search",
"text search"]` (`CommandPalette.tsx:1547-1553`). This is what makes the palette
feel like it understands intent; it is curation, not an algorithm.

**Grouping.** `buildRootGroups` (`CommandPalette.logic.ts:429`) produces at most
two root groups, `"actions"` and `"recent-threads"` (limit
`RECENT_THREAD_LIMIT = 12`, `:15`). With a non-empty query,
`filterCommandPaletteGroups` drops `recent-threads` and appends two live search
groups, `projects-search` and `threads-search` (`:317-332`). Submenus push a new
view (`kind: "submenu"` → `pushView`, `CommandPalette.tsx:2205`), and Backspace on
an empty query pops it (`:2194-2197`).

**Keyboard model.**

| Key | Effect | Where |
|---|---|---|
| `commandPalette.toggle` / `filePicker.toggle` / `projectSearch.toggle` | open or toggle the matching mode | global `keydown`, `CommandPalette.tsx:441-472` |
| `Escape` in a non-command mode | return to the command mode, not close | capture-phase `keydown`, `:428-442`; and the dialog's own `onOpenChange` guard, `:2189-2196` |
| `Escape` in the command mode | close | Base UI dialog default |
| `↑` / `↓` / `Enter` | navigate and run | Base UI `Autocomplete` |
| `Backspace` on an empty query in a submenu | pop the view | `:2194-2197` |
| `thread.jump.1…9` | run the Nth visible item directly | `:2156-2170` — resolved through the keybinding registry, then matched against `item.shortcutCommand` |
| `Mod+Enter` in the browse flow | submit the typed path instead of the highlighted row | `isPrimaryModifierPressed`, `:2152` |

Two separate listeners exist deliberately: a **capture-phase** one for Escape
(so it beats the dialog) and a **bubble-phase** one for the toggles (which bails
on `event.defaultPrevented`).

**How it composes with the keybinding registry.** Loosely, and in one direction.

- A palette item may name a `shortcutCommand`; the row then renders that
  command's live label through `shortcutLabelForCommand`
  (`CommandPaletteResults.tsx:167`). The label follows the user's customized
  binding automatically.
- The reverse does not hold: pressing a command's shortcut does **not** go
  through the palette. `chat.new` is handled by its own listener elsewhere; the
  palette's `run()` and the shortcut handler are two separate call sites that
  happen to do the same thing.
- `THREAD_JUMP_KEYBINDING_COMMANDS` is the exception: `enumerateCommandPaletteItems`
  (`CommandPalette.logic.ts:127`) stamps the first nine items with
  `thread.jump.1…9`, and `handleKeyDown` looks the item back up by
  `shortcutCommand` (`CommandPalette.tsx:2158-2168`). That is a genuine
  registry→palette dispatch, and it is the only one.

**Programmatic opening.** A `CustomEvent` bus on `window`
(`mesura/apps/web/src/commandPaletteBus.ts`) so any component can open the
palette without owning its state. `isCommandPaletteOpen()` reads
`document.querySelector("[data-command-palette]")` at event time rather than
subscribing to state.

**Error handling.** `executeItem` catches a rejected `run()` and raises a toast
(`CommandPalette.tsx:2213-2222`) — a palette item can never take the app down.

### C.2 How well `KeyRegistry.js` would feed a palette

The file manager's registry is at
`fm/qml/Symmetria/FileManager/UI/modules/filemanager/handlers/KeyRegistry.js`
(587 lines). Its binding shape is declared in the header (`:57-64`):

```
{ id, keys:[Qt.Key_*...], mods, keycap, label, icon, group,
  when?(ctx)->bool, run(ctx) }
```

**Field-by-field fit against `CommandPaletteActionItem`:**

| Palette field | Registry field | Fit |
|---|---|---|
| `value` (stable id) | `id` (`"finder.fuzzy"`, `"help.open"`, `"match.next"`) | **Exact.** Already namespaced |
| `title` | `label` (`"Fuzzy finder"`, `"Toggle hidden files"`) | **Exact.** Human sentences already |
| `icon` | `icon` (Material glyph names) | **Exact** |
| group label | `group`, ordered by `HELP_GROUPS` (`:456-457`) | **Exact.** Eleven canonical groups, test-enforced |
| `shortcutCommand` → label | `keycap` (`"⌃e"`, `"⇧N"`, `"?"`) | **Exact**, and already rendered as keycaps by `HelpPopup.qml` |
| `run()` | `run(ctx)` | **Exact in shape, wrong in argument.** See below |
| `disabled` / gating | `when(ctx)` | **Exact in shape, wrong in semantics.** See below |
| `searchTerms` | **missing** | The one field with no counterpart |
| `description` | **missing** | Optional |

**Three changes are needed, and only three.**

1. **Add `searchTerms`.** This is the field that makes Mesura Code's palette feel
   intelligent, and it is pure curation: `"Fuzzy finder"` should also match
   `find`, `search`, `goto file`, `quick open`. Cheap to add, and the existing
   `KeyRegistryTest` can be extended to require it — the test already fails a
   row that lacks help metadata or uses an unknown `group`.

2. **Change what `when()` means, carefully.** In the registry, a false `when()`
   means *"do not consume this key; let it fall through"* — that is load-bearing
   and documented (`:59-62`, `:576-578`); it is what preserves `n`/`N` fall-through
   and the tree's Escape-propagates-to-close. A palette needs a different
   question: *"should this row be shown, or shown greyed out?"* Reusing `when()`
   for both would be wrong — a row can be legitimately unbound-but-runnable.
   **Add a separate optional `enabled(ctx)`** for palette display, and leave
   `when()` alone. Note that Mesura Code has exactly this split: `when` gates
   *keybindings*, `disabled` gates *palette rows*, and they are different
   mechanisms.

3. **Widen `ctx`.** Today `ctx` is built inside a view's `Keys.onPressed` and
   carries the view root, the `ListView`, `windowState`, `viewKind`, two process
   runners, injected services and four view-adapter callbacks (`:41-54`). A
   palette invoked from anywhere must be able to build the same `ctx`. This is
   the only structural work, and the registry's own dependency-injection design
   makes it tractable — the header already states that dispatch is hermetically
   testable because singletons arrive through `ctx.services` (`:17-24`).

**What already works and needs nothing.**

- **Two consumers, one array** is already proven. `HelpPopup.qml` reads
  `KeyRegistry.HELP_GROUPS`, `KeyRegistry.bindingsFor(kind)`,
  `KeyRegistry.MODES` and `KeyRegistry.isSuppressedInPicker`
  (`fm/qml/.../HelpPopup.qml:65-84`). A palette would be the third consumer of
  the same array — exactly the pattern Mesura Code lacks, where the palette item
  and the shortcut handler are two call sites.
- **Context-sensitive hiding** already exists as `isSuppressedInPicker(binding,
  fileManager)` (`KeyRegistry.js:545-568`), which mirrors the picker pre-pass
  exemptions exactly *so the cheat-sheet never lies*. A palette would reuse it
  verbatim.
- **View scoping** — `CORE` / `MILLER_ONLY` / `TREE_ONLY` via
  `bindingsFor(viewKind)` (`:445-447`) — is a better model than Mesura Code's
  `if`-guarded pushes, because it is declarative and testable.
- **Chords already have a menu model.** `windowState.chordBindings` renders as
  both the `WhichKeyPopup` HUD and the `HelpPopup` sections. That maps one-to-one
  onto Mesura Code's `kind: "submenu"` items.

**Where the registry is genuinely ahead of Mesura Code.** Mesura Code's palette
is a 170-line imperative `push` block with no test that a row has an icon, a
group or a searchable label. `KeyRegistryTest` already fails a row that lacks
help metadata, uses an unrenderable `group`, or collides with another
unconditional row on the same key+mods. **Do not regress to Mesura Code's
imperative array.**

### C.3 Recommendation

Build the palette as a **third consumer of `KeyRegistry`**, not as a parallel
command list. Copy from Mesura Code:

- the **one-overlay / three-modes reducer** (`SearchOverlayMode` and
  `reduceCommandPaletteUiState`) so palette, finder and grep can never stack, and
  each shortcut toggles its own mode closed;
- the **`>` prefix** for actions-only filtering;
- the **rank formula** — earlier `searchTerms` field wins, exact beats prefix
  beats containment, ties by declaration order. Substring matching is the right
  choice for command names; a fuzzy matcher over a 60-item list adds noise;
- **`searchTerms` as curated synonym lists**;
- **the shortcut label rendered on the row**, resolved live so it follows a
  rebinding;
- **`keepOpen`** for items that reconfigure the palette rather than dismiss it;
- **the toast on a rejected `run()`**;
- **the `CustomEvent` bus** so any surface can open the palette without owning
  its state.

Do **not** copy the imperative item array or the Base UI `Autocomplete`
dependency.

---

## D — What a separate repository can reuse

Decision **D1** puts the file manager in its own repository, consumed by Mesura
Code as published packages. That makes provenance the first question.

### D.1 Upstream (`pingdotgg/t3code`) versus fork-owned

Checked with `git diff upstream/main -- <path>` at `mesura-code` `69f13f9c8`:

| File | Exists upstream | Fork delta |
|---|---|---|
| `apps/web/src/components/files/ProjectFilePicker.tsx` | yes | **none** |
| `apps/web/src/components/files/ProjectFilePicker.logic.ts` | yes | **none** |
| `apps/web/src/components/files/projectFilesQueryState.ts` | yes | **none** |
| `apps/web/src/components/search/ProjectContentSearchDialog.tsx` | yes | **none** |
| `apps/server/src/workspace/WorkspaceSearchIndex.ts` | yes | **none** |
| `packages/contracts/src/project.ts` | yes | **none** |
| `apps/web/src/components/CommandPalette.logic.ts` | yes | **none** |
| `patches/@ff-labs__fff-node@0.9.4.patch` | yes | **none** |
| `apps/web/src/components/CommandPalette.tsx` | yes | fork-modified, 33 lines |
| `apps/web/src/keybindings.ts` | yes | fork-modified, 13 lines |
| `packages/contracts/src/keybindings.ts` | yes | fork-modified, 19 lines |

**Every search surface is upstream-owned and untouched by the fork.** The fork's
only deltas in this area are added keybinding *commands*
(`usage.peek`, `traitsPicker.toggle`, `workspacePicker.toggle`,
`branchPicker.toggle`, `chat.scrollHalfPageUp/Down`) and their palette wiring.

**The consequence is decisive for D.** Anything the file manager takes from
these files is code it will maintain **against a moving upstream it does not
control**. A shared package that *lives in Mesura Code* and is imported by the
file manager would put the file manager's daily-driver tool on upstream's
release cadence — the exact coupling D1 exists to prevent. Therefore: **the file
manager copies patterns; it never imports from `mesura/apps/*`.**

### D.2 Per surface

| Surface | Verdict | Reasoning |
|---|---|---|
| **Engine access** (create the index, search, grep, track frecency, map results) | **Shared package, owned by the file-manager repository** | This is the one genuinely shared concern: both products call the same engine and both must agree on the frecency store (decision D2). Publish it from the file-manager repository under D1's model, and have Mesura Code consume it. Note this **inverts** today's direction — Mesura Code's `WorkspaceSearchIndex.ts` would become a thin Effect wrapper over the shared package |
| **File-search UI** | **Copy the pattern, reimplement** | Mesura Code's picker is 163 lines and every one of them binds to something the file manager does not have: `useAtomValue` + Effect Atom, `useActiveProjectTarget` (threads and environments), `useRightPanelStore`, `PierreEntryIcon`, Base UI `Autocomplete`, Tailwind class strings tied to `--t3-*` tokens. The file manager's own finder is *better* (§A.3) and already exists as a design. Copy six specific corrections, not the component |
| **Grep backend** | **Design its own** | §B.4. Different engine (`ripgrep`), different lifecycle, different freshness requirement. Only the *result type* is shared, and it is four fields |
| **Grep UI** | **Copy the pattern, reimplement** | The grouping, sticky headers, windowed mounting, whole-word rule and in-flight Enter guard are all worth copying as *behaviour*. The component is welded to Shiki-through-`@pierre/diffs`, `ScrollArea`, `Toggle`, `Tooltip` and `CommandPaletteContent` |
| **Command palette** | **Design its own, on `KeyRegistry`** | §C.3. The file manager's registry is a better foundation than Mesura Code's imperative array. Copy the mode reducer, the `>` prefix, the rank formula and the shortcut-label rendering |
| **Keybinding `when` AST** | **Copy the pattern** if user-editable keybindings are ever wanted | `packages/contracts/src/keybindings.ts:143-170` is a clean four-node AST with a depth cap and forward-compatible decoding (unknown commands are dropped, not fatal). It is 30 lines. The FM's `when(ctx)` closures are more powerful and less serializable; adopt the AST only when bindings must round-trip through a config file |
| **`normalizeSearchQuery`** | **Copy** (12 lines) | `mesura/packages/shared/src/searchRanking.ts:7`. The `trimLeadingPattern: /^[@./]+/` behaviour is worth having; the file is upstream-owned |
| **The `@ff-labs/fff-node` asar patch** | **Copy** | See D.4 |

### D.3 What the file manager should copy verbatim as logic

Small, self-contained, correct, and each one encodes a bug someone already hit:

1. `isWholeWordRange` (`WorkspaceSearchIndex.ts:268`) — only if not using `rg -w`.
2. `mapContentMatchRanges` (`:247`) — byte offsets to string indices. **Needed
   regardless of engine**, because `rg --json` also reports byte offsets.
3. `buildContentSearchQuery` (`:233`) — the smart-case-vs-`(?i)` split.
4. `findMatchIndices` (`ProjectFilePicker.logic.ts:22`) — but the file manager
   already has this in C++ (`computeMatchIndices`, `fuzzyfinder.cpp:35`) and will
   need a TypeScript port.
5. `normalizeRanges` + `splitToken` (`HighlightedSearchLine.tsx:29`, `:52`) —
   overlaying match ranges on syntax-highlighted tokens. The file manager will
   hit this exact problem when it highlights grep result lines with Shiki
   (see report 13).
6. `reduceCommandPaletteUiState` (`CommandPalette.logic.ts:57`) — 20 lines,
   zero dependencies.
7. `evaluateWhenNode` (`mesura/apps/web/src/keybindings.ts:140`) — 14 lines.

### D.4 The packaging trap, recorded

If the file manager ever does bundle `@ff-labs/fff-node` in Electron, it inherits
a problem Mesura Code already solved. The native library resolves to a path
inside `app.asar`, which cannot be `dlopen`ed. Mesura Code patches the package —
`mesura/patches/@ff-labs__fff-node@0.9.4.patch` adds `resolveUnpackedAsarPath`,
which rewrites the last `.asar` path segment to `.asar.unpacked`. Beyond the
patch, `mesura/scripts/build-desktop-artifact.ts` also has to enumerate every
platform binary package by name (`:1069-1081`), ship the server tree as a
separate `server.asar` on Windows (`:2267-2276`), and run a **native-load probe**
against the packaged artifact (`:2436-2467`) because the failure is silent
otherwise.

This is a strong secondary argument for `ripgrep`-as-subprocess for grep: a
system binary or a single shipped executable has none of this. It is *not* an
argument against `fff` for file search — that value is already proven, and the
patch is copyable.

---

## E — Recommendations

### E.1 File search

**Keep the file manager's finder as the design. Port it to React as-is, then
apply six corrections from Mesura Code.**

The finder already wins on the things that matter: a live preview of the
highlighted result (which Mesura Code has no equivalent of anywhere), git status,
directories in results, real frecency writes, vim navigation keys, and a
two-stage debounce that separates cheap search from expensive preview.

Adopt: report `matchedQuery`; report and display `truncated`; distinguish
"indexing" from "searching"; key the index by base path with an idle TTL instead
of one process-wide engine; share one dialog chrome with the other two surfaces.
Fix the two gaps neither product has: in-popup directory drill, and preview
scroll keys.

### E.2 Grep

**`ripgrep` as a subprocess. Not `fff` content indexing.**

Measured: on a 44 282-file tree, `fff` costs 916 ms of index build and reaches
280 MB resident after one search; `ripgrep` answers in 53 ms at 10 MB. The index
only pays back across many searches of one directory, which is Mesura Code's
workload and not a file manager's. `ripgrep` is also never stale — and a file
manager is the tool that makes files change.

Copy Mesura Code's *interface* design wholesale: the 250 ms budget, the
per-file match cap, grouping under sticky per-file headers with a match count,
windowed row mounting at 100, the whole-word semantics, blocking Enter while a
newer query is in flight, and treating whitespace in the query as significant.
Define the result type as `{ path, lineNumber, lineContent, matchRanges }` so the
backend stays swappable.

### E.3 Command palette

**Build it as a third consumer of `KeyRegistry.js`.**

The registry already carries `id`, `label`, `icon`, `group`, `keycap` and a
run body, is already read by two consumers, already has an ordered group list and
a context-sensitive hiding rule, and is already guarded by a test that fails
incomplete rows. Three additions make it a palette source: `searchTerms`, a
separate `enabled(ctx)` for display gating (leave `when()` alone — its
fall-through semantics are load-bearing), and a `ctx` that can be built outside a
view's key handler.

From Mesura Code take the one-overlay/three-modes reducer, the `>` actions-only
prefix, the substring-plus-rank matcher, curated `searchTerms`, live shortcut
labels on rows, `keepOpen`, the toast on a failed `run()`, and the `CustomEvent`
open bus.

---

## F — Can one `packages/file-search` serve both products?

It can serve both products' **engine access** and their **result shape**. It
cannot serve their **search UI**, and attempting it would trade a small
duplication for a large coupling.

What genuinely generalizes is the layer directly above `@ff-labs/fff-node`: index
creation and configuration, index identity and lifetime (keyed by base path, with
an idle TTL — Mesura Code's `LayerMap` model is right and the file manager's
process-wide singleton is not), waiting for readiness, the search calls, the
mapping from `FileItem`/`DirItem`/`MixedItem` to a neutral entry type, match-index
computation, the byte-offset-to-string-index conversion, the frecency write
through `trackQuery`, and — critically — **one place that owns the frecency-store
path**, which is what decision D2 actually requires and which no code in either
repository implements today. That layer is perhaps 400 lines, has one runtime
dependency, and both products would consume it identically. Under D1 it should be
published *from the file-manager repository*, because Mesura Code's own copy is
upstream-owned and unmodified: putting the shared code there would bind the
file manager to `pingdotgg/t3code`'s release cadence, which is precisely the
coupling D1 exists to prevent.

What does not generalize is everything above that line. Mesura Code's picker is
163 lines and every one binds to Effect Atom, TanStack Router, Base UI's
`Autocomplete`, the `useRightPanelStore` singleton, `PierreEntryIcon`, and
Tailwind classes tied to `--t3-*` tokens; the two products also disagree on what
a result *is* (Mesura Code excludes directories by contract and opens into a
thread's right panel; the file manager includes them and navigates a pane), and
on the finder's job (Mesura Code's picker is a jump-to-file; the file manager's
is a browse-and-inspect surface built around a preview Mesura Code does not
have). The same split holds for grep, where the two should not even share an
engine (§B.4), and for the palette, where the file manager's `KeyRegistry` is the
better source and Mesura Code's imperative array is the thing to avoid. So: one
shared package for the engine and the result shape, published from the
file-manager repository; two independent UIs, with the patterns copied and the
components not.
