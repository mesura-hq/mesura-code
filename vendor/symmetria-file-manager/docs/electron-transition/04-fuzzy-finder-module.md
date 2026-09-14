# 04 — The fuzzy finder as a shared module

Research document. Read-only investigation across three repositories.

- File manager: `/home/jc/.t3/worktrees/symmetria-file-manager/t3code-a2a6aa9b`
- Symmetria IDE: `/home/jc/projects/symmetria-ide`
- Mesura Code: `/home/jc/projects/mesura-code`

## Headline

The question "can the fuzzy finder become a standalone, reusable module?" has a
answer that the investigation did not expect: **it already is one, and Mesura
Code already consumes it.**

- The file manager's `FuzzyFinder` is a thin C++ wrapper over the Rust `fff`
  engine, reached through the `fff-c` C ABI.
- Upstream `fff` publishes `@ff-labs/fff-node` on npm. That package loads the
  **same** `libfff_c` shared library through `ffi-rs`, with prebuilt binaries for
  eight platform triples.
- `apps/server` in Mesura Code declares `"@ff-labs/fff-node": "0.9.4"`
  (`/home/jc/projects/mesura-code/apps/server/package.json:30`) and wraps it in a
  full Effect service, `WorkspaceSearchIndex`.
- Mesura Code even carries a pnpm patch that fixes the library's
  `app.asar.unpacked` path resolution
  (`/home/jc/projects/mesura-code/patches/@ff-labs__fff-node@0.9.4.patch`).

The reusable module therefore does not need to be built. It needs to be
**recognised, aligned, and completed**. The parts that are genuinely missing are
frecency configuration, git status transport, match positions, and a shared
result contract — not the engine and not the packaging.

---

# Part A — the current fff integration in the file manager

## A.1 Where the code lives

| Concern | Path |
|---|---|
| QML element wrapper | `plugin/src/Symmetria/FileManager/Models/fuzzyfinder.hpp`, `fuzzyfinder.cpp` |
| Vendored engine (git submodule) | `plugin/third_party/fff` (pinned `8092cfa3`, fff v0.9.3) |
| C ABI header | `plugin/third_party/fff/crates/fff-c/include/fff.h` (cbindgen-generated, 1350 lines) |
| Corrosion wiring | `plugin/CMakeLists.txt:22-41` |
| Link + install | `plugin/src/Symmetria/FileManager/Models/CMakeLists.txt:29-31`, `:34-37`, `:56-58`, `:76` |
| Popup | `qml/Symmetria/FileManager/UI/modules/filemanager/FuzzyFinderPopup.qml` |
| Row delegate | `.../FuzzyFinderResultDelegate.qml` |
| Info pane | `.../FuzzyFinderInfoPanel.qml` |
| Tests | `plugin/tests/FuzzyFinderTest.cpp` |

**Worktree caveat.** In this worktree the submodule is **not checked out** —
`plugin/third_party/fff` is empty and `git submodule status` reports
`-8092cfa3…`. All fff source citations below therefore point at the main clone
at `/home/jc/projects/symmetria-file-manager/plugin/third_party/fff`, which has
the same pinned commit checked out. Run `git submodule update --init --recursive`
before building in this worktree.

## A.2 Build topology

`plugin/CMakeLists.txt:30-41` fetches Corrosion v0.6.1 with `FetchContent` at
configure time, then imports one crate:

```cmake
corrosion_import_crate(
    MANIFEST_PATH "${CMAKE_CURRENT_LIST_DIR}/third_party/fff/Cargo.toml"
    CRATES fff-c
    PROFILE release
)
```

Three consequences a change must respect.

1. `CRATES fff-c` excludes the workspace's Lua, MCP, and grep binaries, so the
   build never compiles `mlua`/LuaJIT.
2. `PROFILE release` is forced. A debug build of the SIMD matcher would remove
   the reason the engine was adopted.
3. Corrosion renames the crate target `fff-c` to `fff_c`, so the link line in
   `plugin/src/Symmetria/FileManager/Models/CMakeLists.txt:31` reads `fff_c`
   while the `CRATES` filter reads `fff-c`.

The plugin sets `INSTALL_RPATH "$ORIGIN"`
(`plugin/src/Symmetria/FileManager/Models/CMakeLists.txt:56-58`) and installs
`libfff_c.so` beside the module through `corrosion_install` (`:76`). Without the
rpath, **every** consumer of `Symmetria.FileManager.Models` fails to load the
whole module — the file manager, Symmetria Shell's wallpaper picker and file
dialog, and Symmetria IDE.

`fff-c` declares `crate-type = ["cdylib"]` only
(`.../crates/fff-c/Cargo.toml:8-9`). There is no `rlib`, so a future Rust
consumer must depend on `fff-search` (the `fff-core` crate) directly rather than
on `fff-c`.

## A.3 The `extern "C"` wrap

`fuzzyfinder.cpp:15-20`:

```cpp
extern "C" {
#include "fff.h"
}
```

The cbindgen config at `.../crates/fff-c/cbindgen.toml` sets `language = "C"` but
never emits a `__cplusplus` guard. Without the wrap, the C++ compiler mangles
every `fff_*` symbol and the link against `libfff_c.so` fails with undefined
references. The upstream fix is `cpp_compat = true` in that cbindgen config.

## A.4 The C ABI surface the file manager uses

The header exports about 80 functions. The file manager calls **eight**.

| Function | Call site | Arguments | Semantics |
|---|---|---|---|
| `fff_create_instance_with` | `fuzzyfinder.cpp:146` | `const FffCreateOptions*` | Creates the engine instance. Returns `FffResult*`; the instance lives in `->handle`. Versioned options struct; new fields are appended without an ABI break. |
| `fff_wait_for_scan` | `fuzzyfinder.cpp:157`, `:185` | `(void* handle, uint64_t timeout_ms)` | Blocks until the initial index finishes. `->int_value` is `1` for completed and `0` for timed out. The file manager passes 30000 ms and only warns on timeout. |
| `fff_restart_index` | `fuzzyfinder.cpp:178` | `(void* handle, const char* new_path)` | Re-points the existing engine at a new directory. Success flag only, no payload. |
| `fff_search_mixed` | `fuzzyfinder.cpp:438` | `(handle, query, current_file, max_threads, page_index, page_size, combo_boost_multiplier, min_combo_count)` | Files **and** directories in one flat list, interleaved by descending total score. `->handle` is a `FffMixedSearchResult*`. |
| `fff_track_query` | `fuzzyfinder.cpp:504` | `(handle, query, file_path)` | Records that `file_path` was opened for `query`. `->int_value` is `1` on success. The record is keyed on `hash(project_path + "::" + query)`; the absolute path is the selection it stores, **not** the key. |
| `fff_free_mixed_search_result` | `fuzzyfinder.cpp:466` | `FffMixedSearchResult*` | Frees the struct, both arrays, and every heap string inside them. |
| `fff_free_result` | `fuzzyfinder.cpp:151`, `:166`, `:180`, `:190`, `:469`, `:505` | `FffResult*` | Frees the envelope only. It does **not** free `->handle`. |
| `fff_destroy` | `fuzzyfinder.cpp:171` (deleter) | `void* handle` | Destroys the instance. In practice never runs — see A.5. |

### The result envelope

Every `fff_*` call returns a heap `FffResult*` with four fields: `bool success`,
`char* error`, `void* handle`, `int64_t int_value`
(`.../include/fff.h:42-60`). The payload field varies per function; the header
carries the mapping table at `fff.h:24-40`. Freeing the envelope and freeing the
payload are two separate calls, which is why `fuzzyfinder.cpp:466-469` calls
`fff_free_mixed_search_result` before `fff_free_result`.

### The options struct

`fuzzyfinder.cpp:134-144` populates `FffCreateOptions` (declared at
`fff.h:66-131`):

```cpp
opts.version                  = FFF_CREATE_OPTIONS_VERSION;   // 1
opts.base_path                = base.constData();
opts.frecency_db_path         = frecency.constData();
opts.history_db_path          = history.constData();
opts.enable_mmap_cache        = false;
opts.enable_content_indexing  = false;
opts.watch                    = false;
opts.ai_mode                  = false;
opts.enable_fs_root_scanning  = true;
opts.enable_home_dir_scanning = true;
```

Three of these deserve attention.

- `watch = false` disables fff's own filesystem watcher. The finder therefore
  sees a stale index between navigations. The file manager keeps its own
  `FileWatcher` for the Miller panes, so this trades index freshness for a
  smaller inotify budget.
- `enable_content_indexing = false` means `fff_live_grep` would run cold. The
  file manager never calls grep today.
- `enable_fs_root_scanning` and `enable_home_dir_scanning` are both `true`. The
  header warns that root scanning "floods the watcher with churn"
  (`fff.h:120-124`). With `watch = false` the churn does not materialise, but the
  scan cost remains.

### The ABI surface the file manager does NOT use

`fff_live_grep` and `fff_multi_grep` (content search with match ranges, context
lines, and definition classification), `fff_glob` (SIMD glob prefilter),
`fff_search_directories`, `fff_get_scan_progress`, `fff_refresh_git_status`,
`fff_get_historical_query`, `fff_health_check`. Grep is the single largest
unclaimed capability: `FffGrepMatch` (`fh.h:230-259`) already carries
`match_ranges`, `context_before`/`context_after`, `line_number`, `col`, and
`is_definition`.

## A.5 `FffEngine` — the process-wide singleton

`fuzzyfinder.cpp:105-202` defines an anonymous-namespace class `FffEngine` with a
`static FffEngine& instance()` Meyers singleton.

**Why it exists.** LMDB, through the `heed` crate, refuses to open the same
environment twice inside one process ("environment already open in this
program"). fff keeps its frecency and history databases in LMDB. One `fff`
instance per `FuzzyFinder` QML element would therefore fail the moment a second
finder opened. `fuzzyfinder.cpp:93-99` states this directly.

**Lifecycle.**

1. First `acquire(basePath, error)` creates the directory, fills
   `FffCreateOptions`, calls `fff_create_instance_with`, then blocks on
   `fff_wait_for_scan(handle, 30000)`.
2. The handle goes into `std::shared_ptr<void>` with a deleter that calls
   `fff_destroy` (`fuzzyfinder.cpp:171`).
3. Later `acquire` calls with a different `basePath` call `fff_restart_index`
   plus another `fff_wait_for_scan`.
4. The singleton is **never destroyed**. The deleter exists for completeness but
   the static outlives the process. The OS reclaims the memory at exit.

**The lock is deliberately coarse.** `QMutexLocker lock(&m_mutex)` at
`fuzzyfinder.cpp:125` is held across the whole 30-second `fff_wait_for_scan`.
The comment at `:118-123` forbids narrowing it: a second concurrent `acquire`
racing into `fff_create_instance_with` is exactly the LMDB failure the singleton
prevents. The wait only ever blocks a `QtConcurrent` worker thread, never the UI
thread.

**Known limitation, stated in the source.** Two finders open at once in
different directories share the one engine, so the last `acquire` wins the
indexed path (`fuzzyfinder.cpp:102-104`). This is transient and never crashes.
It matters in the IDE, where two `FuzzyFinder` instances can coexist — see Part B.

**Per-instance handle.** Each `FuzzyFinder` holds `std::shared_ptr<void> m_engine`
(`fuzzyfinder.hpp:153`), a copy of the singleton's handle. Each async search
captures its own copy (`fuzzyfinder.cpp:428`), so the engine cannot be freed
while a search is in flight on a worker thread. The destructor resets only the
instance's copy (`fuzzyfinder.cpp:209-216`).

## A.6 `fff_search_mixed` versus `fff_search`

`fff_search` is files-only (`fff.h:527-554`). `fff_search_mixed` returns
directories too, so the finder's directory-navigation behaviour survives
(`fuzzyfinder.hpp:22-24`). Both take the same eight parameters.

The file manager calls it with `current_file = nullptr`, `max_threads = 0`
(auto), `page_index = 0`, `page_size = MaxResults` (200,
`fuzzyfinder.hpp:132`), `combo_boost_multiplier = 0` (default 100), and
`min_combo_count = 0` (default 3) — `fuzzyfinder.cpp:438-441`.

`FffMixedItem` (`fff.h:352-388`) carries `item_type` (0 = file, 1 = directory),
`relative_path`, `display_name`, `git_status`, `size`, `modified`, three frecency
scores, and `is_binary`. The magic value 1 is named
`kFffItemTypeDirectory` at `fuzzyfinder.cpp:28`.

### The trailing-slash convention — and a documentation defect

fff stores directory paths **with a trailing `/`**. The core asserts this
directly: `crates/fff-core/src/file_picker.rs:219` reads "Dir items store the
relative path including trailing `'/'` (e.g. `\"src/components/\"`)". The path is
built at `file_picker.rs:2001` from `rel[..filename_offset]`, which retains the
separator.

`display_name` comes from `DirItem::dir_name`
(`crates/fff-core/src/types.rs:169-179`), which slices the stored path from
`last_segment_offset` to the end — **so it keeps the slash too**. The upstream
TypeScript declaration confirms it:
`packages/fff-node/src/fff-api.ts:227-233` documents `dirName` as
`"components/" for "src/components/"`.

Two problems follow.

1. **`CLAUDE.md` is wrong.** It states "The `name` role (`display_name`) is the
   bare last segment without a trailing slash." The test knows better:
   `plugin/tests/FuzzyFinderTest.cpp:175` reads "fff marks directory items with
   a trailing `\"/\"` in their display name", and `:180` asserts
   `name.endsWith(u'/')`.
2. **`FuzzyFinderResultDelegate.qml` has a latent off-by-one for directories.**
   `_trimTrailingSlash` (`:154-156`) strips the slash from `path` but not from
   `name`, then `_nameStart` (`:47-48`) computes
   `_trimmedPath.length - root.name.length`. For `src/components/` the trimmed
   path is 14 characters and the name is 11, giving `_nameStart = 3` where the
   correct split is 4. The parent-path half then renders `src` and the name half
   renders `/components`. The comment at `:150-153` documents the intended
   behaviour, so the code and its own comment disagree.

This is a real finding, not a style note. It should be fixed in the same change
that corrects the `CLAUDE.md` line. It is **not** fixed by this document.

## A.7 The QML contract

`FuzzyFinder` is a `QAbstractListModel`. Input properties: `searchPath`, `query`,
`showHidden`. Output properties: `scanning`, `loading`, `resultCount`, `error`
(`fuzzyfinder.hpp:74-82`).

Fourteen roles (`fuzzyfinder.hpp:85-101`, names at `:270-287`):

| Role | Source |
|---|---|
| `path` | `FffMixedItem.relative_path` |
| `name` | `FffMixedItem.display_name` |
| `isDir` | `item_type == 1` |
| `score` | `FffScore.total` |
| `matchIndices` | **recomputed in C++** — see below |
| `fullPath` | `searchPath + "/" + relative_path` |
| `size`, `modified`, `gitStatus`, `frecencyTotal`, `isBinary` | direct from `FffMixedItem` |
| `scoreBreakdown` | a `QVariantMap` of all ten `FffScore` fields (`fuzzyfinder.cpp:56-71`) |
| `matchType` | `FffScore.match_type` |
| `iconPath` | resolved lazily on the GUI thread by `IconThemeResolver` (`fuzzyfinder.cpp:249-265`) |

`showHidden` is **inert** on this backend. `FffCreateOptions` has no hidden
toggle; fff governs hidden and ignored files through its own ignore model. The
property is kept only for QML binding compatibility
(`fuzzyfinder.cpp:311-319`).

### Recomputed `matchIndices`

fff's file-search result carries no per-character match positions — only its grep
result does. `computeMatchIndices` (`fuzzyfinder.cpp:35-54`) recomputes them with
a greedy, case-insensitive subsequence walk over the relative path. If the query
is not a subsequence — for example a constraint query like `*.rs` or
`git:modified` — the function returns an empty vector and the popup renders the
path un-highlighted (`:51-52`).

This is a **known approximation**. The greedy first-match alignment can disagree
with the alignment the Rust matcher actually scored. The same approximation was
independently re-invented in Mesura Code — see Part C.

### Async plumbing

Both `startEngine` (`fuzzyfinder.cpp:355-412`) and `startSearch` (`:414-489`)
run on `QtConcurrent::run` with a `QFutureWatcher`, guarded by generation
counters `m_createGeneration` and `m_searchGeneration`. A stale future's
completion handler compares generations and returns early. `startEngine` bumps
**both** counters, so an in-flight search against the old engine is discarded.

An empty query is **not** short-circuited (`fuzzyfinder.cpp:417-418`). fff
answers it with the frecency-ranked file list, which is what the finder shows on
open — the fff.nvim behaviour.

### Popup behaviour

- `FuzzyFinderPopup.qml:49-52` declares one `FuzzyFinder { id: fuzzyModel }`
  inside the `Loader`'s `sourceComponent`, so the model exists only while the
  finder is open.
- `Component.onCompleted` sets `searchPath` from `windowState.currentPath`
  (`:42`); `Component.onDestruction` calls `clear()` (`:44`).
- The keystroke debounce is **100 ms** (`:350-358`).
- `_confirmSelection` reads the roles **before** `closeModal()`, because closing
  deactivates the `Loader` and clears the model (`:290-299`).
- `recordOpen(index, query)` fires on both the native and the embedder path
  (`:299`), so frecency keeps learning regardless of host.
- The embedder seam is `property bool externalActivation` plus
  `signal activated(string path, bool isDir)` (`:20-22`, branch at `:306-309`).

`FuzzyFinderInfoPanel.qml` debounces at **150 ms** (`:24-32`) and mints a
`FileInfo` from the selected `fullPath` (`:38-41`), driving the shared
`PreviewContent` router.

## A.8 The frecency store

`frecencyDbDir()` (`fuzzyfinder.cpp:83-89`):

1. `SYMMETRIA_FM_FRECENCY_DIR`, when set and non-empty, wins outright.
2. Otherwise `QStandardPaths::GenericDataLocation + "/symmetria/fff"`, which is
   `~/.local/share/symmetria/fff` on Linux.

Two LMDB environments live under it: `frecency/` and `history/`
(`fuzzyfinder.cpp:131-132`). fff creates them with `fs::create_dir_all`, so no
manual `mkdir` is needed; the code pre-creates only the parent defensively
(`:129`).

`fff_track_query(handle, query, absolutePath)` records the pair, and it feeds
**one** thing: the query history that drives the combo-match boost
(`FffScore.combo_match_boost`) and `fff_get_historical_query`.

⚠ It does **not** write the frecency database, and this document said it did.
`FffScore.frecency_boost` is written by `Frecency::track_access`, which is **not
among the 78 `fff_*` symbols the shipped `libfff_c.so` exports** — so no C-ABI
caller can reach it at all. Measured three ways in
`20-spike-search-topology.md` §2.1.

`FuzzyFinderTest` redirects the databases into a `QTemporaryDir` through the
environment variable (`plugin/tests/FuzzyFinderTest.cpp:74-77`), so the suite
never touches the user's real store.

### What git awareness fff provides

fff links `git2` with `vendored-libgit2` (root `Cargo.toml` workspace
dependency), so no system libgit2 is needed. Each `FffMixedItem` carries a
`git_status` string for files — `"M "`, `"??"`, and so on; directories always get
`""` (`crates/fff-c/src/ffi_types.rs:687`, `:699`). `fff_refresh_git_status`
exists to re-read the working tree and returns the number of updated files in
`->int_value`. The file manager surfaces `gitStatus` as a role but never calls
the refresh.

## A.9 What the Rust engine does that a pure-JS matcher would not

Five things, in rough order of value.

1. **A warm, resident index.** fff scans once and keeps the file list in a
   chunked, SIMD-friendly arena (`crates/fff-core/src/simd_path.rs`) with chunk
   deduplication. Per-keystroke cost is a scoring pass over resident memory, not
   a directory walk.
2. **A SIMD matcher.** fff uses `neo_frizbee` with the `match_end_col` feature
   (root `Cargo.toml`). The pinned workspace also builds with `lto = "fat"` and
   `codegen-units = 1`.
3. **Persistent frecency and query history in LMDB.** A JS matcher would have to
   reimplement both stores and both scoring terms.
4. **Git status per result**, from a vendored libgit2.
5. **A structured score breakdown** — ten fields, not one number — which is what
   makes the fff.nvim-style File Info panel possible at all.

### Provenance of the 11–20× figure

The number has exactly **one** recorded source:
`/home/jc/projects/symmetria-file-manager/.claude/memory/project_rust_fff_finder.md`.

> "benchmarked on this box — fff's per-keystroke scoring is 11–20× faster than
> the old C++ (e.g. /usr/include 41k files: 70ms→3.6ms), up to ~80× on rare
> queries […] Rust ≈ C++ for raw compute; the win is inherited library
> optimization (SIMD frizbee + warm index + gix), not the language. Cold index is
> ~par."

The comparison baseline was the **in-house C++ Smith-Waterman scorer** the engine
replaced, not a JavaScript matcher. The benchmark harnesses lived at
`/tmp/fff-bench` and **no longer exist** (verified: the path is absent). The
adoption commit is `859aea3 "feat(finder): back fuzzy finder with the Rust fff
engine + File Info panel"`; its message repeats the design decisions but not the
numbers. The header comment at `fuzzyfinder.hpp:8-11` restates the range.

**Treat 11–20× as unreproducible today.** It is a recorded measurement against a
deleted harness and a deleted baseline. It is enough to justify keeping fff; it
is not enough to justify a claim against a modern JS matcher, which nobody
measured.

---

# Part B — how Symmetria IDE used a finder

## B.1 It has no matcher of its own

Symmetria IDE contains **no** fuzzy-matching implementation, in Python or in QML.

- `pyproject.toml:14-18` declares exactly three runtime dependencies: `PySide6`,
  `pynvim`, `msgpack`. There is no `rapidfuzz`, `thefuzz`, `fuzzywuzzy`, or
  `difflib` use anywhere.
- There is no `fuzzy*.py`, `finder*.py`, or `picker*.py` in
  `src/symmetria_ide/`.
- There is no `FuzzyFinder*.qml` or `CommandPalette.qml` in `qml/`.
- It never shells out to `ripgrep`, `fd`, or Telescope. The only `Telescope`
  hits are an icon label in
  `runtime/lua/orchestrator/whichkey/icons.lua:27` and an abandoned plan
  document.

## B.2 It re-hosts the file manager's popup at window scope

The IDE never imports `Symmetria.FileManager.Models` directly. It imports
`Symmetria.FileManager.UI as FmUi` in three files and instantiates
`FmUi.FuzzyFinderPopup` once, at `qml/Main.qml:3386` (`id: ideFuzzyFinder`).

The rationale is in the source at `qml/Main.qml:3372-3386`:

> "The FM's `FuzzyFinderPopup` hosted at WINDOW scope — the same fff engine the
> user's fff.nvim binds to Ctrl+F in standalone nvim, surfaced as a native
> overlay that works from every central surface (editor, terminal, agent, FM)."

The IDE also embeds the whole FM panel as a central surface
(`qml/Main.qml:2008`, `FmUi.FileManager { id: fmPanel }`), which carries its own
`FuzzyFinderPopup` internally. So **one IDE process can hold two `FuzzyFinder`
instances**, driven by two different `WindowState` objects.

Search root comes from `treeOpsWindowState.currentPath`, seeded with
`initialPath: controller.displayedRoot` (`qml/Main.qml:2782-2788`).

Entry points: a `Qt.ApplicationShortcut` on `Ctrl+F` (`qml/Main.qml:807-820`) and
the tree's bare `f` key, which reaches the same `WindowState` through the FM's
own `TreeKeyHandler.js`. The IDE deliberately shadows fff.nvim's in-editor
`Ctrl+F` (`qml/Main.qml:799-806`).

## B.3 What the IDE needed that the file manager did not offer

**One thing, and it was fixed in the file manager, not worked around in the IDE.**

The FM's native Enter behaviour is "navigate to the parent directory and focus
the row". A host that opens files in NeoVim over RPC cannot use that. The fix
landed as FM commit `d065a42 "feat(fuzzy): add embedder activation seam to
FuzzyFinderPopup"` — nineteen lines in one file, adding `externalActivation` and
`activated(path, isDir)`. The IDE side (`b4bcf54`) was 97 lines of QML and
**zero Python**.

The IDE routes the signal at `qml/Main.qml:3466-3482`: a directory calls
`controller.show_fm(path)`, a file calls `controller.open_in_nvim(path)`.

### Remaining unmet needs, as recorded in the source

1. **No per-host `WindowState` for the finder.** `qml/Main.qml:3421-3426` says a
   dedicated finder `WindowState` is the clean fix, but it needs the tree's bare
   `f` key redirected, "which the installed FM module doesn't expose". The
   consequence is a documented focus-ordering hazard patched with one
   `Qt.callLater` on activation and two on cancel (`:3453-3463`).
2. **Escape ownership.** The finder swallows Escape, which would otherwise be an
   agent interrupt. The IDE mirrors the state to Python through
   `escapeOverlayOpen` (`qml/Main.qml:3506`).
3. **No content grep, no symbol picker, no buffer picker, no command palette.**
   The FM's finder is filename-only.
4. **The strategic goal is explicit.** `docs/future.md:43` calls for "one search
   index, one ranking algorithm, one keyboard model", and `docs/future.md:52`
   states the acceptance rule: "If we ship a fuzzy finder that only works when
   nvim has focus, we've failed."

## B.4 Process architecture and the LMDB constraint

Python and QML share **one process** in the IDE. `app.py` builds a
`QQmlApplicationEngine` in-process and exposes about 25 context properties. There
is no IPC between them.

That single process loads `libfff_c.so` once, the first time a
`FuzzyFinderPopup` `Loader` activates. Two `FuzzyFinder` instances inside it are
safe **only** because of `FffEngine`. Without the singleton, the second instance
would hit "environment already open in this program".

The NeoVim child process runs the user's own `fff.nvim`, which opens **its own**
LMDB environment. That is a different OS process, so there is no conflict —
but it means two independent frecency stores exist for the same user, and they do
not share learning.

---

# Part C — what Mesura Code needs, and what it already has

## C.1 The established native-code pattern — the key finding

Mesura Code ships **four** distinct native mechanisms. None of them is a
first-party napi-rs addon.

### Pattern 1 — `native/resource-monitor`: Rust executable, spawned, NDJSON over stdio

- Crate: `native/resource-monitor/Cargo.toml:2`, `name = "t3-resource-monitor"`,
  deps `serde`, `serde_json`, `sysinfo`. Release profile uses `lto = "thin"`,
  `panic = "abort"`, `strip = true`.
- It is a plain stdin/stdout program. `src/main.rs:3` imports
  `std::io::{self, BufRead, BufWriter, Write}` and exports no FFI symbols.
  `src/main.rs:11` pins `PROTOCOL_VERSION = 2`.
- **The choice is documented and deliberate.**
  `docs/internals/resource-telemetry.md:20-30`:
  > "The monitor is intentionally **not** a Node native addon. — No N-API,
  > `ffi-rs`, or dynamic-library ABI is loaded into the server process. …
  > Packaging is a single platform executable instead of an addon toolchain plus
  > Node/Electron ABI matrix."
- Loading: `apps/server/src/resourceTelemetry/NativeTelemetryClient.ts:537-568`
  builds a `ChildProcess.make(executablePath, [], {stdin: {stream: "pipe"}, stdout: "pipe", …})`,
  spawns it inside `Effect.acquireRelease`, and decodes output with
  `Stream.pipeThroughChannel(Ndjson.decode(...))`. A protocol-version mismatch
  raises `NativeTelemetryProtocolMismatch`.
- Binary resolution:
  `apps/server/src/resourceTelemetry/ResourceMonitorBinary.ts:143-181` walks an
  ordered candidate list — environment override, then the CLI-bundled
  `<dist>/resource-monitor/<platform>-<arch>/`, then the dev
  `native/resource-monitor/target/<triple>/release/`. The desktop app resolves it
  under `process.resourcesPath` instead
  (`apps/desktop/src/backend/DesktopBackendConfiguration.ts:169`).
- Build: `scripts/build-desktop-artifact.ts:1656-1717` runs
  `cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml --target <triple>`,
  then `lipo -create` for the macOS universal build.
- Packaging: `scripts/build-desktop-artifact.ts:836-841` —
  `DESKTOP_EXTRA_RESOURCES = [{ from: "apps/desktop/prod-resources/resource-monitor", to: "resource-monitor" }]`.
- CI: `.github/workflows/ci.yml:154-176` runs `cargo fmt --check` and
  `cargo test --locked`. `.github/workflows/release.yml:339-372` uses a
  **four-entry native-runner matrix with no cross-compilation** — macOS arm64,
  macOS x64, Linux x64, Windows x64. Windows arm64 is commented out.
- Rust is **not** required for `pnpm dev`. Nothing in the dev runner invokes
  cargo; the resolver simply returns `ResourceMonitorBinaryNotFound` and
  telemetry degrades.

### Pattern 2 — `native/libghostty-vt`: Zig, vendored artifacts, WASM on web

- The repo-root directory holds **only** headers, a licence, and a pin:
  `native/libghostty-vt/VERSION` is the upstream ghostty commit
  `9f62873bf195e4d8a762d768a1405a5f2f7b1697`. There is no `build.zig` here.
- Web: `apps/web/scripts/build-libghostty-wasm.sh` reads the pin, downloads Zig
  0.15.2 into `~/.cache/t3code/` if missing, clones ghostty at the pinned commit,
  and runs `zig build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall`.
  The resulting `ghostty-vt.wasm` (631 KB) is **committed** under
  `apps/web/src/terminal/ghostty/vendor/`, so Zig is not a normal dev dependency.
- Loading: `apps/web/src/terminal/ghostty/runtime.ts:1-2` imports the artefact
  with Vite's `?url`, then `runtime.ts:44-65` does `fetch` plus
  `WebAssembly.instantiate`.
- Mobile: prebuilt `libghostty-vt.so` per Android ABI under
  `apps/mobile/modules/t3-terminal/android/src/main/jniLibs/`, plus an iOS
  `GhosttyKit.xcframework`. Both are committed and regenerated by manual scripts.
- Zig is **not** built in CI.

### Pattern 3 — `@ff-labs/fff-node`: third-party Rust cdylib through `ffi-rs`

This is the only FFI in the tree, and it is **already the fff engine**.

- Declared at `apps/server/package.json:30` as `"@ff-labs/fff-node": "0.9.4"`.
- The package loads `libfff_c.{so,dylib,dll}` with `ffi-rs`'s `open()`, which is
  a `dlopen`. Its eight per-platform binaries ship as npm `optionalDependencies`
  named `@ff-labs/fff-bin-<triple>`.
- **Mesura Code patches it for Electron.**
  `patches/@ff-labs__fff-node@0.9.4.patch` adds `resolveUnpackedAsarPath()`,
  which rewrites `…/app.asar/…` into `…/app.asar.unpacked/…` when that file
  exists. Registered at `pnpm-workspace.yaml:138`.
- Bundling: `scripts/lib/cli-external-packages.ts:28-50` lists
  `CLI_RUNTIME_EXTERNAL_PREFIXES`, which includes `"ffi-rs"`, `"@yuuang/"` (the
  ffi-rs platform bindings), and `"@ff-labs/"`. The list is the single source of
  truth for two consumers: `apps/server/vite.config.ts` decides bundle
  externality, and `scripts/build-desktop-artifact.ts` selects sidecar dependency
  roots. A test enforces the closure.
- Packaging: `scripts/build-desktop-artifact.ts:1060-1084`
  (`resolveFffNativeDependencies`) injects the right `@ff-labs/fff-bin-*` into
  the staged production install. For Windows it stages **both** the win32 and the
  linux natives, because the WSL backend loads the Linux ones from the same
  extracted tree (`:2306-2309`).
- Verification: `scripts/build-desktop-artifact.ts:2436-2470` runs a Windows
  primary native-load probe — it launches the packaged Electron with
  `ELECTRON_RUN_AS_NODE=1` against the in-asar `fff-node` entry. Failure raises
  `WindowsPrimaryNativeProbeError`. The release runbook lists it as a gate
  (`docs/operations/release.md:234-235`).
- No `asarUnpack` key exists anywhere. `scripts/build-desktop-artifact.ts:2049-2052`
  relies on electron-builder's default smart unpack, which extracts native
  libraries into `app.asar.unpacked` — which is exactly what the patch above
  teaches `fff-node` to find.

### Pattern 4 — `node-pty`: an ordinary N-API addon

Standard npm native module, allow-listed for pnpm builds, with a prebuilt
`pty.node` shipped for the WSL path because "node-pty 1.x is N-API based, so a
single Linux `pty.node` is ABI-stable"
(`apps/desktop/src/wsl/DesktopWslEnvironment.ts:247`).

### The pattern to copy

For a new Rust component, the repository offers two proven routes and one clear
preference:

- **In-process FFI** when a prebuilt cdylib exists on npm with per-platform
  packages. Cost: a bundler-external entry, an asar-path patch if the package
  resolves its own binary, and a packaging probe. `fff` already sits here.
- **Out-of-process executable** when you own the Rust and want to avoid the
  Node/Electron ABI matrix entirely. Cost: a CI build matrix on native runners
  and an `extraResources` entry. The team documented this as its preference for
  first-party Rust.

**Neither route uses napi-rs.** Proposing one would be the first in the repo.

## C.2 What Mesura Code has for fuzzy matching today

### Libraries: none of the usual ones

No `fuse.js`, `cmdk`, `kbar`, `command-score`, `minisearch`, `flexsearch`,
`lunr`, `orama`, `fzf`, `@vscode/ripgrep`, or `fd` anywhere in the workspace or
the pnpm catalog. Everything is hand-rolled TypeScript or delegated to `fff`.

### The server index — `WorkspaceSearchIndex`

`apps/server/src/workspace/WorkspaceSearchIndex.ts` is a 566-line Effect service
wrapping `FileFinder`. Its shape is the closest thing the ecosystem has to the
"shared module" this document is about.

- Import at `:1-10` pulls `FileFinder` plus nine types from `@ff-labs/fff-node`.
- Creation at `:300-320`:
  ```ts
  FileFinder.create({
    basePath: cwd,
    disableMmapCache: true,
    disableContentIndexing: variant !== "content",
    aiMode: false,
    enableFsRootScanning: true,
    enableHomeDirScanning: true,
  })
  ```
- **Neither `frecencyDbPath` nor `historyDbPath` is passed.** Per the upstream
  contract, omitting them skips frecency and query-tracker initialisation
  entirely. Only the mtime-derived `modificationFrecencyScore` survives.
- Two index variants, `"paths"` and `"content"`, keyed per working directory
  through an Effect `LayerMap` (`:535-566`), with
  `idleTimeToLive` of 15 minutes. Content indexing costs scan CPU, so only the
  on-demand content search pays for it (`:308-311`).
- Budgets at `:28-33`: 25 000 entries maximum, a 15-second scan timeout, a
  250 ms content-search time budget, 100 matches per file.
- Dispatch: `finder.fileSearch` / `finder.directorySearch` / `finder.mixedSearch`
  by `kind`; `finder.grep` with cursor pagination for content search.
- `refresh()` calls `finder.scanFiles()` and re-waits, triggered from
  `CheckpointReactor`.
- Ranking is entirely the library's. `toProjectEntry` (`:140-150`) maps each
  result down to `{ path, kind }` and **discards everything else** —
  `gitStatus`, all frecency scores, and the whole `Score` breakdown.

### The wire contract

`packages/contracts/src/project.ts` defines `ProjectEntry` as exactly
`{ path, kind }`. The RPC methods are `projects.listEntries`,
`projects.searchEntries`, and `projects.searchContents`
(`packages/contracts/src/rpc.ts:630-644`).

### The web UI — one overlay, three modes

`apps/web/src/components/CommandPalette.logic.ts:38`:

```ts
export type SearchOverlayMode = "command" | "files" | "content";
```

Default bindings at `packages/shared/src/keybindings.ts:37-39`: `mod+k` for the
command palette, `mod+p` for the file picker, `mod+shift+f` for project content
search.

- **The command palette has no fuzzy matching.** `rankSearchFieldMatch`
  (`CommandPalette.logic.ts:258-268`) returns 3 for exact, 2 for prefix, 1 for
  `includes`, and `-Infinity` otherwise. The filter gate at `:337` is a bare
  `haystack.includes(normalizedQuery)`. Typing `gtf` will not find "Go to file".
- **The file picker preserves server order.**
  `apps/web/src/components/files/ProjectFilePicker.logic.ts:38-44` says so
  explicitly. `findMatchIndices` (`:23-37`) recomputes a greedy first-subsequence
  **only for highlighting** — the same approximation as
  `computeMatchIndices` in `fuzzyfinder.cpp:35-54`, independently re-invented.
- Debounce is 120 ms (`apps/web/src/state/queries.ts:34`), against the file
  manager's 100 ms.

### The hand-rolled scorer

`packages/shared/src/searchRanking.ts` holds a real tiered scorer:
`scoreSubsequenceMatch` (`:22-51`, greedy with gap, span, and length penalties),
`scoreQueryMatch` (`:86`, tiers exact → prefix → boundary → includes → fuzzy),
and `insertRankedSearchResult` (`:171`, bounded binary-search insertion). Five
surfaces use it: provider skills, composer slash commands, the model picker, the
mobile file tree, and mobile composer skills. **The command palette does not.**

### What is missing

1. **Frecency is off.** No `frecencyDbPath`, no `historyDbPath`, no
   `trackQuery` call anywhere. Opening a file from the picker teaches nothing.
   The doc comments claiming "frecency-ordered files" overstate the
   configuration.
2. **Git status is discarded** at the mapper, and `ProjectEntry` has no field
   for it.
3. **Score and match positions never cross the wire**, so the client guesses
   highlights and can disagree with the server's alignment.
4. **The command palette is substring-only** while a fuzzy scorer already exists
   in the same monorepo. This is the most visible inconsistency.
5. **Hard 25 000-entry ceiling** with no continuation for entry search — only
   grep has a cursor.
6. **No `file:line:col` jump**, though fff's query parser supports it and returns
   a `Location`.
7. **No `currentFile` deprioritisation**, though `SearchOptions.currentFile`
   exists.

---

# Part D — the recommendation

## D.1 The options, scored

Scores are 1 (bad) to 5 (good).

### Option 1 — a napi-rs Node addon wrapping `fff-c` or the Rust crate

| Axis | Score | Reason |
|---|---|---|
| Effort | 2 | A new crate, a cbindgen-free binding layer, a CI matrix, and an npm publishing pipeline for eight triples. |
| Performance | 5 | Best possible. Native calls with no FFI marshalling layer, and `AsyncTask` moves work off the event loop cleanly. |
| Packaging pain | 3 | napi-rs is Node-API, so it is ABI-stable across Electron versions and needs no `electron-rebuild`. But the repo has **no** first-party napi-rs precedent, so every piece of tooling is new. |
| Cross-platform risk | 3 | Eight triples to build and test, including musl. |

**Verdict: rejected as redundant.** It rebuilds what `@ff-labs/fff-node` already
publishes, and it introduces a build pattern the monorepo does not use.

### Option 2 — a long-running sidecar speaking NDJSON over stdio or a socket

| Axis | Score | Reason |
|---|---|---|
| Effort | 3 | A new Rust binary, a protocol, and a client. But `native/resource-monitor` is a complete working template, and the file manager's `HostController` already speaks newline-delimited JSON over a `QLocalSocket` (`host/standalone/server.cpp:80-110`). |
| Performance | 3 | One serialisation round trip per keystroke. At 200 results with full metadata that is real, though a 100 ms debounce absorbs most of it. |
| Packaging pain | 4 | Exactly the resource-monitor pattern: `extraResources`, no ABI matrix, no asar problem. |
| Cross-platform risk | 4 | A single executable per platform, built on native runners. |

**Verdict: the strong runner-up, and the answer to one specific problem** — see
D.5 on multi-process index sharing.

### Option 3 — WASM

| Axis | Score | Reason |
|---|---|---|
| Effort | 3 | The repo has a WASM precedent (`ghostty-vt.wasm`), so the tooling exists. |
| Performance | 2 | No SIMD guarantee, no threads without cross-origin isolation, and a 25 000-file index must be marshalled into linear memory. |
| Packaging pain | 5 | One artefact, no platform matrix. |
| Cross-platform risk | 5 | None. |

**Verdict: rejected for the desktop.** WASM cannot open LMDB, cannot walk the
filesystem, and cannot read git state. It would need a whole different index
source. It stays interesting for `apps/web` running against a **remote**
workspace, where no local filesystem exists at all — but that is a different
problem from this document's.

### Option 4 — a pure-TypeScript re-implementation

| Axis | Score | Reason |
|---|---|---|
| Effort | 2 | The matcher itself is a weekend. The crawler, the ignore semantics, the incremental watcher, the frecency store, and the git integration are months. |
| Performance | 2 | Unmeasured. The one recorded figure compares fff against C++, not JS. |
| Packaging pain | 5 | Perfect. |
| Cross-platform risk | 5 | None. |

**Verdict: rejected.** It throws away a working, already-shipped, already-packaged
engine to solve a problem nobody has. `packages/shared/src/searchRanking.ts`
should stay for the small in-memory lists it already serves (commands, models,
skills) — it is the right tool for 200 strings, and the wrong tool for 25 000
paths.

### Option 5 — keep the C++ plugin and talk to it

| Axis | Score | Reason |
|---|---|---|
| Effort | 4 | The daemon and its JSON protocol already exist. |
| Performance | 3 | Same round trip as option 2. |
| Packaging pain | 1 | It makes Mesura Code depend on a Qt6 plugin, KF6, libarchive, QXlsx, freexl, and libheif. Shipping that inside an Electron app on macOS and Windows is not viable. |
| Cross-platform risk | 1 | The plugin is Linux-only in practice. |

**Verdict: rejected outright.** The dependency direction is backwards. The C++
plugin should stay a *consumer* of fff, never a *provider* to Node.

## D.2 The recommendation

**Adopt `@ff-labs/fff-node` as the shared engine — which Mesura Code already
did — and build one thin, first-party TypeScript package around it that owns
the contract the three consumers must agree on.**

Ranked, with the reason in one line each:

1. **Wrap the published `@ff-labs/fff-node`** — the engine, the prebuilt binaries
   for eight triples, the asar patch, the bundler externals, and the packaging
   probe all already exist and are already tested in CI.
2. **Sidecar (option 2)** — adopt it only for the specific case where several OS
   processes must share one frecency index (D.5).
3. **napi-rs (option 1)** — only if upstream `@ff-labs/fff-node` stops being
   maintained.
4. **WASM (option 3)** — only for the remote-workspace web client.
5. **Pure TypeScript (option 4)** and **the C++ plugin (option 5)** — do not.

### Why the wrapper is worth building even though the npm package exists

The npm package gives you a `FileFinder`. It does not give you:

- a **frecency policy** — where the LMDB lives, who owns it, and when
  `trackQuery` fires;
- a **result contract** that carries git status, score, and match ranges, which
  today are computed by Rust and then thrown away at three separate boundaries;
- **match indices** computed once, correctly, instead of re-approximated in
  `fuzzyfinder.cpp` and again in `ProjectFilePicker.logic.ts`;
- **event-loop discipline** — every `fff-node` search call is a synchronous FFI
  call that blocks the calling thread (`waitForScan` polls with `setTimeout`, but
  `mixedSearch` and `grep` do not yield);
- a place to hold the **multi-process rule** from D.5.

## D.3 Where it lives

`packages/file-search/`, published as `@t3tools/file-search`, matching the
existing `@t3tools/contracts`, `@t3tools/shared`, and `@t3tools/client-runtime`
naming.

It depends on `@ff-labs/fff-node`. `apps/server` then depends on
`@t3tools/file-search` instead of on `@ff-labs/fff-node` directly, and
`WorkspaceSearchIndex` becomes an Effect adapter over it rather than the wrapper
itself.

Packaging changes needed: **none**. `scripts/lib/cli-external-packages.ts`
already lists `"@ff-labs/"`, `"ffi-rs"`, and `"@yuuang/"` as prefixes, and prefix
matching covers the transitive case. A workspace package that re-exports them
changes nothing about which files land on disk.

## D.4 The public API sketch

```ts
// packages/file-search/src/index.ts

/** Where a result came from. Directories never carry git or content data. */
export type EntryKind = "file" | "directory";

/**
 * A path relative to the index root. Directory paths NEVER carry a trailing
 * slash at this boundary — the engine emits one and this package strips it,
 * so every consumer sees the same shape. See normalizeRelativePath().
 */
export type RelativePath = string & { readonly __brand: "RelativePath" };

/** Half-open character range into `relativePath`, for highlighting. */
export interface MatchRange {
  readonly start: number;
  readonly end: number;
}

/** The full ranking breakdown, passed through from the engine unchanged. */
export interface SearchScore {
  readonly total: number;
  readonly base: number;
  readonly filenameBonus: number;
  readonly specialFilenameBonus: number;
  readonly frecencyBoost: number;
  readonly distancePenalty: number;
  readonly currentFilePenalty: number;
  readonly comboBoost: number;
  readonly pathAlignmentBonus: number;
  readonly exactMatch: boolean;
  /** "frecency" | "exact" | "prefix" | "fuzzy" | … — engine-defined. */
  readonly matchType: string;
}

export interface SearchHit {
  readonly kind: EntryKind;
  readonly relativePath: RelativePath;
  /** Last path segment, never with a trailing slash. */
  readonly name: string;
  readonly absolutePath: string;
  readonly score: SearchScore;
  /**
   * Character ranges in `relativePath` that matched. Computed ONCE, here.
   * Empty when the query is a constraint expression ("*.rs", "git:modified")
   * rather than a subsequence.
   */
  readonly matchRanges: readonly MatchRange[];
  /** Files only. Zero for directories. */
  readonly sizeBytes: number;
  /** Unix seconds. Zero for directories. */
  readonly modifiedAt: number;
  /** Porcelain status ("M ", "??", …). Empty for clean files and all dirs. */
  readonly gitStatus: string;
  readonly frecencyScore: number;
  readonly isBinary: boolean;
}

export interface SearchPage {
  readonly hits: readonly SearchHit[];
  readonly totalMatched: number;
  readonly totalIndexed: number;
  /** Parsed from a "file.ts:42:10" style query, when present. */
  readonly location?: SourceLocation;
  readonly truncated: boolean;
}

export type SourceLocation =
  | { readonly kind: "line"; readonly line: number }
  | { readonly kind: "position"; readonly line: number; readonly column: number }
  | {
      readonly kind: "range";
      readonly start: { readonly line: number; readonly column: number };
      readonly end: { readonly line: number; readonly column: number };
    };

export interface SearchOptions {
  /** Result cap. Default 200, matching the file manager's MaxResults. */
  readonly limit?: number;
  readonly pageIndex?: number;
  /** "file" and "directory" restrict; omitted means mixed. */
  readonly kind?: EntryKind;
  /** Deprioritise the file the user is already looking at. */
  readonly currentFile?: string;
}

/** Frecency is a policy, not a flag — the caller states where it lives. */
export type FrecencyPolicy =
  | { readonly mode: "disabled" }
  | {
      readonly mode: "persistent";
      /** Directory holding the `frecency/` and `history/` LMDB envs. */
      readonly databaseDirectory: string;
    };

export interface IndexOptions {
  readonly rootPath: string;
  readonly frecency: FrecencyPolicy;
  /** Enables grep. Costs scan CPU and memory. Default false. */
  readonly contentIndex?: boolean;
  /** fff's own fs watcher. Default false; the host usually has its own. */
  readonly watch?: boolean;
  /** Initial-scan deadline in milliseconds. Default 15000. */
  readonly scanTimeoutMs?: number;
}

export interface FileSearchIndex {
  readonly rootPath: string;

  /** Resolves when the initial scan and warmup finish, or the deadline passes. */
  ready(): Promise<{ readonly complete: boolean }>;

  /** Path search over files, directories, or both. Empty query is valid and
   *  returns the frecency-ranked listing. */
  search(query: string, options?: SearchOptions): Promise<SearchPage>;

  /** Content search. Present only when `contentIndex` was enabled. */
  grep(query: string, options?: GrepOptions): Promise<GrepPage>;

  /** Teach frecency. No-op under FrecencyPolicy "disabled". */
  recordOpen(absolutePath: string, query: string): Promise<void>;

  /** Re-scan in place, keeping the same LMDB environment. */
  refresh(): Promise<void>;

  /** Re-point at a new root, keeping the same LMDB environment. */
  reroot(rootPath: string): Promise<void>;

  dispose(): Promise<void>;
}

/**
 * Open an index. Calls with the same (rootPath, frecency.databaseDirectory)
 * pair inside one process return the SAME underlying engine, refcounted —
 * LMDB refuses a second open of one environment per process. See D.5.
 */
export function openIndex(options: IndexOptions): Promise<FileSearchIndex>;

/** True when the native library resolved on this platform. */
export function isAvailable(): boolean;
```

Three design rules the sketch encodes.

1. **Every method returns a `Promise`.** The underlying `fff-node` calls are
   synchronous FFI and block the calling thread. The wrapper must move them onto
   a `worker_threads` worker or a `MessageChannel`-driven utility process before
   the renderer ever awaits one. A synchronous 25 000-file `mixedSearch` on the
   main thread is a dropped frame.
2. **`matchRanges` is computed once, here.** The greedy subsequence walk that
   `fuzzyfinder.cpp:35-54` and `ProjectFilePicker.logic.ts:23-37` each
   reimplement lives in one place, so the two consumers can never drift apart.
3. **Directory paths are normalised.** The engine emits `src/components/` for
   both `relativePath` and `dirName`. The wrapper strips the trailing slash from
   both and exposes `kind` instead, which removes the whole class of off-by-one
   bugs described in A.6.

## D.5 The multi-process problem

**The constraint.** LMDB refuses to open one environment twice inside one
process. It does **not** stop two separate processes from opening the same
environment — LMDB is designed for multi-process access with file locking.

So there are two different problems, and they need two different answers.

### Problem 1 — several index consumers inside one process

This is the file manager's and the IDE's situation today. Two `FuzzyFinder`
instances, one process, one LMDB environment.

**Answer: refcounted sharing, keyed on the environment path.** That is exactly
what `FffEngine` (`fuzzyfinder.cpp:105-202`) does, and what `openIndex` in the
sketch above must do. The current C++ singleton keys on nothing and re-points the
single engine with `fff_restart_index`, which is why the last acquirer wins the
path. The TypeScript version should key the shared handle on the **frecency
directory** and hold one engine per directory, re-rooting only within it.

Note that Mesura Code sidesteps this today by accident: `FileFinder.create` at
`WorkspaceSearchIndex.ts:300-320` passes **no** frecency path, so there is no
LMDB environment at all and the `LayerMap` can hold one engine per working
directory without conflict. **The moment frecency is turned on, that `LayerMap`
becomes a bug** — every entry would try to open the same environment. The wrapper
must own this, not each consumer.

### Problem 2 — a daemon plus several windows plus Mesura Code all want the index

Three OS processes could each want frecency:

- `symmetria-fm.service`, the headless daemon that spawns file manager windows;
- the Symmetria IDE process;
- Mesura Code's Electron server process.

Two of those already coexist without conflict — the FM daemon and the user's
`fff.nvim` inside NeoVim each open their own environment. Multi-process LMDB is
legal. What breaks is not correctness but **shared learning**: each process
accumulates its own frecency, and opening a file in one teaches nothing to the
others.

There are three coherent stances, and the choice is a product decision, not a
technical one.

| Stance | What it means | Cost |
|---|---|---|
| **Separate stores** | Each application owns its own frecency directory. `SYMMETRIA_FM_FRECENCY_DIR` already makes this configurable. | Learning does not transfer. This is the status quo and it is not broken. |
| **Shared store, concurrent access** | All processes point at one directory and rely on LMDB's own file locking. | Needs verification that fff's `heed` configuration tolerates concurrent writers. Untested here. Writers are rare (one per file open), so contention would be negligible if it works. |
| **Shared store, single owner** | One sidecar process owns the environment; everyone else talks to it over NDJSON. | This is option 2 from D.1, and it is the **only** stance that guarantees one index, one ranking, and one learning history across all three applications — which is exactly what `docs/future.md:43` in the IDE asks for. |

**Recommendation on this specific point:** start with separate stores, because it
is the status quo and costs nothing. Adopt the sidecar only when the shared
learning becomes a stated requirement rather than an aspiration — and when it
does, build it as `native/file-search-daemon` following the
`native/resource-monitor` template exactly, because that template is proven,
documented, and already has a CI matrix.

## D.6 How each consumer would use it

### Mesura Code

`WorkspaceSearchIndex` (`apps/server/src/workspace/WorkspaceSearchIndex.ts`)
stops importing `@ff-labs/fff-node` and imports `@t3tools/file-search`. The
Effect service keeps its `LayerMap`, its budgets, and its error taxonomy; only
`createFinder` changes. Then, in order of value:

1. Set `FrecencyPolicy` to `"persistent"` and call `recordOpen` from the file
   picker's open handler. This is the single largest quality win available and it
   is currently unwired.
2. Widen `ProjectEntry` in `packages/contracts/src/project.ts` to carry
   `gitStatus` and `matchRanges`, then delete `findMatchIndices` from
   `ProjectFilePicker.logic.ts`.
3. Point the command palette's `rankSearchFieldMatch` at
   `packages/shared/src/searchRanking.ts`'s `scoreQueryMatch`, so `⌘K` gets the
   fuzzy tier that five other surfaces already have.

### The file manager

**No change is required, and none is recommended in the short term.** The C++
`FuzzyFinder` links `libfff_c` directly through Corrosion and is already correct.

Two fixes are worth making independently of any module work:

1. Correct the `CLAUDE.md` line about `display_name` and fix the directory
   off-by-one in `FuzzyFinderResultDelegate.qml:47-48` — see A.6.
2. If the Electron transition proceeds, the QML popup is replaced wholesale and
   the C++ wrapper retires with it. Until then, keep it.

### Symmetria IDE

The IDE gets whatever the file manager gets, for free, because it re-hosts
`FmUi.FuzzyFinderPopup` rather than owning a finder. The one thing it asked for —
an activation seam — already exists.

Its remaining request from `docs/future.md:43` ("one search index, one ranking
algorithm, one keyboard model") is answered by D.5's sidecar stance, not by the
TypeScript package.

---

## Open questions

1. **Does fff's `heed` configuration tolerate concurrent cross-process writers to
   one frecency environment?** Unverified. It decides whether the "shared store,
   concurrent access" stance in D.5 is viable.
2. **What is fff's real per-keystroke cost from Node, through `ffi-rs`, on a
   25 000-file tree?** The 11–20× figure measures Rust against C++, not against
   JavaScript, and its harness is gone. Anyone claiming a JS matcher is too slow
   should measure first.
3. **Is `enableFsRootScanning: true` correct?** Both the file manager
   (`fuzzyfinder.cpp:143`) and Mesura Code
   (`WorkspaceSearchIndex.ts` in `createFinder`) set it, and the upstream header
   warns against it (`fff.h:120-124`).
4. **Version skew.** The file manager pins fff v0.9.3 by submodule; Mesura Code
   pins `@ff-labs/fff-node@0.9.4`; npm's latest is 0.10.5. Three consumers on
   three versions of one engine is a drift the shared package should end.
</content>
