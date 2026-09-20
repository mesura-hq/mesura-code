# 06 — IDE embedding, git status, and the Qt→Electron transition record

Source repositories, both read-only for this document:

| Repository | Path | Branch read |
|---|---|---|
| Symmetria IDE | `/home/jc/projects/symmetria-ide` | `dev` |
| Symmetria File Manager | `/home/jc/.t3/worktrees/symmetria-file-manager/t3code-a2a6aa9b` | `t3code/a2a6aa9b` |

The IDE is a PySide6 application. Python owns the process, the git subprocesses and
the state; QML owns every pixel. The file manager reaches it as an installed QML
module at `/usr/lib/qt6/qml/Symmetria/FileManager/UI/`, which the IDE imports and
composes. Nothing about the two repositories is linked at build time.

---

## Part A — the file-manager embedding

### A.1 Every import site

`grep` over the IDE for `Symmetria.FileManager` finds exactly three QML files that
import the module, and zero Python files that touch it.

| File | Import line | What it instantiates |
|---|---|---|
| `/home/jc/projects/symmetria-ide/qml/Main.qml:18` | `import Symmetria.FileManager.UI as FmUi` | `FmUi.FileManager`, `FmUi.FileTreeView`, `FmUi.WindowState`, `FmUi.DeleteConfirmPopup`, `FmUi.CreateFilePopup`, `FmUi.RenamePopup`, `FmUi.WhichKeyPopup`, `FmUi.FuzzyFinderPopup`, plus reads of `FmUi.FmTheme` and `FmUi.FileManagerService` |
| `/home/jc/projects/symmetria-ide/qml/GitStatusPanel.qml:77` | `import Symmetria.FileManager.UI as FmUi` | one `FmUi.FileTreeView` |
| `/home/jc/projects/symmetria-ide/qml/githistory/WorkingFileTreeView.qml:34` | `import Symmetria.FileManager.UI as FmUi` | one `FmUi.FileTreeView` |

The IDE never imports `Symmetria.FileManager.Models`. The C++ plugin reaches it only
transitively, because the UI module imports it. `/home/jc/projects/symmetria-ide/src/symmetria_ide/app.py:8497`
states the rule:

> The Models C++ plugin is NOT shipped from the source tree (it builds to
> `plugin/build/`), so the resolver falls through to the installed path
> for Symmetria.FileManager.Models — only the UI QML overlays.

So the IDE consumes **four** types and **two** singletons out of a module that
exports about seventy. The embedding surface is far narrower than the module.

### A.2 The alias-import convention, and why it exists

Every host site writes `import Symmetria.FileManager.UI as FmUi`, never a bare
import. Two reasons, both recorded.

1. **Name collision.** The IDE has its own `Theme` singleton at
   `/home/jc/projects/symmetria-ide/qml/design/Theme.qml`. The file manager renamed
   its own singleton to `FmTheme` for this reason, and the alias adds a second layer
   of separation. The FM's `CLAUDE.md` states it under *Two `Theme` singletons in one
   engine*.
2. **Provenance in the diff.** Every `FmUi.` prefix marks a line whose behaviour is
   owned by another repository that upgrades independently. `/home/jc/projects/symmetria-ide/CLAUDE.md:259`
   turns that into a debugging rule:

   > ⚠ That is a property of an EXTERNALLY installed module (`Symmetria.FileManager.UI`)
   > which upgrades independently of this repo: if the toggle ever silently stops
   > working, a new Tab-claiming focusable inside the FM tree is the first suspect.

**A dev-mode override exists** so a source-tree FM can be tested inside the IDE:
`SYMMETRIA_IDE_FM_QML_PATH` prepends a path to the engine's import list
(`/home/jc/projects/symmetria-ide/src/symmetria_ide/app.py:8500`). The prepend is
load-bearing: `engine.addImportPath()` APPENDS in Qt 6, and the resolver searches in
list order, so an appended dev path always loses to `/usr/lib/qt6/qml`. The code
replaces the whole list instead.

### A.3 Three distinct embeddings, not one

The IDE embeds the file manager in three different shapes. Confusing them is the
first mistake a reader makes.

| # | Shape | Site | Instantiates | Has `windowState`? |
|---|---|---|---|---|
| 1 | **Full panel**, central surface, `Ctrl+E` | `Main.qml:1865` `fmPaneLoader` | `FmUi.FileManager` | Its own, internally |
| 2 | **Sidebar file tree**, the "files" tab | `Main.qml:2531` `fileTreeView` | `FmUi.FileTreeView` | Yes — `treeOpsWindowState` |
| 3 | **Filtered change trees** (two of them) | `GitStatusPanel.qml:338`, `WorkingFileTreeView.qml:160` | `FmUi.FileTreeView` | **No** — navigation-only |

### A.4 Shape 1 — the full panel as a central surface

`Main.qml:1865-2021`. A `Loader` whose `active` is bound to `controller.fmVisible`.

**It is not an overlay any more.** The comment at `Main.qml:1824` records the move:

> File manager — central-pane surface (not an overlay). Was a Window-root Loader at
> z:100 with a dim scrim covering the whole window; now lives in `mainContent` as a
> sibling of editor/terminal/agent. The other panes are gated on
> `!controller.fmVisible` so exactly one central surface is visible at a time,
> matching the editor/terminal/agent XOR cluster.

So the toggle behaviour is: `Ctrl+E` is an `Qt.ApplicationShortcut` at
`Main.qml:276` calling `controller.toggle_fm()`; the panel replaces the editor,
terminal, agent or git pane rather than floating above it. Dismissal routes are
`Esc`, bare `q`, `Ctrl+E` again, or picker completion/cancellation. There is no
scrim and no click-to-dismiss.

**The Loader deliberately reconstructs the panel on every show.** `Main.qml:1832`:

> `Loader.active` toggles per visibility — the panel is reconstructed on each show.
> An earlier "keep loaded" approach (`active: visible || item !== null`) preserved
> tab/scroll/selection state across toggles, but it conflicted with the FM's
> focus-on-construction pattern: `FileList.view` grabs active focus inside its
> `Component.onCompleted` hook, which only fires once per construction. […] For
> picker-mode use (each Ctrl+E is a fresh "open file" flow), losing tab/scroll
> between toggles is acceptable; the ~50-100ms reconstruction cost is also
> acceptable for a binding that fires on user keypress, not in any hot path.

**Properties the host sets on `FmUi.FileManager`** (`Main.qml:2008-2019`) — there
are only two, plus one signal:

```qml
FmUi.FileManager {
    id: fmPanel
    anchors.fill: parent
    initialPath: controller.fmInitialPath || ""
    onCloseRequested: controller.hide_fm()
}
```

That matches the FM's own public surface exactly:
`qml/Symmetria/FileManager/UI/modules/filemanager/FileManager.qml:11` declares
`signal closeRequested()` and `:14` declares `property string initialPath`. Nothing
else is public on the entry component.

### A.5 The `pickerFileOps` escape hatch

This is the most important single contract in the embedding, because it is the one
place the file manager grew an API *for* the IDE.

The IDE does not want a file chooser. It wants a full file manager whose Enter key
happens to open a buffer in NeoVim. It gets that by starting picker mode with a flag.

`Main.qml:1888`:

```qml
onLoaded: {
    FmUi.FileManagerService.startPickerMode({
        title: "Open File",
        acceptLabel: "Open",
        fileOps: true
    });
}
```

`Main.qml:1870` explains the whole design:

> We ride the panel's picker infrastructure (built for the XDG portal) for its
> open/cancel routing: confirming a selection emits
> `FileManagerService.pickerCompleted` (→ `pick_in_nvim`, opens in the editor +
> dismisses); cancelling emits `pickerCancelled`. We connect to both below — no
> `fifoPath` is passed, so the panel's standalone-host FIFO writer is dormant.
>
> `fileOps: true` makes this a FULL file manager rather than a bare file chooser: it
> opts out of picker mode's default clipboard/multi-select suppression […] so
> yank/cut/paste, space-marking, and tabs all work — while Enter→open-in-nvim and
> Esc→dismiss stay wired through the picker signals. The flag is opt-in and defaults
> false, so the standalone FM and the XDG portal picker are unaffected (they never
> pass it).

The FM side of the contract is
`qml/Symmetria/FileManager/UI/services/FileManagerService.qml:89-113`:

```qml
// Opt-in escape hatch for embedding hosts (e.g. the Symmetria IDE) that
// want a FULL file manager riding the picker's open/cancel routing rather
// than a bare file chooser. When true, KeyRegistry's dispatch picker
// pre-pass skips picker mode's default clipboard/multi-select/tab
// suppression […] Defaults false → the XDG portal picker and any
// other startPickerMode caller keep the suppress-clipboard-ops behavior.
property bool pickerFileOps: false
```

`startPickerMode(options)` reads `options.fileOps` into it at line 113.

**Lifecycle hazard the host has to handle.** `FileManagerService` is a singleton, so
its picker state outlives the Loader's reconstruction cycle. `Main.qml:1901` cancels
picker mode on every hide, with no `fmPaneLoader.item` guard, because *item is null
exactly when the cancel is needed*. Without the cancel, the next show would skip
`startPickerMode` and the panel would have no way to emit `pickerCompleted`.

### A.6 Focus handover between NeoVim and the panel

This is where the embedding cost the most engineering. Four rules, all learned by
breaking them.

**Rule 1 — the host must NOT force focus on open.**
`Main.qml:1959`:

> No `forceActiveFocus()` on construction. Children's `Component.onCompleted` runs
> BEFORE parents' — so `FileList`'s `ListView` inside the FM subtree has already
> claimed activeFocus via its own `view.forceActiveFocus()` […] by the time we get
> here. A parent-level `forceActiveFocus` would STEAL focus from the `ListView` onto
> `fmPane` (a plain Item, not a FocusScope, so focus stops here and never propagates
> back down) — which is exactly what broke arrow-key navigation once the Lua `<C-u>`
> path was retired in favor of an IDE-wide Ctrl+E `ApplicationShortcut`.

The generalised lesson is recorded at
`/home/jc/projects/symmetria-ide/.claude/memory/reference/qt-pyside/qml_overlay_focus.md`.
Its symptom triad is worth transferring verbatim, because a web port will reproduce
it with DOM focus:

> 1. Esc dismisses the overlay correctly.
> 2. A single literal key (e.g. `q`) dismisses correctly.
> 3. Navigation keys (arrows, j/k/h/l) do nothing visible.

The same file records: `A Loader is NOT a FocusScope by default — Loader.focus = true
+ Loader.forceActiveFocus() will still land on the Loader itself, not propagate down.`

**Rule 2 — the host MUST force focus on close.** `Main.qml:1917`:

> Focus return on dismiss. Without this, focus stays on the now-destroyed `fmPane`
> subtree's parent and keystrokes go nowhere — nvim/agent appears frozen until
> alt-tab.

The restore priority is: agent pane if visible, terminal if visible, otherwise
editor.

**Rule 3 — the host adds its own dismiss keys above the panel, never inside it.**
`Main.qml:1978` handles `Keys.onEscapePressed`; `Main.qml:1993` handles bare `q`
guarded on `Qt.NoModifier`. Both work because Qt delivers `Keys.onPressed` to the
parent *after* the children, so a future FM mode that consumes `q` simply sets
`event.accepted = true` and the host handler never runs. The comment notes bare `q`
is IDE glue, not an FM default — the panel only consumes `Ctrl+Q`.

**Rule 4 — the panel's focus claim is a startup hazard for the sidebar too.**
`Main.qml:2092`:

> Earlier this FocusScope had `focus: false` to block the ListView's startup
> `view.forceActiveFocus()` from stealing focus from the editor. That wall worked
> for startup BUT also blocked our explicit `<leader>tf` focus grants […] Replaced
> with a one-shot Window-level startup override (`Window.Component.onCompleted`)
> that runs AFTER all child `Component.onCompleted` handlers.

### A.7 Shape 2 — the sidebar file tree

`Main.qml:2531-2736`. The single richest property set in the embedding.

| Property assigned | Value | Why |
|---|---|---|
| `rootPath` | `""` at declaration, then set imperatively | Required property; must be declared, but the real assignment is ordered (see below) |
| `restoreExpandedPaths` | set imperatively, BEFORE `rootPath` | Session restore of the tree shape |
| `showHidden` | `true` | An IDE project root is dotfile-dense (`.claude/`, `.github/`, `.gitignore`) |
| `respectGitignore` | `true` | Keeps `.venv/` and `node_modules/` out |
| `ignoredPathSet` | `gitController.ignoredPathSet` | The performance short-circuit; see B.6 |
| `compactScale` | `0.8` | 80% of FM default sizes; neo-tree density |
| `lazyExpand` | `true` | Viewport-driven expansion instead of an eager cascade |
| `statusProvider` | `gitProviderAdapter` | The git-badge seam; see B.7 |
| `windowState` | `treeOpsWindowState` | Turns on file operations |
| `onExpandedStateChanged` | `controller.saveExpandedPaths(paths)` | Persists the shape |
| `onFileActivated` | `controller.open_in_nvim(path)` + refocus editor | Row activation |

**The ordered-assignment race is the single hardest bug in the embedding.**
`Main.qml:2534`:

> `rootPath` + `restoreExpandedPaths` are assigned TOGETHER, imperatively, by
> `_applyTreeMount()` — deliberately NOT two independent declarative bindings. With
> separate bindings […] QML does not guarantee which one is applied first when
> `displayedRoot` changes. Under the THREADED render loop the `rootPath` update can
> reach the FM's `onRootPathChanged` → `beginMount` BEFORE the
> `restoreExpandedPaths` update is applied, so `beginMount` reads an empty set and
> falls through to `lazyExpand` — the whole tree mounts COLLAPSED. The bug was
> intermittent and only surfaced on real (threaded-loop) launches with a CLEAN
> working tree: when the tree is dirty the Active Changes panel mounts its own inner
> FileTreeView, and that extra instantiation work delays the main tree's `rootPath`
> update until after the cache update lands, masking the race.

The fix is a Python-side signal carrying both values as one payload:
`AppController.treeMountRequested(str root, list expanded)`
(`/home/jc/projects/symmetria-ide/src/symmetria_ide/app.py:445`), applied by
`fileTreeView._applyTreeMount(root, expanded)` which writes
`restoreExpandedPaths` first and `rootPath` second (`Main.qml:2604-2605`).

**The persistence side** is `/home/jc/projects/symmetria-ide/src/symmetria_ide/tree_state_cache.py`.
One JSON file per project at
`$XDG_STATE_HOME/symmetria-ide/projects/<sha256-of-root-truncated-to-16>.json`,
schema `{version, repo_root, saved_at, expanded_paths}`, written atomically through
`os.replace`, loaded with a stat-prune that drops paths no longer on disk. A load
failure of any kind resolves to `[]`, which the FM reads as "fall through to
`lazyExpand`".

### A.8 Shape 3 — the `windowState`-less path

Two sites instantiate `FmUi.FileTreeView` with **no** `windowState`:
`GitStatusPanel.qml:338` (the side panel's changes tab) and
`WorkingFileTreeView.qml:160` (the central git surface's changes master pane).

The FM's own header states the contract
(`qml/Symmetria/FileManager/UI/modules/filemanager/FileTreeView.qml:25`):

> File operations (delete/rename/create/yank/cut/paste/multi-select + chords) are
> dispatched through the shared FileOpsHandler/ChordHandler and require a non-null
> `windowState` — embedded consumers without one (IDE sidebar) stay
> navigation-only.

The FM's own `CLAUDE.md` names it *the windowState-less embedded tree path*:

> The `windowState`-less embedded tree path (IDE sidebar) bypasses the registry
> entirely — `TreeKeyHandler` keeps a legacy navigation-only switch + `gg` timer for
> that consumer; only when `root.windowState` exists does it dispatch.

So the tree ships **two key-handling implementations**: the registry-driven
dispatcher for hosts that supply a `WindowState`, and a legacy `switch` covering
j/k/h/l, `Ctrl+D`/`Ctrl+U`, Return, `gg`/`G`, `/` search and `s` flash for hosts
that do not.

**Why the IDE keeps the changes trees navigation-only** — `Main.qml:2776`:

> Scoped to the MAIN tree only: `GitStatusPanel`'s embedded tree stays
> navigation-only (no `windowState`), which lets `RenamePopup`'s positional bindings
> assume `fileTreeView` coordinates unconditionally. Extending ops to the changes
> pane means sharing this `WindowState` and making the positional trio
> `sidePanelTab`-aware.

### A.9 The host must supply the modal layer itself

The FM keeps `FileTreeView` popup-free on purpose. In the standalone application the
modal layer lives once at `FileManager.qml` scope. An embedding host that turns file
operations ON must replicate that role. `Main.qml:2753`:

> Every modal reachable from tree keys MUST be hosted: while
> `activeModal != modalNone` the tree swallows ALL keys (`TreeKeyHandler`'s first
> guard), so a reachable-but-unhosted modal would soft-lock the pane with no visible
> UI. Reachable set: delete (d), create (a), rename (r), fuzzy finder (f). Zoxide +
> context-menu are Miller-only — intentionally not hosted.

The IDE hosts `FmUi.DeleteConfirmPopup`, `FmUi.CreateFilePopup`, `FmUi.RenamePopup`
and `FmUi.WhichKeyPopup` as siblings of the tree inside `treeScope`
(`Main.qml:2818-2843`), and hosts `FmUi.FuzzyFinderPopup` at window scope
(`Main.qml:3386`) so it centres over the whole window and works with the sidebar
hidden.

`RenamePopup` additionally needs a positional trio the host must compute
(`Main.qml:2829`): `targetItemY`, `targetColumnX`, `targetColumnWidth`, derived from
`fileTreeView.currentItemBottomY` / `currentColumnX` / `currentColumnWidth` plus the
wrapper's offset.

The host also has to keep `WindowState.currentPath` pinned to the project root
(`Main.qml:2808`), with one exception recorded there: a root change arriving from
outside the sidebar while a modal is open must NOT call `navigate()`, because
`navigate()` unconditionally closes modals and would discard the user's typed input.

### A.10 Recorded friction points

Every one of these was paid for once. A port should read them as a test list.

| # | Friction | Record |
|---|---|---|
| 1 | **`Array.isArray()` is false for a PySide6 list.** `restoreExpandedPaths` fed from a Python `list[str]` arrives as a `QVariantList`, which is array-LIKE but fails `Array.isArray`. Every restore attempt was silently rejected. Fix: duck-type `x != null && x.length > 0`. | `.claude/memory/reference/qt-pyside/qml_qvariantlist_array_check.md` |
| 2 | **`pragma ComponentBehavior: Bound` rejects dynamic properties on C++ QObjects.** `m._scheduleOnChange = fn` on a `FileSystemModel` instance silently no-ops with one Qt log warning; the disconnect branch then never runs. Fix: a path-keyed JS map on the QML root. Avoid `WeakMap` keyed by the QObject — shiboken wrapper identity is not stable. | `.claude/memory/reference/qt-pyside/qml_strict_property_qobject.md` |
| 3 | **Typed parameter + default value is a load-time fatal in Qt 6.11.** `function fn(x: string = "")` throws `Type annotations are not supported (yet)`, the component becomes "unavailable", and the failure CASCADES: `FileTreeView` → `FileManager` → `Main.qml` → the IDE exits 1. The tip of the cascade blames the wrong file. | `.claude/memory/reference/qt-pyside/qml_typed_param_no_default.md` |
| 4 | **The installed module masks source-tree bugs.** Items 2 and 3 both shipped green because the user's normal launches hit `/usr/lib/qt6/qml/...`, not the source tree. Only a launch with `SYMMETRIA_IDE_FM_QML_PATH` set exercised the new code. | same two files |
| 5 | **Focus stolen on open** (A.6 rule 1), **focus stranded on close** (rule 2). | `qml_overlay_focus.md` |
| 6 | **The mount race** — declarative bindings for `rootPath` and `restoreExpandedPaths` collapse the tree, intermittently, only on a clean working tree. | `Main.qml:2534` |
| 7 | **`Ctrl+E` eats nvim's own `Ctrl+E`.** `Qt.ApplicationShortcut` intercepts before the editor terminal's key handling, so nvim's scroll-viewport-down is silently consumed. Accepted deliberately. | `Main.qml:271` |
| 8 | **Tab bubbling from the FM's ListView is an undocumented dependency.** The IDE's tab toggle works only because the FM tree claims no Tab and declares no `activeFocusOnTab` child. That is a property of an externally-versioned module. | `CLAUDE.md:259`, `WorkingFileTreeView.qml:145` |
| 9 | **The FM tree's default `showHidden: false` silently diverged the three mounts.** The main sidebar tree inherited the default while both auxiliary trees set it true, so dotfiles vanished from the sidebar but appeared in the changes panels. | `Main.qml:2632` |
| 10 | **A new FM component fails lint until reinstalled.** The FM repo's own memory records: a NEW component in `Symmetria.FileManager.UI` fails the quality gate ("anchors unresolved" on consumers) until `sudo cmake --install plugin/build` refreshes the `/usr/lib` snapshot qmllint resolves from. | FM `MEMORY.md`, `feedback_ui_module_deploy_for_qmllint` |

### A.11 The theme bridge

The panel and the host share one optional colour file, owned by neither.
`/home/jc/projects/symmetria-ide/src/symmetria_ide/ui_scheme.py` resolves it as
`$SYMMETRIA_UI_SCHEME` → `$XDG_CONFIG_HOME/symmetria/ui/color-scheme.json` →
`~/.config/symmetria/ui/color-scheme.json`. Format is
`{"colours": {"surface": "131316", …}}`, hex with or without `#`.

Three facts a port must carry:

- **The file is optional and usually absent.** Both apps ship a built-in dark palette
  that is the real default.
- **The two sides reload differently, and that is a visible defect.** The FM watches
  the file and re-applies live; the IDE takes a load-once snapshot at startup. Editing
  the scheme with an IDE window open repaints the FM-provided surfaces and leaves the
  IDE's own chrome stale until restart. `ui_scheme.py:23` says making the IDE side
  live is not merely "add a watcher": `Theme.qml` reads the map through a function
  call, and QML never re-evaluates a function call in a binding, so every token would
  first have to depend on a notifying property.
- **A bad value is DROPPED, not passed through.** QML converts a string to `color` at
  binding time and an unconvertible string lands on Qt's default (black or
  transparent) rather than the property's default — so passing `"red"` through would
  blank a token silently.

The host also never hardcodes FM colours. `gitProviderAdapter.colorForOperation()`
maps a porcelain char to `FmUi.FmTheme.gitStatus.*` (`Main.qml:3019`), so badge
colours follow whatever the FM ships.

### A.12 The embedding contract, stated plainly

This is what the Electron version has to offer in a new form.

1. **The panel is a component with a two-property constructor.** A host supplies a
   starting directory and receives a close request. Everything else the panel decides
   for itself. The full-panel embedding sets nothing beyond `initialPath` and
   `onCloseRequested`.
2. **The tree is a separate, far richer component.** Eleven inputs, three of them
   duck-typed extension points (`statusProvider`, `ignoredPathSet`, `pathFilter`),
   one density scalar, and two output signals (`fileActivated`, `expandedStateChanged`).
   It is the component the IDE actually reuses; the full panel is a convenience.
3. **Capability is opt-in through injected objects, not flags.** No `windowState` →
   navigation only. No `statusProvider` → no badges and zero overhead. No
   `pathFilter` → every row visible. `null` is always the safe default, and the FM
   never reaches back to the host for anything.
4. **The host owns the modal layer, the focus policy and the dismiss keys.** The
   component ships no popups and grabs focus exactly once, on construction of its
   inner list. A host that wants file operations must host four popups; a host that
   wants focus back must take it explicitly.
5. **Ordering of injected inputs is part of the contract, not an implementation
   detail.** The restore set must land before the root path, in the same synchronous
   turn. Anything that can reorder those two writes will collapse the tree
   intermittently.

Two corollaries for a port:

- **The duck-typed seams are the reason the reuse worked.** `statusProvider` is
  `{statusForPath(absPath) → {char, color, tooltip, adds, dels} | null, statusChanged
  signal}`. The file manager knows nothing about git. Recreating that boundary in
  TypeScript is a two-method interface, and it is the cheapest part of the whole
  port.
- **Everything expensive was ordering, focus and lifecycle.** Not rendering, not
  data. Expect the same distribution in Electron: React reconciliation order, DOM
  focus, and unmount/remount of a tree that owns filesystem watchers.

---

## Part B — git status

Six Python modules run git. Three of them are read-only comprehension providers, one
mutates, one is a shared subprocess shell, one is a watcher.

| Module | Role | Driven by |
|---|---|---|
| `git_controller.py` (2019 lines) | Working-tree status scanner + `GitStatusListModel` | Push — file watchers, debounced |
| `git_log_controller.py` (866) | Committed log, commit diff, working-file diff | Pull — a `queue.Queue` of requests |
| `git_branch_controller.py` (625) | Local branches + worktree annotation | Pull |
| `git_ops_controller.py` (364) | `pull` / `push` — the only mutations | User keypress |
| `git_subprocess.py` (131) | `GitExecutor` — the shared local/remote execution seam | — |
| `worktree_watcher.py` (213) | Recursive `watchdog` observer over the working tree | inotify |

### B.1 The complete command set, with exact flags

Every git invocation in the IDE, with its timeout.

| Command | Exact argv | Where | Timeout | Cadence |
|---|---|---|---|---|
| Resolve root | `git rev-parse --show-toplevel` | `git_controller.py:1317`, `git_ops_controller.py:282`, `git_subprocess.py:91` | 5 s | Once per scan / per op |
| **Status** | `git status --porcelain=v2 -z --branch --untracked-files=all` | `git_controller.py:1337` | 10 s | Once per debounced scan |
| Staged numstat | `git diff --cached --numstat -z` | `git_controller.py:1384` | 10 s | Once per scan |
| Unstaged numstat | `git diff --numstat -z` | `git_controller.py:1384` | 10 s | Once per scan |
| **Ignored set** | `git ls-files --others --ignored --exclude-standard --directory -z` | `git_controller.py:1457` | 10 s | Once per scan |
| Log page | `git log -z --no-color --max-count=100 --skip=<n> --pretty=format:<11 fields> [<ref> --]` | `git_log_controller.py:631` | 10 s | On request |
| Commit diff | `git show --no-color --format=%x00 --patch <hash>` | `git_log_controller.py:652` | 20 s | On commit selection |
| File diff (tracked) | `git diff --no-color HEAD -- <rel_path>` | `git_log_controller.py:698` | 10 s | On file selection |
| File diff (untracked) | `git diff --no-color --no-index -- /dev/null <rel_path>` | `git_log_controller.py:696` | 10 s | On file selection |
| Branches | `git for-each-ref --sort=-committerdate --format=<…> refs/heads` | `git_branch_controller.py:467` | — | On request |
| Worktrees | `git worktree list --porcelain` | `git_branch_controller.py:477` | — | On request |
| Pull | `git pull --no-edit (--rebase\|--no-rebase)` | `git_ops_controller.py:257` | 120 s | User keypress `p` |
| Push | `git push` — **never `--force`** | `git_ops_controller.py:270` | 120 s | User keypress `P` |
| Pull mode probe | `git config --get pull.rebase` | `git_ops_controller.py:298` | 5 s | Before each pull |

Notes that matter:

- **One `git status` per scan produces four things.** The `--branch` headers give the
  branch name, the upstream ref and the ahead/behind counts, so there is no separate
  `rev-list --count` call (`git_controller.py:1329`).
- **`-z` everywhere.** NUL delimiters round-trip filenames containing tabs and
  newlines. `git_controller.py:1381` states it explicitly.
- **`--untracked-files=all`** — the panel lists individual untracked files, not
  collapsed directories.
- **Untracked line counts are read in pure Python, not `wc -l`.**
  `git_controller.py:1400`: spawning 20 subprocesses per debounced scan would add
  ~10 ms of fork+exec, while `open + read + count` runs at ~50k files/s. The read is
  capped at **20 files**, skips a file whose first 8 KiB contain a NUL byte (matching
  how `git diff --numstat` classifies binaries), and the header still shows the FULL
  untracked count because that number is computed separately.
- **`git pull` resolves its own strategy.** `--rebase` iff `pull.rebase` is one of
  `true|interactive|merges|preserve`, else `--no-rebase`. Resolving explicitly means
  a divergent pull never trips git's "Need to specify how to reconcile divergent
  branches" fatal. This is lazygit's `auto` mode, copied deliberately.

### B.2 The status vocabulary

`git_controller.py:62-70` defines six semantic states, deliberately as stable string
identifiers with the hex values living FM-side:

```
STATE_UNSTAGED   = "unstaged"    # red    — worktree changes not yet staged
STATE_STAGED     = "staged"      # green  — staged for next commit
STATE_UNTRACKED  = "untracked"   # blue   — new file, never added to git
STATE_RENAMED    = "renamed"     # orange — staged rename or copy
STATE_CONFLICTED = "conflicted"  # magenta — unmerged
STATE_IGNORED    = "ignored"     # gray   — listed in .gitignore (rarely rendered)
```

**Porcelain XY reduces to ONE char + one state, with worktree precedence.**
`git_controller.py:165`:

> Worktree status (Y) takes precedence over index status (X) — the LazyGit
> convention. So an "MM" file (staged-then-modified) renders as unstaged red, not
> staged green: the user's most recent action is what they need to see first. The
> dual-badge "MM" rendering is a future seam, not v1.

Chars rendered: `M` modified, `T` type-changed, `A` added, `D` deleted, `R` renamed,
`C` copied, `?` untracked, `!` ignored, `U` conflicted, and `·` for a synthesised
directory aggregate. Tooltips come from a `(char, state)` table with a generic
`"<state> (<char>)"` fallback so an uncatalogued code never crashes the parser.

**The parser is a pure function over bytes.** `parse_porcelain_v2(blob) -> dict[str,
GitStatus]` (`git_controller.py:187`) handles all six record forms:

```
# branch.<field> <value>                                  — header (skipped)
1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>              — ordinary
2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <new>    — rename/copy (+ a second NUL field: the original path)
u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>    — unmerged
? <path>                                                  — untracked
! <path>                                                  — ignored
```

Malformed records are skipped silently, because partial output from a torn
`git status` must not crash the watcher loop. An unknown record prefix from a future
git version is dropped rather than raising.

**Renames.** A type-`2` record carries the original path in the NEXT NUL-terminated
field; the parser consumes it and stores it as `orig_path`. `R` and `C` are forced to
`STATE_RENAMED` regardless of the XY side.

### B.3 Directory aggregates — the reason the tree can badge a folder

`_add_directory_aggregates` (`git_controller.py:371`) walks every strict ancestor of
every changed path and synthesises an entry with `char='·'`, the highest-priority
descendant state, and a `"N file(s) changed"` tooltip. Priority ladder
(`git_controller.py:361`):

```
ignored 0 < untracked 1 < renamed 2 < staged 3 < unstaged 4 < conflicted 5
```

The rationale is a performance one, stated at line 376:

> Computed eagerly after every parse — cheap because N is typically tens, and depth
> rarely exceeds 10. Aggregating per call would be O(rows × depth) every paint frame;
> this pre-computation collapses it to O(1) hash lookup per `statusForPath` call.

That is a load-bearing shape for a port. The tree asks *per visible row, every
repaint*. The answer must be a hash lookup.

### B.4 Line counts and header buckets

`parse_numstat_blob` (`git_controller.py:428`) parses `<adds>\t<dels>\t<path>\x00`,
with the rename form putting an empty path in the first field and the new path in the
next NUL field. **Binary rows emit `-` for both columns and are SKIPPED** — the panel
cannot render `+? -?` meaningfully.

`_merge_numstat_into_map` picks which numstat side applies, mirroring the worktree
precedence: unstaged→worktree diff, staged→index diff, untracked→line count, renamed
or conflicted→staged first then unstaged, ignored→0/0.

`GitStats` (`git_controller.py:97`) is the three-bucket header aggregate: staged,
unstaged, untracked, each with adds, dels and a file count. One deliberate double
count:

> File counts come from the numstat output's path set, NOT from the rendered panel
> row count — a doubly-modified "MM" file legitimately appears in both the staged and
> unstaged buckets even though the panel renders only one row for it (worktree
> precedence per `_classify_xy`). The header is meant to answer "how much work do I
> have on each side", and that question is naturally split.

### B.5 Branch, ahead and behind

`GitBranchSync` (`git_controller.py:125`) and `parse_branch_header`
(`git_controller.py:293`) read three headers from the same `git status` output:

```
# branch.head dev              → branch name ("(detached)" normalised to "")
# branch.upstream origin/main  → upstream ref
# branch.ab +4 -1              → ahead=4, behind=1
```

Both `branch.upstream` and `branch.ab` are **absent when there is no upstream**, so a
local-only branch, a detached HEAD and an unborn branch all render as no indicator —
the same as "fully in sync". `behind` is only meaningful after a `git fetch`, because
git cannot know about remote commits it has not seen. The IDE never fetches on its
own.

`branchSyncChanged` is a **separate signal from `statusChanged`**
(`git_controller.py:644`):

> a `git push` zeroes `ahead` without touching the working-tree file map, so a
> binding on `statusChanged` alone would leave the status bar's `↑N` stale after a
> push.

Display is in the status bar (`qml/StatusBar.qml:207,237,245`): the branch name, then
`↑N` when `aheadCount > 0`, then `↓N` when `behindCount > 0`. Both hide at zero.

### B.6 Change detection — three watchers, one debounce funnel

This is the part a port must copy most carefully, because two of the three watchers
exist to cover a gap the first one leaves.

**Watcher 1 — `QFileSystemWatcher` on `.git` trigger files.** `_install_watcher`
(`git_controller.py:1669`) watches, when each exists:

- `<git_dir>/index`
- `<git_dir>/HEAD`
- `<git_dir>/MERGE_HEAD`
- `<git_dir>/refs/heads/<current-branch>` — derived by reading `HEAD`
- `<git_dir>/refs/remotes/<upstream>` — the loose upstream ref
- `<git_dir>/packed-refs` — the companion trigger when refs are packed

The last two exist purely so a `git push` refreshes the ahead count
(`git_controller.py:1687`). `_git_dir_for` (`git_controller.py:1644`) follows a
`.git` FILE containing `gitdir: <path>`, so worktrees and submodules work.

**Every event re-arms the watch.** `git_controller.py:1757`:

> Re-arms the watch if the file was atomically replaced (the inode the watcher held is
> now unlinked; the new file at the same path is a different inode, so
> QFileSystemWatcher silently stops firing on it).

**Watcher 2 — a recursive `watchdog` observer over the working tree.**
`worktree_watcher.py`. Its module docstring states why the first watcher is not
enough:

> `QFileSystemWatcher` covers `.git/{index,HEAD,MERGE_HEAD,refs/heads/<branch>}` —
> git's OWN state transitions (stage / commit / branch switch). Ordinary working-tree
> activity (saving a file in nvim, an agent rewriting sources, `echo >> file` in the
> shell pane, creating an untracked file) never touches `.git`, so the Active Changes
> panel and the tree badges stayed frozen until the next git operation.
>
> Why watchdog and not more `QFileSystemWatcher` entries: `QFileSystemWatcher` is
> non-recursive […] and its directory watches report only entry
> create/delete/rename — NOT in-place file modification, which is exactly the event
> an editor save or an agent `Edit` produces.

Its filters, all on the emitter thread before any Qt traffic:

- Event type must be in `{created, deleted, modified, moved}`. `opened` and
  `closed_no_write` are dropped explicitly, because `grep -r` or nvim opening a
  buffer would otherwise fork git on every navigation.
- Paths inside `.git` are dropped. Without this, **every scan schedules the next one
  forever**, because a scan touches the index mtime.
- Paths under the ignored set are dropped, via `GitController.is_path_ignored`.
- A leading-edge throttle of **50 ms**. The comment at `worktree_watcher.py:178`
  marks the coupling: leading-edge-only is safe ONLY because the emit that gets
  through restarts the 200 ms debounce, which outlives the 50 ms window.
- `OSError` from `Observer.schedule`/`start` (inotify exhaustion) degrades to
  `.git`-watcher-only refresh with a warning, never a crash.

**Watcher 3 — the not-a-repo sentinel.** `_arm_repo_sentinel`
(`git_controller.py:1598`) watches the project root as a DIRECTORY while
`rev-parse` finds no repo, so a `git init` or a clone recovers. It is paired with an
exponentially backed-off re-resolve from **1 s to 60 s**
(`_SENTINEL_BACKSTOP_MIN_MS` / `_MAX_MS`), covering the two cases the watch alone
misses: the watch failing to arm, and the partial-init race where `.git` exists but
`rev-parse` momentarily fails. The bug it fixes:

> without it the one-shot resolve found no repo and NOTHING re-checked, freezing the
> panel "clean" for the life of the instance even as the repo filled with commits.

**Plus one non-filesystem trigger.** `GitController.poke()`
(`git_controller.py:1798`) is wired to the nvim `gitpoke` capsule on `BufWritePost`
— "an editor save is the highest-signal 'status probably changed' event we have",
and it stays live even when the working-tree observer has degraded.

**Everything funnels through one 200 ms debounce timer** (`_DEBOUNCE_MS = 200`,
`git_controller.py:582`). `git commit` rewrites index, HEAD and
`refs/heads/<branch>` within milliseconds; the debounce collapses that burst to one
scan. The timer's `timeout` is connected twice: to `_wake_worker`, and
signal-to-signal to the public `workingTreeChanged`, so external consumers
(NeoVim's `checktime`, so open buffers reload when an agent rewrites them) get one
coalesced edge with no extra code.

**Remote mode replaces watchers with a poll.** `_REMOTE_POLL_MS = 5000`
(`git_controller.py:587`) — "inotify crosses neither SSHFS nor the network, so a poll
timer replaces both watchers there".

### B.7 Threading and publication

- One **daemon worker thread** per controller, owning a `threading.Event` stop flag.
  The worker loop is `wait → scan → wait` and **never raises**: a bare
  `except Exception` logs, because "the daemon thread dying silently would leave the
  watcher firing into a void" (`git_controller.py:1220`).
- A `threading.Lock` guards `_status_map`, `_stats`, `_resolved_root`,
  `_ignored_set` and `_branch_sync`.
- **`_publish` REPLACES dicts, never mutates them.** That invariant is what lets
  `changedPathSet` and `is_path_ignored` snapshot by reference under the lock and
  then read outside it.
- Cross-thread emits are wrapped in `gc.disable()` / `gc.enable()`. The recorded
  reason (`git_controller.py:637`, gotcha #10): Python 3.14's aggressive incremental
  GC races the Qt receiver-side wrapper allocation while the worker is mid
  signal-dispatch. **One `gc.disable` window covers all signals so the protection is
  unbroken across them.**
- Every receiver connects with an explicit `Qt.ConnectionType.QueuedConnection` and a
  grep-able `# queued:` comment at the connect site. `GitStatusListModel`'s connect
  states why: a direct connection would call `beginResetModel` from the worker, which
  crashes Qt's model/view invariants.
- The watcher rebuild is marshalled back to the GUI thread through a private signal
  `_watcherRefreshRequested(str resolved, str upstream)` that carries **both** values
  as one snapshot, because reading the upstream live "under a rapid repo-switch could
  arm the watcher for root A with root B's upstream".

**Failure policy is asymmetric on purpose** (`git_controller.py:1236`):

> Steps 3-5 [numstat, numstat, untracked line count] are best-effort: each falls back
> to an empty dict on subprocess failure, so a transient git-shell hiccup degrades to
> "no line counts shown" rather than blinking the whole panel away. The status scan
> (step 2) keeps its preserve-previous-on-None contract because it drives the file
> LIST, not just the counts.

And the branch sync is deliberately NOT published on a failed scan, so a transient
error cannot zero a valid `↑N`.

### B.8 The two consumption paths — decoration versus panel

The same scan feeds two completely different renderings.

**Path 1 — per-row decoration on a file tree.** `GitController.statusForPath(abs) →
QVariantMap` (`git_controller.py:1106`) is a `@Slot`, called by the FM tree for
**every visible row on every repaint**. It converts the absolute path to
resolved-root-relative, does one dict lookup, and returns
`{char, state, tooltip, path, additions, deletions, origPath?}` or `{}`.

`{}` rather than `None` is deliberate: `QVariantMap` marshalling turns `None` into
`undefined` in QML, while `{}` is always a defined empty map, and the FM treats null
and empty identically.

Between that slot and the FM sits **`gitProviderAdapter`** (`Main.qml:2973`), a
sixteen-line `QtObject` that exists for one reason:

> `GitController` (Python side) returns `{char, state, tooltip}` where `state` is a
> semantic name. The FM's `FileTreeView.statusProvider` contract expects
> `{char, color, tooltip}` where `color` is a resolved colour value.

It maps char→`FmUi.FmTheme.gitStatus.*` and re-emits `statusChanged` so the tree
invalidates every delegate binding in one pass. **Colour keys on the porcelain CHAR,
not the staged/unstaged state** (`Main.qml:3007`):

> This is the 2026-06-27 switch away from index-state colouring — modified (amber)
> now reads distinct from deleted (red), where the old scheme painted both "unstaged
> red". The staged/unstaged axis is surfaced separately by the Active Changes summary.

Char → colour: `M`/`T` amber, `A` green, `D` red, `?` blue, `R`/`C` orange, `U`
magenta, `!` gray, unknown → amber (deliberately not red, so an unrecognised status
stays visible without implying deletion).

**Path 2 — a dedicated panel.** `GitStatusListModel` (`git_controller.py:1885`) is a
flat `QAbstractListModel` projection with seven roles: `path` (absolute),
`displayName` (repo-relative), `statusChar`, `statusState`, `tooltip`, `additions`,
`deletions`. It filters directory aggregates out (`char == '·'`) and sorts
alphabetically by repo-relative path for stable ordering across scans.

Two performance details in `_refresh`:

- A full `beginResetModel`/`endResetModel` is used rather than a diff, because "for
  typical change-set sizes (tens of files) a reset is cheaper than computing a diff".
- **`if new_items == self._items: return`** — an identity check that skips the emit
  entirely. Common when an unrelated `.git/` file changes, e.g. an fsmonitor cache
  touch. Without it, every such touch invalidates every visible delegate binding for
  nothing.

**And a third derived output**: `changedPathSet` (`git_controller.py:920`) is a
`{absPath: true}` map covering the root, every changed leaf and every ancestor. It
drives the FM's `pathFilter`. Because `_add_directory_aggregates` already synthesised
the ancestors, building it is a single-pass fold — no separate graph walk.

### B.9 The dedicated panel's UI

`/home/jc/projects/symmetria-ide/qml/GitStatusPanel.qml`, 359 lines, is a
`FocusScope` with a header, an empty state and an embedded FM tree.

- **Header**: three bucket rows in a `Repeater` — `●` staged, `○` unstaged, `✦`
  untracked — each showing `+adds`, `-dels` and `(n)`. A row hides itself when its
  file count is 0.
- **The bucket glyphs are deliberately NEUTRAL** (`GitStatusPanel.qml:226`): the
  SHAPES carry the staged/unstaged/untracked distinction, while COLOUR is reserved
  for the operation grammar (green additions, red deletions) so "green = additions"
  reads the same on the header as on the badges. They formerly borrowed
  staged-green / unstaged-red, which made green mean "staged" here and "added" on
  the badges — one colour, two meanings.
- **Body**: `FmUi.FileTreeView` with `initialExpandDepth: -1` (always expanded),
  `respectGitignore: false` (force-added gitignored files must be visible or the panel
  lies about the working tree), `showHidden: true`, `compactScale: 0.75`, and the
  `pathFilter` narrowing rows to the changeset.
- **Empty state**: one dim line, `"No changes"`, top-aligned. Deliberately not
  centred — "Clean is the normal state of a repo, so it should read as a footnote."
- The inner tree is `visible: root.hasChanges`, because a tree with an empty
  `pathFilter` still mounts its root row and would draw a lone project folder under
  "No changes".

### B.10 The diff view

`/home/jc/projects/symmetria-ide/qml/githistory/DiffView.qml`, 138 lines, is the
shared unified-diff renderer for both the commit diff and the working-file diff.

- A **virtualised `ListView` over `diffText.split("\n")`**, `cacheBuffer: 800`,
  `clip: true`, reset to the top on every model change.
- Each line is classified by leading marker in `_lineKind` and tinted from
  `Theme.color.diff.*`. **Order matters**: `+++` / `---` file headers must be caught
  as `meta` BEFORE the bare `+` / `-` checks.
- Kinds: `hunk` (`@@`), `meta` (`+++`, `---`, `diff `, `index `, `new file`,
  `deleted file`, `similarity `, `rename `, `old mode`, `new mode`), `add`, `del`,
  `context`.
- Lines wrap (`Text.WrapAnywhere`) rather than clip, so nothing is lost.
- **Three host-supplied state flags** keep it stateless: `active` (a target is
  selected), `ready` (the diff is current FOR that target — the host's async-gap
  guard, hash-match for commits, path-match for files), and `diffText`. While a
  target is active but its diff has not landed the renderer shows `loadingText`
  rather than a stale previous patch.
- The split is lazy and gated: `root.active && root.ready && diffText.length > 0`.

Backing it, `_DIFF_CHAR_CAP = 400_000` (`git_log_controller.py:77`) truncates a
pathological patch with a visible `… diff truncated at 400,000 characters …` notice
rather than stalling QML text layout.

### B.11 Staging actions — there are none, on purpose

The boundary is a product decision, recorded in
`.claude/memory/project/active/gitview_history_viewer.md`:

> **Boundary refined 2026-06-29:** the line is no longer "read-only, never mutate"
> but **no AUTHORING mutations** — stage/commit/rebase (content creation) stay in
> nvim/shell; **TRANSPORT/sync ops are now in scope**. […] Rationale the boundary
> holds: sync moves *existing* commits between local/remote (navigation), it doesn't
> author content, so it doesn't undercut the thesis.

The thesis being protected:

> when agents author the commits, the developer loses the understanding that comes
> free from writing code — the **cognitive gap**. GitView exists to shrink it.

So the IDE has **no stage, no unstage, no commit, no discard, no stash**. It has
`pull` (`p`) and `push` (`P`), each behind a single-flight `_busy` gate on its own
worker thread — a separate lane from the log controller, because "a multi-second
`git push` must never block commit-diff navigation queued behind it". Push bubbles up
to a Main-scope confirm dialog; pull dispatches directly. Feedback is a toast with
`running` / `success` / `error` severities, where `error` never auto-hides and is
dismissed with Escape from either sub-view.

The forward plan is in the same memory file: "prefer read/comprehension features
(blame, file history, catch-up range diff, agent grouping, review frontier). For new
ACTIONS, allow transport/sync (fetch/prune are natural next) but still do NOT add
AUTHORING mutations."

### B.12 The git surface as a whole

`GitHistoryView.qml` is a central surface (`Ctrl+Shift+G`) with three Tab-cycled
master/detail sub-views:

- **changes** — `WorkingFileTreeView` (an `FmUi.FileTreeView` at the FM's default
  row height) driving `WorkingFileDetailView`. This is the DEFAULT on entry when the
  tree is dirty.
- **history** — `BranchListView` (≤6 rows, entered with `b`, filters the log) above
  `CommitListView`, driving `CommitDetailView`.
- **prs** — GitHub PRs via the `gh` CLI. `Enter`-driven, not selection-driven,
  because each detail load is two network calls; `o` toggles closed/merged, `r`
  refreshes. **Never polled.**

Every sub-view binds to INJECTED controllers and models, never globals, "so the
subtree lifts cleanly into a future standalone `Symmetria.Git.UI` module". That is
the same discipline the FM used, applied ahead of the extraction.

One reuse detail worth carrying: `WorkingFileTreeView` needs a `_statusRevision`
counter (`WorkingFileTreeView.qml:84`) bumped on every `modelReset`, because a tree
row's status comes from a `statusProvider` FUNCTION call, which has no automatic
binding dependency — so without the counter the detail header's ±counts would go
stale on an in-place edit of the already-selected file.

### B.13 Performance measures, collected

| Measure | Value | Where |
|---|---|---|
| Debounce on every change trigger | 200 ms | `_DEBOUNCE_MS` |
| Emitter-thread throttle before the debounce | 50 ms, leading edge | `worktree_watcher.py:67` |
| Remote (SSHFS) poll cadence | 5 s | `_REMOTE_POLL_MS` |
| Not-a-repo re-resolve backoff | 1 s → 60 s, doubling | `_SENTINEL_BACKSTOP_*` |
| Untracked line-count cap | 20 files | `_count_untracked_lines(cap=20)` |
| Binary sniff before counting lines | first 8 KiB, NUL byte | same |
| Directory aggregates | pre-computed once per scan, O(1) lookup per row | `_add_directory_aggregates` |
| List-model refresh | skipped entirely when items are identical | `GitStatusListModel._refresh` |
| List-model update strategy | full reset, cheaper than a diff at tens of rows | same |
| Ignored set | one `ls-files --directory` pass replaces N `check-ignore` subprocesses | `_run_ignored_set` |
| Log page size | 100 commits, `--skip` pagination | `_PAGE_SIZE` |
| Diff render cap | 400 000 characters, visible notice | `_DIFF_CHAR_CAP` |
| Diff rendering | virtualised `ListView`, `cacheBuffer: 800` | `DiffView.qml:82` |
| Ignored-tree churn | filtered on the watchdog emitter thread, never crosses into Qt | `worktree_watcher.py:191` |
| `.git` self-trigger loop | broken by `_is_git_internal` | `worktree_watcher.py:77` |
| GC | disabled around every cross-thread emit window | gotcha #10 |

### B.14 The ignored-path short-circuit — the single biggest win

This deserves its own record because it is the one measured optimisation that crosses
the repository boundary.

`Main.qml:2652`:

> Pre-computed ignored-path set from the IDE's `GitController`. Lets the FM
> short-circuit its per-directory `git check-ignore --stdin` shell pipeline
> (sequential, ~30–40 ms per dir), which dominated tree-mount time on
> medium-to-large repos (bambin: ~4 s → target sub-100 ms). The `GitController`
> computes this in a single `git ls-files --others --ignored --exclude-standard
> --directory` pass per status scan.

`--directory` collapses an entirely-ignored subtree into one entry (`node_modules/`
rather than every file inside), which keeps the map small on Node repos. Paths are
absolute and trailing-slash-stripped to match `FileSystemEntry.path` semantics.

**The `None`-versus-`{}` distinction is load-bearing** (`git_controller.py:896`):

> Returns `None` (NOT an empty dict) when there's no resolved repo OR the first scan
> hasn't completed yet. The FM's QML gates its short-circuit on truthiness via
> `if (root.ignoredPathSet)`, so a `None` return makes the FM fall back to its
> per-directory `check-ignore` path until real data arrives — crucial because a
> truthy-empty dict would cause the FM to treat NOTHING as ignored, over-expanding
> `.venv` / `node_modules` / etc. and exploding the cascade past the model ceiling.

Note the cross-language trap in that sentence: `{}` is falsy in Python and truthy in
JavaScript. The contract is written to read correctly on both sides. **A TypeScript
port loses the free half of this and must encode the tri-state explicitly**
(`undefined` = not yet known, `Set` = known, possibly empty).

And `set_repo_root` clears `_ignored_set` synchronously on a project switch
(`git_controller.py:962`), because leaving the previous project's set live would let
the new tree mount against stale data.

---

## Part C — the side panel: files ↔ changes tabs

Shipped 2026-08-17 across two commits on the `feat/side-panel-tabs` branch:

- `1b16ea1 feat(chrome): split the side panel into files and changes tabs`
- `7b42214 fix(chrome): stop the side-panel tabs stranding keyboard focus`
- merged as `99c044f Merge pull request #29 from CaceresCallieri/feat/side-panel-tabs`

### C.1 What it replaced, and why

`Main.qml:2240`:

> `GitStatusPanel` and `FileTreeView` were CO-MOUNTED and stacked vertically until
> 2026-08-17, the changes pane capped at half the column and folding away when clean.
> Two trees splitting one narrow column meant neither had room: the changes pane
> scrolled inside its cap while the file tree lost half its height to a panel the
> user might not be reading. Tabs give whichever one the user is actually using the
> whole column.

The column is 280 px wide, fixed (`Layout.minimumWidth: 280`,
`Layout.maximumWidth: 280`).

### C.2 Layout

A `FocusScope` named `treeScope` with a `bg.bar` matte and one `ColumnLayout` of
`spacing: 0`:

1. **`locationHeader`** — always visible. Shows `controller.displayedRootCompact`
   (HOME-collapsed, `Text.ElideMiddle` so both the leading `~` and the trailing
   basename survive an overflow), a worktree branch glyph when the chrome is
   re-rooted onto an agent's worktree, and an accent dot when anchored. Anchored
   state is signalled **twice** — colour flip AND dot — deliberately, because "colour
   alone fails on the edge case where the user has reduced palette saturation at the
   compositor level".
2. **`sidePanelTabs`** — a `SegmentedControl`, centred, `horizontalPadding:
   Theme.spacing.sm` (narrower than the default because the column is 280 px beside a
   scrollbar).
3. **The two bodies**, both declared, one visible:
   - `GitStatusPanel` — `visible: root.sidePanelTab === 1`
   - `FocusScope { FmUi.FileTreeView }` — `visible: root.sidePanelTab === 0`

`spacing: 0` is deliberate. `Main.qml:2261` records that `spacing.lg` produced "a
~26px band that read as 'blank wallpaper' rather than panel separation", and that
each sub-section already contributes its own internal padding.

**Never a `Loader` for the bodies.** `Main.qml:2248`:

> A `Loader` would remount the FM tree on every toggle, discarding its expanded-path
> state and scroll position and re-running the mount race documented at
> `_applyTreeMount()`. An invisible `ColumnLayout` child claims no space, so the cost
> of keeping both is the idle memory of one mounted tree, not layout height.

`CLAUDE.md:261` adds the symptom: "a bug that surfaces as 'the tree keeps
collapsing', never as an error."

### C.3 The tab control

`SegmentedControl` is the IDE's single switcher component — four surfaces
hand-rolled the same control before it existed, "which is why the IDE read as having
more toggles than it has ideas".

The side panel's `segments` array (`Main.qml:2419`):

```qml
segments: [
    {key: "files",   label: "files",   icon: Theme.glyph.fileTree},
    {key: "changes", label: "changes", icon: Theme.glyph.surface.git,
     badge: gitStatusList.count > 0 ? String(gitStatusList.count) : ""},
]
```

Three rules encoded there:

1. **The count is a `badge`, not part of the `label`.** With icons set, the label
   draws only on the CURRENT segment. A count composed into the label would disappear
   from the changes tab exactly while the user is on the files tab — "the one moment
   it is telling them something they cannot already see." A badge draws in every
   state.
2. **Empty string at zero**, so a clean tree shows a bare glyph rather than a `0`
   that reads as a stat.
3. **The array is REBUILT when the count changes, never computed by a function.**
   `SegmentedControl.qml:63`: "a function call in a QML binding does not re-evaluate
   […] so a `labelFor(key)` property would silently freeze the first value it
   computed." Rebuilding is free here because the delegates hold no state and back no
   process — explicitly the OPPOSITE of the agent/terminal pane Repeaters, where
   delegate churn kills a running process.

`SegmentedControl` also declares that **keyboard is not its business**
(`SegmentedControl.qml:33`):

> Every one of these switchers has a chord that is the primary path […] and the click
> is the convenience twin — a non-negotiable of the IDE, so a consumer that adds a
> segment here must also give it a key.

### C.4 Keyboard reachability — two keys, two jobs

This split is the design's core, and `CLAUDE.md:258` states it as a rule:

> **Two keys, two jobs, and the split is deliberate.** `Ctrl+Shift+D` (application
> scope) changes what the panel SHOWS without pulling focus out of the surface you
> are typing in; `Tab` (panel scope) switches AND carries focus, because there you
> are navigating. Hence `_flipSidePanelTab()` separate from `_toggleSidePanelTab()` —
> "unifying" them is the regression
> `tests/test_main_qml_terminal_wiring.py::test_side_panel_tab_chord_does_not_steal_focus`
> guards.

Three functions, at `Main.qml:79-113`:

| Function | Does | Callers |
|---|---|---|
| `_flipSidePanelTab()` | flips `sidePanelTab` only | `Ctrl+Shift+D` |
| `_toggleSidePanelTab()` | flip + focus | `Tab` on `treeScope` |
| `_focusSidePanelTab()` | focus the current tab's inner `ListView` | both of the above, the header click, `Ctrl+L` re-entry, the changeset-edge handler |

**`Tab` must stay a `Keys.onPressed`, never a `Shortcut`.** `Main.qml:2129`:

> An application-scope Tab would fire from every surface and cost the terminal its
> completion key and nvim its own Tab, which no side-panel feature is worth. Scoped
> here it is inert unless the side panel already holds focus, where Tab has no
> competing meaning.
>
> It works because an unhandled Tab BUBBLES up the focus chain from the FM's inner
> ListView to here: the FM's `FileTreeView` owns no Tab handler and declares no
> `activeFocusOnTab` child, so Qt's focus traversal never claims it first.

Its guards, all three load-bearing:

```qml
Keys.onPressed: function (event) {
    if (event.key !== Qt.Key_Tab && event.key !== Qt.Key_Backtab) return;
    if ((event.modifiers & ~Qt.ShiftModifier) !== Qt.NoModifier) return;
    if (treeOpsWindowState.activeModal !== treeOpsWindowState.modalNone) return;
    root._toggleSidePanelTab();
    event.accepted = true;
}
```

- **Backtab toggles too**, rather than going backwards: with exactly two tabs
  "previous" and "next" name the same destination, and a Shift variant that did
  nothing would read as a broken key.
- **The modifier mask lets Shift through and nothing else**, so `Ctrl+Tab` no longer
  flips a tab.
- **The guards return WITHOUT setting `event.accepted`**, so the key travels on
  rather than being eaten.

`Ctrl+L` re-entry from a central pane lands on **whichever tab is current**, so
coming back resumes where the user left off (`Main.qml:2850`). It is guarded on
`controller.treeVisible`, because `AppController._on_nav_event` emits
`focusTreeRequested` unguarded on nvim spillover and would otherwise focus an
invisible item.

`_focusSidePanelTab()` handles the one state the files tab never has — EMPTY:

```qml
function _focusSidePanelTab(): void {
    if (root.sidePanelTab === 1) {
        if (gitStatusPanel.hasChanges) gitStatusPanel.focusInternal();
        else                            gitStatusPanel.forceActiveFocus();
        return;
    }
    fileTreeView.focusInternal();
}
```

On a clean tree the inner `FileTreeView` is `visible: false`, and an invisible item
cannot take activeFocus — so `focusInternal()` there would drop focus into nothing
and the user could not even press Tab to get back out. Focusing the panel's own
`FocusScope` parks focus inside the side panel with `treeScope`'s Tab handler still
above it in the chain.

### C.5 The focus bug the fix commit closed

`7b42214 fix(chrome): stop the side-panel tabs stranding keyboard focus` names three
paths, each reachable in ordinary use. Quoting the commit body:

> - **Tab had no modal guard.** The FM's own key swallow does not cover it: that eats
>   keys aimed at the TREE, while a modal's TextInput holds focus and bubbles whatever
>   it declines straight past the tree. `RenamePopup` and `DeleteConfirmPopup` claim
>   Tab; `CreateFilePopup` does not — so Tab while typing a new filename flipped the
>   tab and yanked focus out of the open dialog, which then swallowed the Escape that
>   would have closed it. Tab now also ignores every modifier but Shift, so
>   `Ctrl+Tab` no longer flips a tab.
> - **`Ctrl+Shift+D` pressed while the panel already held focus** hid the body owning
>   activeFocus, and Qt drops focus off a hidden item. The chord now re-seats focus,
>   guarded on `treeScope.activeFocus`, so the no-steal contract still holds from
>   every other surface.
> - **The changeset filling under the user was unhandled**: parked on the empty
>   changes tab, editing a file made the tree appear while focus stayed on the outer
>   scope. One handler now covers both edges, and defers through `Qt.callLater` — it
>   and the tree's own `visible` binding react to the same notification with no
>   guaranteed order.

That third fix is the subtlest and the most portable. `Main.qml:2917`:

> ⚠ Deferred via `Qt.callLater`, and that is load-bearing. This handler and the
> tree's own `visible` binding both react to the SAME `hasChangesChanged` emission,
> and QML guarantees no order between them. Focusing synchronously would work only
> while the binding happens to run first — and would silently strand focus on an item
> that hides one notification later if that order ever inverted. Deferring runs us
> after every binding for this emission has settled.

The handler also re-checks its conditions INSIDE the deferred call, because the tab,
the focus and the changeset can all move again before it runs.

The same commit also fixed `onFocusTreeRequested` to guard on `treeVisible`, and
retired stale comments (a comment declaring `Ctrl+Shift+D` free, 65 lines above the
`Shortcut` that binds it).

### C.6 Properties that were REMOVED with the tabs

`GitStatusPanel` lost three properties, and `CLAUDE.md:263` says not to bring them
back:

| Removed | What it did | Why it is gone |
|---|---|---|
| `maxHeight` | capped the panel at half the column | nothing is shared now — the tab owns the column |
| `collapsed` | host-driven fold while the central git surface showed the same changeset | the user picks the tab, so folding under them overrides a choice they just made |
| `reachable` | `visible && !collapsed`, gated by the focus chords | "reachable" is now just "this tab is current" — a question the HOST owns |

Also removed: the `onActiveFocusChanged` handlers that wrote a sticky
`activeTreeSubPane`. `Main.qml:2486` explains they became unreachable — an invisible
item cannot take activeFocus, so a pane only ever gains focus while its tab is
already current, and the write could only restate what is already true.

And the auto-reset guard is gone, because the changes tab is now always a legal
value: it draws an empty state instead of hard-hiding.

### C.7 One latent Qt Layout trap, worth carrying

`GitStatusPanel.qml:213`:

> ⚠ Explicit `false`, and it is load-bearing. A Layout nested directly inside another
> Layout gets `Layout.fillHeight: true` by DEFAULT (Qt Quick Layouts, unlike a plain
> Item, which defaults false) — so without this line the header competes with the tab
> body for the leftover column height. It was invisible while this panel was sized to
> its own content […] the moment the panel became a full-height tab it pushed the
> empty state into the vertical middle of the column and stole rows from the changes
> tree.

The web analogue is the same class of bug: a flex child's default `flex: 0 1 auto`
versus an explicit `flex: 1`. Expect one of these when the panel becomes
full-height.

### C.8 What a Mesura Code sidebar should inherit

- **Two tabs, one body visible, both mounted.** Never unmount the tree to switch
  tabs — it owns watchers, scroll position and expanded state.
- **The tab header is the count.** One glyph plus a badge; the label only on the
  active tab.
- **Two keys with different focus semantics.** One that shows without stealing focus,
  one that navigates and carries it. Ship both, and make the second scoped to the
  panel so it does not cost a global key.
- **Empty state, never a vanishing body.** And then handle BOTH edges of the
  changeset emptying and filling, deferred past the render that reacts to the same
  event.
- **Every route into a tab lands focus in the same place.** A click that leaves focus
  behind makes the next key press read as dead.
- **A modal guard on the tab key.** The tree's own key handling does not cover a key
  that a dialog's text input declines.

---

## Part D — the Qt→Electron transition record

### D.0 The headline: this is not a plan, it is a shipped product

`docs/t3-migration-execution-plan.md` is 634 lines, dated **2026-08-19**, and it is
**untracked in git** — `git status` in `symmetria-ide` shows it as `??`. It was never
committed. It targets a fork named `symmetria-ide-next`.

That fork exists. It was created **2026-08-20**, renamed **Mesura Code** on
**2026-08-21** (`d14c29ea5 feat(mesura): name the product Mesura Code and give it
Mesura's mark`), and lives at `/home/jc/projects/mesura-code` with
`upstream = https://github.com/pingdotgg/t3code.git`. As of 2026-08-24 it carries
**33 fork-only commits** over 2749 upstream commits, one completed weekly upstream
sync (`upstream-sync/2026-W34`), a shipped Symmetria Shell bar integration, shipped
STT dictation, and its own application icons.

**So "a NEW port called Mesura Code" is not new.** The live authorities are
`/home/jc/projects/mesura-code/AGENTS.md` and
`/home/jc/projects/mesura-code/docs/mesura/adr-002-one-window-many-projects.md`, and
**ADR-002 contradicts the migration plan on windowing.** Anything written now must
reconcile with those two files, not with the plan.

### D.1 Document provenance

| Document | Written | Git status | Live? |
|---|---|---|---|
| `docs/t3-migration-execution-plan.md` (634 lines) | 2026-08-19 | **untracked** | superseded in parts |
| `docs/framework-pivot.md` (181 lines) | 2026-06-07 | tracked | **historical record only** |
| `docs/tech-stack.md` (97 lines) | 2026-06-09 | tracked | live for `symmetria-ide` only |

Both June documents open with a kill notice. `docs/framework-pivot.md:3`:

> ⚠ **REVERSED 2026-06-07 — this pivot was decided, partly executed, then abandoned.
> The IDE stays on PySide6/QML.** This document is kept ONLY as the historical
> reasoning record of a considered-and-rejected direction — it is **no longer the
> north star; do not plan work from it.**

The chronology: **QML (Apr–Jun) → Tauri pivot (Jun 5) → reversal to QML (Jun 7) → T3
Code fork plan (Aug 19) → Mesura Code shipping (Aug 20 onward)**. The August plan
does not reference either June document. It does not re-argue framework choice; it
starts from "fork T3 Code" as given.

### D.2 What the plan decided

**The core move is fork, not build.** `docs/t3-migration-execution-plan.md:5`:

> This document is the authoritative execution plan for `symmetria-ide-next`, the
> direct T3 Code fork that will become the next Symmetria IDE.

`:7`:

> The current PySide6/QML repository remains the behavioral reference, stable daily
> driver, and rollback product. Its implementation roadmap remains valid as a record
> of the current product. It does not define the implementation sequence for the T3
> fork.

**The Locked Architecture** (`:77-92`) is fourteen statements. The load-bearing ones:

> - One Electron application owns all project windows.
> - One `BrowserWindow` and renderer represent one registered T3 project.
> - One shared background server owns durable product state.
> - A linked worktree remains a thread context inside its parent project window.
> - The launcher replaces unanchored navigation and project-anchor mode.
> - Configuration precedence is committed `.symmetria/ide.json`, machine-local
>   project override, user default, then provider default.
> - The fork owns its application IDs, schemes, profiles, state directories,
>   sockets, packages, release endpoints, and mobile identities.
> - The QML IDE remains unchanged during coexistence.

**The scoping decision** (`:15`):

> The first usable release is a project-scoped agent workstation. It must replace the
> current IDE for the daily agent workflow before the editor, File Manager, browser,
> mobile, and secondary refinements are complete.

**Sole authority per fact** (`:116`):

> Renderers must not derive server facts from project-filtered state. QuickShell and
> mobile must not read SQLite, project configuration, provider payloads, tool
> payloads, or transcripts.

**A multi-agent factory model**, not a single-agent one (`:9`, `:134`): nineteen
lanes L0–L18, nine roles, eight phases with seven barriers, a twelve-car merge train,
nine gates G0–G8, ten test layers T0–T9, a ledger at `factory/work-items.json`.

**Contract-first artifacts** (`:330-341`): six Effect schemas
(`thread-summary-v1`, `surface-presence-v1`, `shell-command-v1`, `command-result-v1`,
`draft-v1`, `project-icon-v1`) plus golden snapshots, event-stream fixtures, invalid
fixtures and idempotency fixtures. The wire rules at `:341`:

> Every stream begins with a full snapshot revision. Every command carries
> `commandId` or `clientRequestId`. Draft updates carry `expectedVersion`; stale
> updates return a typed conflict with the current version. […] Consumers ignore
> additive unknown fields, reject unsupported major versions, and never infer a
> missing event from local timeout alone.

**Performance gates** (`:477-492`), and the measurement rule that outlives them:

> Use proportional set size from `/proc/<pid>/smaps_rollup`, not summed RSS alone.
>
> The performance lane records the QML baseline with the same harness. **A result
> without a control measurement does not pass.**

Targets: 5 windows below **800 MiB PSS** before provider processes; 7 windows near or
below **1.05 GiB**; window close returns renderer PSS within 10% after two minutes;
**zero owned-process orphans 60 s after owner death**; no unexplained monotonic growth
over 40 active soak hours.

**A rollout ladder R0–R5** ending at `:560`:

> ### R5 QML Retirement Decision
> - Separate authorization after sustained use.
> - QML binaries and state remain intact until that decision.

### D.3 What was rejected, and why

The August plan rejects little explicitly — it is an execution plan, not a decision
brief. The rejection record is in the two June documents.

| Option | Verdict | Reason, quoted |
|---|---|---|
| **Qt in pure C++** | start in Python | `tech-stack.md:52` "slower iteration during exploration; compile step taxes Phase 0 discovery" |
| **Tauri 2** | adopted 2026-06-05, **reversed 2026-06-07** | `tech-stack.md:59` "the decisive factor: file-tree + git-status are reused across Shell + FM + IDE via the FM's `Symmetria.FileManager.UI` QML module, which a web IDE can't embed without reimplementing (a DRY violation)" |
| **Electron** | **rejected outright, June** | `tech-stack.md:63` "150–250 MB idle baseline even in Electron 34 (2026). Aesthetic drift toward generic web look. Symmetria aesthetic must be re-created in CSS. **Verdict: rejected. Contradicts *beauty in functionality*.**" |
| **Native Rust (iced/egui/gpui)** | rejected for now | `tech-stack.md:68` gpui pre-1.0; immediate-mode awkward for a retained-mode IDE; "months before the first pixel" |
| **Slint** | not ready in 2026 | `tech-stack.md:72` its own Oct-2025 post admits desktop maturity lags embedded |
| **Dioxus** | rejected | WebView-based, same IME/latency issues as Tauri |
| **Flutter desktop** | rejected | weak Linux pty story; Symmetria aesthetic needs heavy custom widgets |
| **Forking an AGPL agent UI** | harvest patterns, do NOT fork | `framework-pivot.md:35` AGPL-3.0-or-later with permanently-mixed GPL-3.0 third-party copyright, no CLA path |
| **Porting Neovide-grade animation to web canvas** | deliberately declined | `framework-pivot.md:44` "every web nvim-GUI that attempted it — uivonim, NyaoVim — is dead" |

**RAM was measured and killed as an argument** (`framework-pivot.md:159`):

> Empirical PSS on this machine: **Terax core (app + WebView) = 213 MB**; **Symmetria
> IDE fresh/idle = 217 MB**. They are **within 2%** […] **RAM is therefore NOT a
> valid reason for the pivot**.

**Two of the plan's own decisions were reversed inside Mesura Code, by measurement.**

- ADR-001 rejected one instance per project on memory grounds.
- ADR-002 then rejected the whole windows framing.
  `docs/mesura/adr-002-one-window-many-projects.md:9`:

  > **One instance, one window, every project inside it.** A project is a selection
  > within that window, not a window and not a process.

  `:46`:

  > **The current architecture is flat.** An additional project costs about **890
  > bytes** […] measured on real data: 7 projects = 1 249 bytes, 14 threads = 4 982
  > bytes.

  `:60`:

  > **A window does not amortize.** Of the renderer's 233 MB RSS, **196 MB are private
  > pages** (170 of them dirty). A second window pays that again […] So memory never
  > argued for windows. It argues against them.

Also forbidden inside Mesura Code, both from ADR-001 (`:81-88`):

> - **Do not solve "a window per project" with `XDG_CONFIG_HOME` + `T3CODE_HOME` per
>   project.** It works […] and it is the wrong answer here.
> - **Do not point two instances at one `T3CODE_HOME`.** The server is event sourced
>   […] That corrupts silently rather than failing, so it is worse than the design it
>   appears to rescue.

### D.4 What the plan says about the FILE MANAGER

This is the section that matters most to this repository, and the answer is blunt:
**the plan defers it to next-to-last.**

`docs/t3-migration-execution-plan.md:30`, in the first-usable table:

> | Basic file tree | Existing T3 project tree follows the selected thread worktree;
> the complete Symmetria File Manager remains deferred. |

`:42`, in the deferred table:

> | Complete File Manager | Separate post-cutover project. |

`:160`:

> The complete File Manager remains a separate post-cutover program: `Symmetria File
> Manager #49: [Migration] Move File Manager capabilities behind the shared Symmetria
> server after IDE cutover`.

`:304` — position **9 of 10** in Phase 7's post-usable order, behind artifacts,
editor, browser, coordination, project icons, subscription limits and mobile:

> 9. Complete File Manager server migration.

`:510`:

> Terminal, Git, and the inherited T3 file tree follow the selected thread worktree.

And `:552`, in the R3 Daily Driver gate — the plan explicitly accepts that at
daily-driver stage, file management happens **outside** the product:

> Editor/File Manager work can still happen through external tools.

**Contrast the June pivot, which put the FM FIRST** (`framework-pivot.md:141`):

> 1. **File manager** (Tauri/React, standalone-capable). The IDE's **file tree + git
>    status derive from it** (shared components). Zero nvim-rendering conflict — pure
>    UI, the ideal first move. Recreate the Symmetria look in CSS here; validates the
>    stack on a cheap-to-fail surface.

**And the FM is the reason the Tauri pivot died** (`framework-pivot.md:3`):

> the file-tree + git-status systems are modularized and reused across Symmetria Shell
> + File Manager + IDE; the FM […] stayed native Qt/QML and exposes them as the
> `Symmetria.FileManager.UI` QML module — so the IDE stays QML to **reuse** that
> module rather than reimplement it (DRY).

`tech-stack.md:33`:

> ### 1. QML reuse is free
> The Symmetria File Manager is already QML. Loading it as a child component inside
> the IDE window is trivial. Every other framework (Tauri, Electron, Rust-native)
> would require a rewrite.

**The unresolved tension, stated plainly: the August plan chose Electron and deferred
the File Manager rather than answering the DRY objection that killed Tauri.** The
objection was never rebutted. It was routed around by scoping the FM out of
first-usable.

**Today, in the shipped product, the file manager is an external application you
shell out to.** In `/home/jc/projects/mesura-code` it appears only as a launcher
target: `apps/server/src/process/externalLauncher.ts:226`
(`fileManagerCommandForPlatform`), `apps/web/src/components/CommandPalette.tsx:2115`
("Open in \<file manager\>"), and one contract row in
`packages/contracts/src/editor.ts:66`:

```ts
{ id: "file-manager", label: "File Manager", commands: null, launchStyle: "direct-path" },
```

That is exactly what the plan predicted at `:552`.

**`symmetria-file-manager#49` is where the objection comes due.** Its target
architecture, verbatim:

```
Shared Symmetria/T3 server
├── directory snapshots and watcher registry
├── path search index
├── Git and ignored-path state
├── operation queue and progress
├── semantic file clipboard
├── bookmarks and preferences
├── encoded preview/thumbnail cache
└── Linux integration adapters

Electron project windows
└── lightweight project file tree

Singleton File Manager BrowserWindow
└── full Miller/tree UI created on demand and destroyed on close
```

Its rules, which a port should treat as already-decided constraints:

- Project windows do not start another File Manager process.
- Hiding a `BrowserWindow` is insufficient — closing the full File Manager must
  **destroy** its renderer and associated preview workers.
- Share semantic DTOs and revisioned events, **not** `QModelIndex`, QObject, QML,
  geometry, or renderer state.
- Watcher events are **invalidation hints**. Revision gaps and overflow force a
  directory rescan.
- Large preview bytes use bounded content URLs or file descriptors, **not** JSON
  payloads.
- Linux integration that **may remain native**: GIO, UDisks2 over D-Bus, XDG portals,
  and native/isolated helpers for HEIF, PDF, archives, spreadsheets, thumbnails and
  arbitrary clipboard MIME.
- Planning targets, explicitly **not measurements**: 15–35 MiB incremental server
  core, 8–25 MiB per active root, 5–20 MiB client tree state, **70–130 MiB full File
  Manager renderer**, 35–80 MiB temporary preview worker.
- "This issue does not block the initial IDE cutover."
- "Retire the QML implementation only after desktop, embedded tree, and picker
  parity."

Mesura's own live docs name the FM twice, both times as unpriced future weight
(`adr-002:116`, `:194`):

> - **Per-project cost is ~0 today and will not stay there.** The plan is to bring in
>   the Symmetria File Manager and an editor. Both hold per-project state, so the flat
>   line becomes a slope whose gradient is currently **unmeasured**.
> - **What does a project cost once the File Manager and the editor are inside?**
>   Measure with two projects loaded, then extrapolate. This is the number that
>   decides whether eviction is urgent or merely eventual.

### D.5 What the plan says about the Symmetria design language

**The most important finding here is a negative.**

A term sweep across all 634 lines of `docs/t3-migration-execution-plan.md` finds
**zero** occurrences of `aesthetic`, `visual`, `theme`, `style`, `css`, `look`,
`font`, `color`/`colour`, `palette` or `claymorph`. The six hits for `design` are all
"designs pass review" or "This plan is designed for". The eight hits for `icon` are
all `project-icon-v1` asset descriptors.

**The authoritative execution plan says nothing whatsoever about the Symmetria design
language.** Aesthetics were not scoped, not gated, not deferred, not mentioned.

The June pivot did address it, as an accepted identity loss
(`framework-pivot.md:151`):

> **This is a deliberate product-identity shift.** Two non-negotiables change meaning:
> - **"NeoVim motions are sacred"** → **"vim-style navigation is preserved."**
> - **"Renders in QML for aesthetic continuity"** → **"renders in web; aesthetic
>   continuity is recreated in CSS."** The *look* is reproducible; only the *feel* may
>   differ slightly.

The counter-position, still live for `symmetria-ide` (`tech-stack.md:63` and `:36`):

> - **Against:** 150–250 MB idle baseline […] **Aesthetic drift toward generic web
>   look. Symmetria aesthetic must be re-created in CSS.**
> - ### 2. Aesthetic continuity — Symmetria Shell (QuickShell) and File Manager are
>   QML. The IDE shares the visual grammar without effort.

And the constraint the Electron rejection was measured against
(`docs/identity.md:23`):

> *The beauty in functionality and the functionality of beauty.*
>
> This is a design constraint, not a slogan. […] **Functionality of beauty** —
> aesthetic choices must earn their place. Decoration without purpose is rejected.

**What actually happened: the design language did not survive the move. It was
relocated.**

Mesura Code did not recreate the Symmetria look in CSS. It kept T3 Code's UI and
reskinned only the identity marks.

- `.factory/mesura-code-icon/intent.md` is scoped to application icons and explicitly
  excludes theme work: *"Explicitly out of scope: … Changing the Mesura Code wordmark,
  typography, **UI theme**, package identifiers, schemes, or runtime names."*
- The identity it adopts is **Mesura's corporate palette, not Symmetria's**: *"a
  centered brushed-metal isometric cube on a dark graphite field, with narrow
  terracotta seams"*; *"Preserve Mesura's graphite, cold-metal, and terracotta
  palette."*
- Where the Symmetria grammar survives, it survives **outside** the Electron app —
  in the QuickShell bar (`docs/mesura/shell-bar/intent.md`):

  > **The visual language is not ours to invent.** The bar's existing components render
  > the result. A Mesura pill and an IDE pill must be indistinguishable in typography,
  > spacing and animation, because they are the same components.

`tech-stack.md:63`'s prediction — "aesthetic drift toward generic web look" — is what
occurred, and it was accepted without a written decision reversing that verdict.

The one aesthetic rule that DID carry into the Electron product is a performance rule
(`mesura-code/AGENTS.md:213`):

> This is driven all day, and a dropped frame, a lying spinner and a stale label all
> get noticed. One user rather than a hundred thousand does not lower the bar — it
> removes the excuse that someone else would have reported it. **No continuously
> repainting animations; they peg the GPU on high-refresh displays.**

### D.6 What stage the migration actually reached

| Plan artifact | Actual state |
|---|---|
| The fork (`symmetria-ide-next`) | **exists, renamed Mesura Code** |
| Upstream pin | done — `f708f63fa9bcd7e51f1f62531f6f9ed966b71807` in `.factory/work-items.json` |
| Factory ledger `factory/work-items.json` | done at `.factory/work-items.json`, deliberately **gitignored** |
| Six contract schemas | **done** + JSON Schema emitted + checksum pinned, in `packages/symmetria-broker-contract/` |
| Weekly upstream sync rehearsal | **1 of 2** — `upstream-sync/2026-W34`, merged `ebe6a4dd5`, 29 commits |
| L10 broker producer | **shipped** (`adc393294`) |
| L11 Shell consumer + STT | **shipped** (`7281b313d` dictation, `adc393294` bar) |
| Distribution identity | **shipped** — own state home `~/.mesura-code`, own `userData` |
| Project icons (plan: Phase 7 item 7) | **pulled forward and shipped** (`232e99d5e`) |
| Matrix v0 (issue `#36`, a B0 gate) | **outstanding** |
| L5 window registry / launcher | **abandoned — reversed by ADR-002** |
| Complete File Manager | **not started** — external launcher only |
| CodeMirror editor | **not started** |

**All 20 GitHub issues `#35`–`#54` in `symmetria-ide` are still OPEN**, plus a new
one: `symmetria-ide#58: [Foundation] Pin Node 24 for symmetria-ide-next: Node 26
breaks its install silently and exits 0`. The tracker never caught up with the code —
the inverse of the rule the plan itself wrote at `:435`:

> An issue does not close because code exists. It closes when its acceptance rows and
> evidence pass.

**Three divergences from the plan:**

1. **Windowing.** The plan locked "one `BrowserWindow` per project" (`:80`). ADR-002
   reversed it to one window with all projects, summoned into a Hyprland special
   workspace. The reason was measurement: the plan's own spike, when finally run,
   argued **against** the plan's locked architecture. The 800 MiB / 1.05 GiB PSS gates
   at `:482` are now meaningless — the real number is **415 MB flat, regardless of
   project count**.
2. **The factory.** Nineteen lanes, nine roles, a merge train, nine gates and ten test
   layers were planned. What ran is far lighter: `.factory/` holds four work packets,
   each an `intent.md` plus a `plan.md`, on branches like
   `sdlc-lite/mesura-code-identity`. The intent/plan/verify shape survived; the
   coordinator apparatus did not.
3. **Coexistence.** The plan assumed the QML IDE stays the daily driver through R3.
   The Shell bar work is premised on the opposite (`docs/mesura/shell-bar/intent.md`):
   *"the moment the user moves from the IDE to Mesura the bar goes quiet and the
   machine stops being legible."* The move off QML happened before the soak gates
   existed.

### D.7 Constraints a new port inherits

**Fork discipline** — these dominate everything else, and they override the global
DRY instruction inside a fork (`mesura-code/AGENTS.md`):

1. *"A line changed inside an upstream file is a merge conflict every week, forever. A
   new file of our own is free. Prefer adding beside upstream code over editing it."*
   (`:25`)
2. *"Disabling beats deleting."* (`:26`)
3. *"A refactor that is locally tidier but touches more upstream lines is usually the
   wrong call — including extracting a repeated literal into a shared constant."*
   (`:27`)
4. **Quality decides, merge cost informs** (`:63-85`). The named failure mode:
   *"enumerating the conflict surface of each option, then picking the lowest number.
   That comparison reads as rigour, because the numbers are real and measured. It is
   still the wrong question whenever the options are not equally good."*
5. **Read the conflict surface as an intersection, not a union** (`:35`). First sync:
   104 upstream files, 240 ours, **11 in common, 1 real conflict**.
6. **A guard may not pin a number that is upstream's to change** (`:42`). A guard
   pinning 257 contract tests broke when upstream added one. Assert a floor.
7. **Symmetria-owned code lives in its own package**, composing upstream vocabulary;
   bind a local copy to an upstream type so typecheck fails on divergence
   (`packages/symmetria-broker-contract/src/upstreamLock.ts`).

**Toolchain traps that fail silently:**

8. **Node version is load-bearing and its failure exits 0.** Node 26.7.0 extracts
   548 KB of a 310 MB Electron archive in 0.0 s, writes no `path.txt`, and exits 0.
   Node 24.19.0 extracts 297 MB correctly. `extract-zip 2.0.1`'s promise never settles
   on Node 26. *"An exit code of 0 from `pnpm install` is not evidence that postinstall
   scripts completed."*
9. **Never run bare `pnpm test`** — root `test.maxWorkers` only reaches `apps/server`;
   a full run reached **load 38 with swap exhausted** and had to be killed. Run per
   package with `--max-workers=3`, serially.
10. **Wrong relative `node_modules` depth prints nothing and reads as a pass.**
11. **gitleaks does not scan merge commits** — it reports `0 commits scanned` /
    `no leaks found`, which also reads as a pass.
12. **Never bake origins** — setting `VITE_HTTP_URL` / `VITE_WS_URL` for dev bakes
    localhost into the bundle and silently breaks every remote browser.

**Measurement discipline:**

13. **PSS from `/proc/<pid>/smaps_rollup`, never summed RSS.** *"RSS counts shared
    pages once per process and overstates a multi-process application badly, which is
    the whole quantity in question here."*
14. **`ps -e` overrides `--ppid`** — `ps -eo pid --ppid <pid>` returns every process on
    the machine and the total looks plausible. Use `ps --ppid <pid> -o pid
    --no-headers`.
15. **Chromium renderers report `--type=zygote` in their cmdline.** Classify by mapped
    libraries instead: the GPU process maps `radeonsi`/`libEGL`/`libvulkan`; a renderer
    maps none and carries several anonymous regions above 64 MB for the V8 heap.
16. **A result without a control measurement does not pass.** And the lesson ADR-001
    exists to preserve: *"It compared two candidates against each other and never
    against the architecture already running."*
17. **Baselines to carry:** app fixed cost **224.2 MB PSS** (main 63.6 + bundled node
    server 109.6 + GPU 29.9 + resource monitor 13.2 + network 6.3 + zygotes 1.6);
    **renderer 191.3 MB**; one window with seven projects **415 MB**; per-project
    **≈ 890 bytes**; renderer private pages **196 MB of 233 MB RSS**.

**Identity and addressing — the most repeated lesson in the corpus:**

18. **`threadId` is the whole address — "no process id, no window handle, no pane
    slot."** Three separate documents record the same bug class: a reused PID or pane
    slot delivers a command to the wrong agent. This is why Mesura refused to speak
    the old `agent-bridge.py` `{pid}_{slot}` protocol.
19. **Never resolve identity from current state inside an async pipeline.** Measured on
    Hyprland 0.56.2 over 111 events: **`activewindow` fires 7–10 ms BEFORE `workspace`,
    without exception.** Binding a project switch to `activewindow` reads the OLD
    workspace. *"Intermittent, load-dependent, unreproducible by hand. It is the
    dictation bug again."*
20. **Keep the last event payload as state; do not query at toggle time.** *"The event
    stream is ordered and complete; the `hyprctl` query is verification, not the
    path."*
21. **A one-window architecture breaks any consumer that joins on host-window PID.**
    The Shell bar derives workspace labels by joining agents to workspaces by PID; one
    window means one PID means every project collapsing onto one label. **The binding
    must be published, not inferred.**

**Contract and wire rules:**

22. **Effect Schema is the single source of truth; JSON Schema is generated and never
    hand-edited.** The suite rebuilds each document in memory and compares byte for
    byte, so a hand edit fails rather than surviving.
23. **The projection is an allowlist, and a privacy fixture proves it.**
24. **Pin the contract by checksum, not by branch** — SHA-256 over every emitted
    document in ascending path order.
25. **Record a cross-repository integration tuple**, not just a version.
26. **Adversarial fixtures are part of the deliverable**: unknown fields, unsupported
    major, missing required values, duplicates, reordered events.
27. **The publisher belongs in the always-local, always-one-per-machine process.** The
    server also runs over SSH, inside WSL and in the cloud; a remote server has no
    business writing a socket on this machine.
28. **The consumer must not need the fork's auth.**

**Data safety:**

29. **Never kill by pattern.** No `pkill -f`, no `pgrep | kill` — the agent's own
    process carries the worktree path in its argv.
30. **Two live installs exist on this machine and neither belongs to a working agent:**
    `~/.mesura-code/userdata` and `~/.t3/userdata`. Read and copy from either; never
    start a server against either.
31. **Snapshot SQLite with `VACUUM INTO`.** A plain `cp` is only safe with no server
    attached and must bring `-wal` and `-shm`. **A live file copy is a corrupt copy.**
32. **Copy in, never symlink. Data flows one way: into the sandbox, never back out.**
33. **An empty database is a bad test.**
34. **No candidate action may mutate QML-owned state or resources** — it is an
    automatic rollback trigger (`:518`, `:525`).

**Product and scope discipline:**

35. **Complexity belongs at the adapter boundary. Orchestration stays pure. UI stays
    dumb.**
36. **Hit every surface.** The most common defect is a change that works on the tested
    path and is missing everywhere else — entry points, clients, providers, contracts,
    and **reverse states**: *"Snooze needs unsnooze. Close needs reopen. A one-way door
    is a bug."*
37. **Two surfaces must be correct: desktop on Linux and mobile on Android.**
38. **Never rebrand upstream's legal surfaces.**
39. **Wait on receipts and worker drains, never on sleeps or polling. A test that needs
    a timeout to pass is wrong.**
40. **Do not commit implementation plans or agent scratch files.** *"A merged PR is the
    implementation record."*
41. **Eviction is the real price of one-window-many-projects.** Separate processes give
    reclamation away free; one process must write idle projects out and restore them
    convincingly.
42. **Test isolation is a hard boundary on this machine:** routine tests must not touch
    real accounts, transcripts, tmux sessions, microphones, browser profiles, **or the
    live Hyprland desktop**.

### D.8 Two open contradictions this dossier must resolve

1. **Electron was rejected in June and adopted in August with no written reversal.**
   `docs/tech-stack.md:63` — "rejected. Contradicts *beauty in functionality*" — has
   never been amended. Someone must either write the reversal or accept that the
   aesthetic verdict silently lapsed.
2. **The DRY objection that killed Tauri was never rebutted for Electron.**
   `framework-pivot.md:3` and `tech-stack.md:34` both say a web IDE cannot reuse
   `Symmetria.FileManager.UI` and must reimplement it. The August plan answers this
   only by deferring the File Manager to post-cutover position 9 of 10 and accepting
   external tools at R3. **The objection is still live, and this repository is where
   it comes due.**

---

## Part E — file-tree mount performance

`/home/jc/projects/symmetria-ide/docs/file-tree-mount-optimization.md`, 532 lines. It
is a cross-session resume log, not a design spec: shipped work, measured numbers,
rejected experiments, and thirteen gotchas.

**One naming correction.** `src/symmetria_ide/mount_manager.py` is NOT this document's
implementation. That module is the SSHFS mount lifecycle for the VPS remote location.
The word "mount" collides, nothing else. The real implementation is
`tree_state_cache.py`, `state_paths.py`, `fs_atomic.py`, `git_controller.py`
(`_run_ignored_set` / `ignoredPathSet`), `qml/Main.qml`, and — in this repository —
`FileTreeView.qml`, `handlers/TreeModel.js` and `services/Gitignore.qml`.

### E.1 The problem

The IDE's side panel mounted its tree with `initialExpandDepth: -1`, capped at
`maxExpandDepth: 8`. Two costs compounded.

1. **One `git check-ignore --stdin` subprocess per expanded directory, strictly
   sequential.** `Gitignore.qml:54-68` serialises everything through one
   `ShellRunner`; `_drain()` refuses to start a job while `_active !== null`. Cost is
   quoted repeatedly as **~30–40 ms per directory**.
2. **One `FileSystemModel` plus one `QFileSystemWatcher` per expanded directory.** The
   eager cascade cap-tripped at `MODEL_CEILING = 100` on medium repos, and the payoff
   was about 30 user-visible rows.

On `~/work/sales/bambin` (~2200 files, ~480 dirs) the tree took **3994 ms** from
"Session started" to "tree mount settled", producing **291 rows** — of which a
1280×720 sidebar at `compactScale 0.8` shows about 49.

### E.2 The headline table (verbatim, `docs/file-tree-mount-optimization.md:47`)

```
| Repo | Pre-option 1 | Post-option 1 | Post-option 4 | Reduction (full) |
|------|-------------|---------------|---------------|------------------|
| ~/work/sales/bambin (~2200 files, ~480 dirs) | 3994ms | 2303ms | 449ms | 89% (8.9× speedup) |
| ~/projects/symmetria-ide (small)             | <1ms*  |  548ms | 442ms | — |
| ~/.dotfiles (small)                          | <1ms*  |  449ms | 479ms | flat |

* Baseline for the small repos was measuring the Active Changes panel
(filtered, settles instantly) before the GitController-wake fix landed.
Post-fix, both panels mount and the bench measures the slower of the two —
hence the "regression" that's actually a more honest number.
```

`:58`:

> The 449ms remaining on bambin is dominated by **nvim spawn + first git scan + Logger
> 500ms flush window** — file-tree work is no longer the bottleneck. The cascade now
> expands exactly 3 directories to fill the side panel viewport (49 visible rows on a
> 1280x720 launch at compactScale 0.8) instead of cap-tripping at 100 directories.

The raw bench JSON in `/home/jc/projects/symmetria-ide/bench/` confirms every cell and
adds intermediate runs the document omits:

| Bench file | bambin | symmetria-ide | .dotfiles | bambin rows |
|---|---:|---:|---:|---:|
| `results-baseline.json` | **3994 ms** | 0.0 | 0.0 | 291 |
| `results-opt1.json` | 1872 ms | 2913 ms (**926 rows**) | 0.0 | 291 |
| `results-opt1-fixed.json` | **2303 ms** | 548 ms | 449 ms | 290–295 |
| `results-opt4.json` | **449 ms** | 442 ms | 479 ms | **49** |
| `results.json` (option-6 era, warm) | 801 ms | — | — | 49 |

**The row-count collapse is the real evidence**: bambin **291 → 49**, symmetria-ide
**121 → 53**, `.dotfiles` unchanged at 35 (it fits the viewport either way, which is
why its number is flat).

### E.3 Option 1 — the IDE-side ignored-set short-circuit (shipped)

One `git ls-files --others --ignored --exclude-standard --directory -z` per status
scan, published as a `{absPath: True}` map. The FM's `FileTreeView` gained a matching
`ignoredPathSet` property; when set, it does an O(1) membership test instead of
spawning a subprocess. **`--directory` is the load-bearing flag** — it collapses a
wholly-ignored subtree into one entry instead of enumerating every child.

**Measured: bambin 3994 → 2303 ms, 42% off.**

**A critical bug shipped with it** (`:32`):

> `AppController.start()` now emits `displayedRootChanged` once at startup. Without
> that emit, the first nvim cwd capsule matched `self._cwd` (both initialized from
> `os.getcwd()`), short-circuited `_route_capsule`, and `_sync_git_repo_root` never
> ran — leaving both the Active Changes panel AND the gitignore short-circuit silently
> broken whenever the IDE was launched in its own cwd.

The `None`-versus-`{}` contract is stated in Part B.14 above and is the subtlest part
of this option.

### E.4 Option 4 — viewport-driven lazy expand (shipped)

A `lazyExpand: bool` property replaces the recursive BFS cascade: expand root → check
whether rendered rows cover the viewport plus a buffer → if not, expand the **first
un-expanded directory in row order** → re-check. Scroll, viewport resize and
`compactScale` change all re-arm the cycle.

**Measured: bambin 2303 → 449 ms. Cumulative 3994 → 449 ms = 89%, 8.9×. Rows 291 →
49.**

**The shipped code deliberately deviates from the written design on one point.**
`shouldExpandMore` does NOT use `view.contentHeight`
(`handlers/TreeModel.js:656`):

> Returns true when the rendered tree has fewer rows below the visible viewport bottom
> than `_lazyExpandBufferRows`. Synchronous on `_rows` length + cached row height —
> does NOT depend on `view.contentHeight`, which lags `_rows` mutations by a layout
> cycle.

The rationale for lazy over eager, at `TreeModel.js:515`:

> the cascade instantiates one FileSystemModel + QFileSystemWatcher per expanded
> directory — on medium-to-large repos (bambin: ~480 dirs) it cap-trips at
> MODEL_CEILING (100 dirs) whose visible-row payoff is small (~30 rows fit in the IDE
> sidebar). Lazy expand follows the user's attention instead of fanning out blindly.

**Guardrails stay module constants, not properties** (`TreeModel.js:21-41`):
`FANOUT_CAP = 200`, `MODEL_CEILING = 100`, `NODE_CEILING = 10000`,
`SKIP_NAMES = {".git"}`, `LAZY_BUFFER_ROWS = 8`. They are failure-mode protection, not
configuration, so a caller cannot raise them and rediscover the failure mode. Each
logs once when hit.

### E.5 Option 6 — the per-project expanded-state cache (shipped 2026-05-25)

Restore semantics, verbatim (`:282`):

> 1. `onRootPathChanged` skips the lazyExpand/BFS cascade.
> 2. Paths filtered to those under `rootPath` and sorted shortest-first.
> 3. `_expand(rootPath)` runs first; its finish callback dispatches
>    `_advanceRestoreFor(rootPath)` which scans the queue for any direct children and
>    expands them.
> 4. Each child's finish callback recurses — natural depth-first replay driven by the
>    existing async machinery, no new chain layer. `_generation` invalidates in-flight
>    steps if rootPath changes mid-restore.
> 5. `_restoreActive` clears when the queue drains […]
> 6. `expandedStateChanged` is suppressed during restore to avoid churning the
>    consumer's disk-write path while replaying the already-saved set.

Measured (`:299`, symmetria-ide, 5 runs each):

| Scenario | median | Notes |
|---|---:|---|
| No cache (lazyExpand) | 608 ms | 42 rows, 5 dirs |
| Warm cache, same set as lazy would produce | 615 ms | restore replaces lazyExpand |
| Warm cache, deep set (14 dirs) | 949 ms | 117 rows, replays the user's exploration |

> The flat wall-clock numbers (608/615) confirm: when the cache contains exactly the
> set lazyExpand would produce, the two paths are equivalent-cost. The deep-set timing
> (949ms) is purely additive — more work because more dirs are expanded. **That
> additional cost IS the win.**
>
> **Felt-UX value (not bench-visible).** The benchmark synthesizes a cold mount on a
> clean repo. The real user workflow is: open project → explore → close IDE → re-open
> the next day.

Those three option-6 runs were **not saved to disk** — treat 608/615/949 as
doc-only, unverifiable from artifacts.

Note also the **second-pass rescue** at `TreeModel.js:601`: if the saved set skips an
intermediate level (`["/a/b", "/a/b/c/d"]` with no `/a/b/c`), the deeper path must
still be dispatched once any expanded ancestor exists, or it is silently abandoned.
That case arises from stat-pruning and from schema evolution. And the suppression
guard covers **both** `_restoreActive` and `_mountInFlight` — the second matters
equally, because a 100-directory lazy cascade would otherwise churn the disk with
partial sets.

### E.6 Option 8 — the launch waterfall (shipped, diagnostic only)

A `SYMMETRIA_IDE_TRACE`-gated phase tracer (`src/symmetria_ide/trace.py`, 77 lines)
writing `[TRACE] <ms_from_process_start> <phase>` to stderr, with `T0` captured at
module import before PySide6 loads. Median of 15 runs (`:70`):

| Phase | Cumulative ms | Δ |
|---|---:|---:|
| `imports_basic_done` | 5 | — |
| `app_module_imported` (PySide6 + pynvim + submodules) | 148 | +143 |
| `qgui_created` | 165 | +17 |
| `engine_ctx_ready` (= `controller_created` in the code) | 170 | +5 |
| `engine_loaded` (Main.qml parsed + instantiated) | 270 | +100 |
| `backend_started` (nvim subprocess up) | 280 | +10 |
| `terminal_started` (PTY + pyte) | 292 | +12 |
| `exec_entered` (Qt event loop running) | 310 | +18 |
| `first_capsule` | 316 | +6 |
| `git_ignored_published` | 325 | +9 |
| FM "tree mount settled" (bambin) | ~896 | **+571** |

Findings (`:86`):

- The 148 ms Python import cost is dominated by PySide6 itself. Lazy-importing the
  `@QmlElement`-decorated classes breaks the registration contract, so they must stay
  eager.
- The 100 ms `engine_loaded` slice is `engine.load(Main.qml)` on the **already-cached**
  path (`~/.cache/Symmetria/Symmetria IDE/qmlcache/*.qmlc` is hot).
- The `controller.start()` → `exec_entered` slice is dominated by `gc.collect()` +
  `gc.freeze()`. *"These are load-bearing for the 3.14 SEGV mitigation; do not delete
  the `collect` 'for speed'."*
- `git_ignored_published` lands **~570 ms before** the tree settles, so nothing
  currently races the git worker.

Conclusion (`:367`):

> **there is no big-bang fix here.** The 400ms pre-`Session-started` window is mostly
> fixed Qt/Python/PySide6 overhead. `nvim --embed` itself is fast […] The waterfall
> table in the Status section above is the authoritative breakdown.

### E.7 Tried and rejected

**The one experiment implemented and backed out — deferring `AgentPane` behind a
`Loader`** (`:107`):

> Saved ~12-25ms in `engine_loaded` but regressed bambin's `tree_mount_ms` by
> 60-120ms (smaller repos were neutral). Hypothesis: removing AgentPane from the
> eager-evaluation graph reshuffles the QML engine's first-frame scheduling in a way
> that contends with the FM's incremental row-fan-out.

The bench artifacts confirm the magnitude: bambin 571 ms baseline → 692 ms → 635 ms →
610 ms after revert. A permanent regression note guards it at `qml/Main.qml:1634`,
ending: *"Reproduce with `bench/measure_mount.py --trace` before attempting another
defer pass — and verify on bambin, not just small repos."*

**Option 2 — BFS-level gitignore batching. Deferred, then obsoleted** (`:151`):

> Option 2 (BFS-level gitignore batching) is now mostly a standalone-FM win — the IDE
> already short-circuits via `ignoredPathSet`.

It survives only as work for THIS repository, which has no `GitController`.

**Option 3 — a shared `FileSystemModel` cache across both trees. Deferred, and the
reason is the most transferable judgement in the document** (`:154`):

> Option 3 […] is real but smaller — halves inotify usage and dedupes some scans, but
> **the dominant cost is the number of `_expand` calls, not their per-call overhead.**
> Option 4 attacks the dominant cost directly: fewer `_expand` calls.

**Option 5 — inotify watcher consolidation. Deferred as premature**: real benefit only
when hitting `fs.inotify.max_user_watches` (8192 default), which bambin does not.

**Option 7 — earlier `GitController` pre-warm. Not done**, and the option-8 trace
largely deflated it: the worker publishes ~570 ms before the tree settles.

**Everything remaining in the pre-`Session-started` window, rejected** (`:376`):

> - Native QML compilation via `qmlcachegen --resource` […] (might shave engine_loaded
>   but adds build step).
> - Splitting `app.py` […]
> - Skipping `gc.collect()` before `gc.freeze()` (~15ms) — **DANGEROUS**.
>
> None are worth doing without a specific user-visible launch complaint pointing at
> them.

### E.8 Conclusions

1. **The file tree is no longer the bottleneck.** 3994 → 449 ms, 89%, 8.9×.
2. **The remaining ~400 ms is fixed framework cost** — 148 ms PySide6 import, 100 ms
   `engine.load`, ~100 ms `start()` → `exec_entered` dominated by a deliberate
   `gc.collect()` + `gc.freeze()` that must not be removed.
3. **Option 6's win is felt, not measured.** The benchmark cannot express it.
4. **Do not micro-optimise instantiation without benching the dominant repo.** The
   `AgentPane` Loader looked like a win on the phase it targeted and was a net loss end
   to end.
5. **Trust the noise floor** (gotcha 13): bambin is ±100 ms run to run; treat anything
   under **50 ms** as noise. Small repos ~30 ms. Always run 5+ and use the trimmed
   median.
6. **Known v1 debt, deliberately unfixed:** multi-window last-write-wins on the cache
   file (atomic write prevents corruption, not lost updates), and restore-path display
   order.

### E.9 The gotchas that generalise beyond Qt

1. **`displayedRootChanged` must fire at `start()`** — a value initialised from
   `os.getcwd()` matches the first capsule, so the equality gate silences the signal.
2. **`loadingChanged` fires BEFORE `applyChanges`** — handlers see empty entries.
   Fixed with `Qt.callLater`. Do not make it synchronous.
3. **Empty directories never fire `entriesChanged`** — the C++ `applyChanges` only
   emits on adds or removes. Fixed by ALSO connecting `loadingChanged`, which always
   fires once per scan. Without it, empty directories leak their pending entry forever
   and the mount never settles.
4. **`Qt.callLater` callbacks can outlive their model object** — every destroy site
   must disconnect first.
5. **`ignoredPathSet` returns `None`, not `{}`**, before the first scan.
6. **`set_repo_root` clears the ignored set synchronously** so the fallback gate
   re-fires on project switches, not just at launch.
7. **The bench polls the log file rather than using screenshot mode** — the screenshot
   path calls `app.quit()` at a fixed deadline that races the Logger's async flush.
8. **The installed FM beats `QML2_IMPORT_PATH`** — must prepend via
   `engine.setImportPathList([dev, *engine.importPathList()])`.
9. **QML typed parameters do not support default values in Qt 6.11.**
10. **`Array.isArray(qVariantList)` returns false.**
11. **Pre-populate anything keyed on a signal in `__init__`**, in the fixed order:
    connect the slot, then call it manually once. QML mounts the consumer at
    `engine.load()`, before the synthetic emit.
12. **Noise floor**, as above.

### E.10 What transfers to Electron and TypeScript

The renderer holds the tree, the Node main process holds the filesystem, IPC sits
between. The Qt specifics fall away; the architecture does not.

**The two structural wins, in order:**

1. **Batch the ignore computation in main and ship one set to the renderer.** One
   `git ls-files --others --ignored --exclude-standard --directory -z` per status
   scan. Never per-directory `check-ignore`, and never one child process per expanded
   folder — Node's `child_process.spawn` costs **more** per spawn than Qt's
   `ShellRunner`, so the penalty is worse, not better. Keep `--directory`: it collapses
   `node_modules/` into one entry instead of 40 000.

   **Ship it as `Set<string> | null`, never a `Set` initialised empty.** `null` means
   "not computed yet, use the fallback"; empty means "nothing is ignored". Conflating
   them makes the renderer expand `node_modules` before the first scan lands.
   TypeScript can enforce this at the type level, unlike the Python/QML truthiness
   dance. Marshalling note: a `Set` survives `structuredClone` over Electron IPC; a
   class instance does not.

2. **Lazy, viewport-driven expansion, not depth-limited eager expansion.** Worth
   another 5×. The insight is that **the dominant cost is the number of expansion
   units, not the cost of each one**, so batching or caching per-unit work attacks the
   wrong term.

   Two implementation notes carry over verbatim. **Compute the fill condition from row
   count × fixed row height, not from measured DOM height** — `scrollHeight` and a
   virtualizer's `getTotalSize()` lag your `rows` state exactly as `contentHeight` lags
   `_rows`. Use `rows.length - Math.ceil((scrollTop + clientHeight) / ROW_HEIGHT) <
   BUFFER_ROWS`, with `BUFFER_ROWS = 8`. And **re-arm on scroll, on container resize,
   and on any density or zoom change** — their three triggers map to a scroll handler,
   a `ResizeObserver`, and the font-size setting.

   The side effect matters as much as the latency: lazy expansion caps the number of
   live watchers. Node hits the same `fs.inotify.max_user_watches` budget with
   `fs.watch` per directory. Lazy expansion made option 5 unnecessary; reach for a
   single recursive `chokidar` watch only when you can prove exhaustion.

**The IPC-shaped hazards:**

3. **Always reply, even with an empty result.** Their nastiest correctness bug —
   empty directories emitting no change event, so the pending entry leaked and the
   tree never settled — is, in IPC terms, **treating "data arrived" as the completion
   condition**. Every `readdir` request must resolve exactly once, including with
   `[]`. `ipcRenderer.invoke` plus one promise per directory gives this for free.
4. **Deliver data in the payload, never as "go read the property now".** Two of the
   three worst bugs are this one mistake in different clothes. In React the analogue is
   two `useEffect`s on two separate props, or two `dispatch` calls landing in different
   commits. **Send `{root, expandedPaths}` as one message and apply both in one
   synchronous handler.** And note the property that made their version so hard to
   find: it reproduced only on a CLEAN working tree, because a dirty tree mounted an
   extra panel whose instantiation cost accidentally reordered the two updates.
5. **Generation counters on every async result.** Every in-flight read carries the
   generation stamp of the root it was issued under and is discarded if the root
   changed.
6. **Coalesce duplicate invalidations.** `Qt.callLater` both defers past the
   data-application boundary and deduplicates two signals in one tick. The web
   equivalent is a microtask or `requestAnimationFrame` with an already-scheduled flag.

**Persistence:**

7. **Persist expanded state per project root; restore ancestor-first.** Key the file by
   a truncated SHA-256 of the absolute root path, not by a sanitised path. Sort the
   restore queue shortest-first. Drive the replay through the EXISTING async expansion
   machinery rather than a second chain. Include the second-pass rescue for saved sets
   that skip a level.
8. **Suppress the save signal during replay** — and during the initial cascade too.
   This is the classic controlled-input feedback loop; in Redux terms the restore
   action must not be observable by the persistence middleware.
9. **Atomic write, tolerant read, stat-prune.** Write the temp file **in the same
   directory** as the target, then rename — `fs.rename` is atomic within one filesystem
   only, so the default temp directory is wrong. Every load failure returns "no cache"
   rather than throwing; validate with a schema and version-gate forward. Prune paths
   that no longer exist. **Empty is a valid saved value** — "collapsed everything" and
   "never opened" are different states. Their acknowledged v1 gap applies harder in
   Electron, where multiple windows on one project are normal: either scope the write
   to a single owner in the main process, or take a lock.

**Measurement discipline:**

10. **Emit one deterministic "settled" marker and measure to it**, carrying the row
    count and the expansion count — those two numbers are what explain a latency change
    (291 → 49 rows is the whole option-4 story).
11. **Beware measuring the wrong component.** Their small-repo baseline was really the
    fast filtered panel settling, so the honest post-fix number looked like a 500×
    regression.
12. **Bench the worst repo, run ≥5 times, use a trimmed median, and fix the noise
    threshold before you start.** Electron will be noisier than Qt, not less — V8 JIT
    warmup, GC and the compositor all add variance.
13. **Instrument the startup waterfall with a cheap env-gated tracer, permanently.**
    The payoff is the NEGATIVE result: knowing that ~400 ms is irreducible framework
    cost so you stop attacking it.
14. **Expect your fixed cost to dominate, and expect deferral to disappoint.** Their
    148 ms Python import plus 100 ms QML parse maps onto Electron's Chromium/Node boot
    plus bundle parse plus first React render — with a **higher** floor. `React.lazy` on
    a big sibling panel is exactly the `AgentPane` experiment that came out net
    negative. Measure end to end on the large repo before keeping such a change, and
    leave a regression note in the code when you revert one.

**Two smaller things worth stealing:**

15. **Guardrails as module constants, not configuration.** Next to the logic that
    enforces them, each logging once when hit, none exposed as a setting — precisely so
    a caller cannot raise them and rediscover the failure mode.
16. **A duck-typed membership map beats a specialised structure at the boundary.**
    `pathFilter` is deliberately not git-specific, so search results, tag views and
    fuzzy previews all reuse it. One hard rule: **the consumer folds in every
    ancestor**, because the tree does not compute ancestor closure — that keeps the
    per-row gate O(1). Same contract applies to a `Set<string>` in TypeScript.
