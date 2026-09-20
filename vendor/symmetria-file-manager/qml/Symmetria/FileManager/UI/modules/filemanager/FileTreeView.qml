pragma ComponentBehavior: Bound

// FileTreeView — recursive expandable directory tree.
//
// Reuses the C++ FileSystemModel by instantiating one model per expanded
// directory (lazy, on-first-expand). Each model's QFileSystemWatcher gives
// us live disk-change updates without a separate watcher layer.
//
// Two consumer surfaces:
//   1. Standalone FM via Ctrl-E in FileManager.qml's Loader swap.
//   2. Symmetria-IDE sidebar via `import Symmetria.FileManager.UI as FmUi`.
//
// Auto-expand (mount-only): `initialExpandDepth` controls how many directory
// levels are expanded automatically when the tree mounts or rootPath changes.
// 0 = collapsed (default), N>0 = N levels, -1 = recursive (capped by
// `maxExpandDepth`). After mount, expansion is fully user-controlled —
// unrelated prop changes (theme, width, respectGitignore toggle) do NOT
// re-trigger auto-expand.
//
// Guardrails are intentionally NOT props — they're failure-mode protection, not
// configuration (skip .git, skip huge dirs, cap instantiated models + total
// rows). The values and rationale live in TreeModel.js; each hit emits one
// Logger.info so we can diagnose without exposing knobs.
//
// File operations (delete/rename/create/yank/cut/paste/multi-select + chords)
// are dispatched through the shared FileOpsHandler/ChordHandler and require a
// non-null `windowState` — embedded consumers without one (IDE sidebar) stay
// navigation-only. Paste/create target the hovered directory itself, or the
// hovered file's parent (see fileOpsTargetDir).
//
// Out of scope for v1: drag-drop, right-click menu, persistent expansion
// across restarts (the expandedPaths prop is reserved for v2).
//
// IMPLEMENTATION NOTE: the expansion state machine lives in TreeModel.js, the
// keyboard dispatcher in TreeKeyHandler.js, the row delegate in FileTreeRow.qml.
// Those JS handlers reach this file's singletons, component ids (view,
// fsModelComponent, gitignoreSvc, ggTimer) and sibling handlers through this
// file's import scope — same mechanism TreeFlashHandler.js uses for FlashLogic.

import Symmetria.FileManager.UI
import Symmetria.FileManager.Models
// FlashLogic + TreeFlashHandler are imported here purely so the JS handlers
// (TreeModel.js, TreeKeyHandler.js) can resolve them through this file's scope.
// They are not referenced by this file's QML directly, so qmllint's
// unused-imports check is disabled for these two lines.
import "FlashLogic.js" as FlashLogic // qmllint disable unused-imports
import "handlers/TreeFlashHandler.js" as TreeFlashHandler // qmllint disable unused-imports
import "handlers/TreeModel.js" as TreeModel
import "handlers/TreeKeyHandler.js" as TreeKeyHandler
import "handlers/SearchHandler.js" as SearchHandler
// KeyRegistry (the shared dispatch table) and ChordHandler are reached by
// TreeKeyHandler.js through this file's scope at runtime (same cross-JS mechanism
// as TreeFlashHandler above) — the linter cannot see that and reports them
// unused. KeyRegistry's tree run-bodies likewise reach TreeModel /
// TreeFlashHandler back through this scope.
import "handlers/KeyRegistry.js" as KeyRegistry // qmllint disable unused-imports
import "handlers/ChordHandler.js" as ChordHandler // qmllint disable unused-imports
import QtQuick
import QtQuick.Controls

Item {
    id: root

    required property string rootPath

    property bool showHidden: false
    property bool respectGitignore: true
    property var expandedPaths: []
    property WindowState windowState: null

    // Auto-expand on mount or rootPath change.
    //   0  = collapsed (default — preserves all existing callers)
    //   N>0 = expand N levels below root
    //   -1 = expand recursively, capped by `maxExpandDepth`
    // Mount-only — after the initial expansion phase settles, expansion is
    // fully user-controlled. Re-triggers only on rootPath change.
    // Ignored when `lazyExpand` is true.
    property int initialExpandDepth: 0

    // Hard cap when `initialExpandDepth: -1`. 8 covers realistic repo nesting;
    // deeper than that the row indentation is unreadable anyway. Exposed as a
    // prop so consumers with deeper projects can tune it.
    property int maxExpandDepth: 8

    // Viewport-driven (lazy) auto-expand. When true, `initialExpandDepth` is
    // ignored: the mount expands one un-expanded directory at a time until the
    // rendered rows cover the viewport (plus an overscroll buffer); scrolling
    // near the tail, viewport-height and compactScale changes expand one more.
    // Rationale for lazy vs the eager BFS cascade lives at
    // TreeModel.advanceLazyExpand.
    property bool lazyExpand: false

    // Optional restore-on-mount expanded-path list. A non-empty list of
    // absolute paths REPLACES the mount cascade with an ancestor-first replay
    // restoring a previous session's tree shape; paths not under `rootPath`
    // are silently skipped (a stale cache must not blow up the mount).
    // Overrides `lazyExpand`/`initialExpandDepth` for THIS mount only;
    // `lazyExpand` re-arms on the next scroll. Replay mechanics live in
    // TreeModel.beginMount / advanceRestoreFor.
    property var restoreExpandedPaths: null

    // Optional per-row badge data source — duck-typed so the FM stays
    // git-agnostic. Consumers (e.g. Symmetria-IDE) supply `statusForPath(path)
    // -> {char, color, textColor?, tooltip?, adds?, dels?}` or null, plus a
    // `statusChanged()` signal. The provider answers for files AND directories
    // (aggregate status, so active subtrees read at a glance); adds/dels ≥ 1
    // render as a `+N -M` accessory. null (default) = no badges, zero overhead.
    property var statusProvider: null

    // Optional `{absPath: true, ...}` map of pre-computed ignored entries (e.g.
    // the IDE computing the whole repo in one `git ls-files` pass). When set,
    // the per-expanded-directory `git check-ignore` subprocess via Gitignore.qml
    // (~30–40ms each, serialised — the dominant mount-time cost on medium
    // repos) is short-circuited entirely. Wins over `respectGitignore` when
    // both are set; consumers reassign the prop when their set changes.
    property var ignoredPathSet: null

    // Optional `{absPath: true, ...}` membership filter — not git-specific
    // (search results, tag views, fuzzy previews all reuse it). Rows NOT in
    // the map are hidden and auto-expand skips absent directories. The map
    // MUST include rootPath, every visible leaf AND every ancestor between —
    // the FM does NOT compute ancestor closure (keeps the gate O(1) per row);
    // consumers fold ancestors in at build time.
    property var pathFilter: null

    // Density multiplier applied to every size in the row delegate (row height,
    // indent, icon dimensions, font sizes, padding, spacing). Default 1.0 is the
    // standalone FM look; an IDE-style high-density sidebar passes ~0.6–0.75 to
    // fit more rows. Single multiplier on purpose — keeps ratios intact (Material
    // 3 "density"); below ~0.5 risks illegible fonts.
    property real compactScale: 1.0

    readonly property int indentPixels: Math.round(16 * compactScale)
    readonly property var currentRow: (view.currentIndex >= 0 && view.currentIndex < _rows.length) ? _rows[view.currentIndex] : null
    readonly property var currentEntry: currentRow ? currentRow.entry : null
    readonly property int fileCount: _rows.length

    // Keep WindowState's image-chord gate (the ci row) reconciled to this
    // view's cursor. Three triggers are needed: cursor moves (onCurrentEntry),
    // tab switch rebinds windowState (onWindowState — each tab's gate defaults
    // false), and creation when toggling into the tree (Component.onCompleted —
    // onCurrentEntryChanged does NOT fire for the initial value). No-op for the
    // windowState-less embedded tree (IDE sidebar), which has no chords.
    onCurrentEntryChanged: if (windowState) windowState.syncImageCursor(currentEntry)
    onWindowStateChanged: if (windowState) windowState.syncImageCursor(currentEntry)
    Component.onCompleted: if (windowState) windowState.syncImageCursor(currentEntry)

    // Positional props for RenamePopup — same contract MillerColumns exposes.
    // Y of the bottom edge of the current row, relative to FileTreeView root.
    readonly property real currentItemBottomY: {
        if (view.currentIndex < 0 || _rows.length === 0) return 0;
        const rowHeight = Config.fileManager.sizes.itemHeight * compactScale;
        const itemY = view.currentIndex * rowHeight - view.contentY;
        return view.y + itemY + rowHeight + FmTheme.padding.sm;
    }
    // The tree is a single full-width column.
    readonly property real currentColumnX: 0
    readonly property real currentColumnWidth: width

    property var _models: ({})
    property var _expanded: ({})
    property var _ignored: ({})
    // Path-keyed onChange handler functions, used by TreeModel.destroyModel to
    // disconnect entriesChanged/loadingChanged before destroying a
    // FileSystemModel. Keyed on path (not stashed on the model object) because
    // Bound-mode strict properties reject dynamic JS props on C++ QObjects —
    // full rationale at the stash site in TreeModel.expand.
    property var _modelHandlers: ({})
    property var _rows: []
    property int _generation: 0
    property bool _pendingG: false
    property var _pending: ({})
    property bool _loading: false
    // Cursor position captured when `/` is pressed; restored on Escape.
    property int _preSearchIndex: 0
    // Cursor position captured when `S` is pressed; restored on Escape/Backspace-on-empty.
    property int _preFlashIndex: 0
    // Set by the fuzzy-finder via WindowState.fuzzyFinderNavigated — consumed
    // by _rebuildRows once the new rootPath's children land, so the cursor
    // ends up on the file the user picked rather than at row 0.
    property string _pendingFocusName: ""

    // Auto-expand guardrails (failure-mode protection) — the constant values and
    // their rationale live in TreeModel.js (FANOUT_CAP / MODEL_CEILING /
    // NODE_CEILING / SKIP_NAMES / LAZY_BUFFER_ROWS), next to the fan-out logic
    // that enforces them. The mutable per-mount state below stays here because
    // it is reset on every mount and read by the pathFilter re-arm handler.

    // True between the initial _expand(rootPath) and the last pending model
    // settling. Gates the recursive fan-out so manual expansion after mount
    // doesn't trigger further auto-expansion.
    property bool _autoExpandActive: false
    // Independent gate for the lazyExpand cycle (mutually exclusive with
    // `_autoExpandActive` per mount — lazy walks `_rows`, not the BFS fan-out).
    // Set at mount AND on scroll-driven re-trigger; cleared in
    // TreeModel.advanceLazyExpand when the viewport fills or candidates run out.
    property bool _lazyExpandActive: false
    // Diagnostic count of lazy-expanded dirs, dumped in `tree mount settled`.
    property int _lazyExpandCount: 0

    // Restore-cycle state (mutually exclusive with _autoExpandActive and
    // _lazyExpandActive per mount).
    // Queue of paths still waiting to be expanded during a restore cycle.
    // Populated from `restoreExpandedPaths` at mount time; drained as
    // parent models settle (see `_advanceRestoreFor` in the _expand finish
    // callback).
    property var _restorePending: []
    // True between the restore-start and the moment `_restorePending` drains.
    property bool _restoreActive: false

    // True between rootPath assignment and the first time _pending drains to
    // empty. Independent of _autoExpandActive so the terminal "tree mount
    // settled" Logger emission still fires when a guardrail tripped early (the
    // ceiling flips _autoExpandActive false before the last model resolves).
    property bool _mountInFlight: false
    property int _autoExpandTargetDepth: 0
    // childPath -> number of fan-out rounds from rootPath to reach it.
    // Carries the depth through the async expansion hop since _expand()
    // doesn't take a depth parameter (changing its signature would affect
    // the unrelated _toggle() callers). rootPath has no entry (implicit 0).
    property var _autoExpandPending: ({})
    // One-shot guards so the same diagnostic doesn't spam the log if the
    // tree mounts repeatedly within a session.
    property bool _autoExpandCeilingLogged: false
    property bool _autoExpandFanoutLogged: false
    property bool _autoExpandModelCeilingLogged: false

    // Monotonic counter incremented when statusProvider.statusChanged() fires.
    // Each row delegate's badge binding reads this as a fake dependency, so
    // bumping it triggers re-evaluation of every visible row's status lookup
    // in a single pass — no per-delegate Connections object required.
    property int _statusVersion: 0

    signal fileActivated(string path)
    signal directoryChanged(string path)
    signal showHiddenToggleRequested()
    // Emitted after every user-driven mutation of `_expanded` so an outer
    // consumer can persist the set. Carries the full current path list (not a
    // delta) — the consumer just saves the whole thing atomically. Suppressed
    // during the restore cycle and the initial mount cascade (see the
    // _restoreActive / _mountInFlight rationale in TreeModel.emitExpandedState)
    // so consumers don't receive partial-set saves.
    signal expandedStateChanged(var paths)

    // Public focus-routing surface. Delegates `forceActiveFocus()` to the
    // internal `view` ListView, which is the item that actually owns the
    // `Keys.onPressed` handler (j/k/h/l/Ctrl+D/Ctrl+U/Return/...). The
    // FileTreeView's outer root is a plain Item, NOT a FocusScope, so
    // calling `forceActiveFocus()` on it from a consumer only makes the
    // outer Item the activeFocusItem — keystrokes never reach the
    // ListView and the nav keys appear dead.
    //
    // Consumers (e.g. the IDE's `onFocusTreeRequested` slot, and the
    // Active Changes panel's `focusInternal()` proxy) call this instead
    // of walking descendants by hand. Symmetric across all FileTreeView
    // instances — a consumer holding any FileTreeView reference can hand
    // it focus without needing to know about the internal `view` id.
    function focusInternal(): void {
        view.forceActiveFocus();
    }

    // --- FileOpsHandler / ChordHandler contract (shared with FileList) ---

    // Where paste/create land: the hovered directory itself, or the hovered
    // file's parent. Falls back to the tree root when the tree is empty.
    function fileOpsTargetDir(): string {
        const row = currentRow;
        if (!row) return rootPath;
        return row.isDir ? row.path : Paths.parentDir(row.path);
    }

    // No-op: a pasted item may land at any depth, so there is no single "next
    // entries change" to consume a pending focus name against (the
    // _pendingFocusName property is reserved for depth-0 rootPath navigations).
    function setPendingPasteFocus(name: string): void {
    }

    // Save the cursor row before a windowState navigation (bookmark chords) so
    // returning to this path restores it. Same contract as FileList's.
    function _saveCursorAndNavigate(navigateFn: var): void {
        windowState.saveCursor(windowState.currentPath, view.currentIndex);
        navigateFn();
    }

    implicitWidth: 280
    // Honest height: report the visible content's actual height so
    // layouts that don't `fillHeight` can grow this component to its
    // natural size. Adding `FmTheme.padding.sm * 2` to account for the
    // ListView's symmetric `anchors.margins: FmTheme.padding.sm`. Consumers that DO `fillHeight: true`
    // (the standalone FM, the main FileTreeView in symmetria-ide) are
    // unaffected — Layouts override implicit height when fillHeight is
    // set. The path-filtered IDE consumer (Active Changes panel) sets
    // no fillHeight and relies on this to size to its changeset rather
    // than scrolling internally.
    implicitHeight: view.contentHeight + FmTheme.padding.sm * 2

    onRootPathChanged: {
        TreeModel.resetTreeState(root);
        if (rootPath !== "") {
            // The auto-expand priority ladder (restoreExpandedPaths >
            // lazyExpand > initialExpandDepth) and the async kickoff live in
            // TreeModel.beginMount — see its docstring for why depth must be
            // computed before the first _expand.
            TreeModel.beginMount(root);
            root.directoryChanged(rootPath);
        }
    }

    onShowHiddenChanged: TreeModel.refreshAllExpanded(root)

    onRespectGitignoreChanged: {
        gitignoreSvc.clear();
        TreeModel.refreshAllExpanded(root);
    }

    // pathFilter changes are expected to be frequent (a git-status watcher
    // emits a new map per working-tree change). Two-pass: (1) refresh visible
    // rows against the new set (cheap); (2) if auto-expand is configured AND a
    // filter remains, re-arm the cascade against every settled model so
    // newly-arrived in-set paths under unexplored dirs become reachable — the
    // TreeModel guardrail caps still bound worst-case I/O. We do NOT touch
    // _expanded / _models / _pending: expanded stays expanded, user-collapsed
    // stays collapsed, in-flight expansions race to completion — each is the
    // correct behaviour individually.
    onPathFilterChanged: {
        TreeModel.rebuildRows(root);
        // NOTE: the lazyExpand path is intentionally NOT re-armed here — no
        // current consumer combines lazyExpand:true with pathFilter. If one
        // does, add a TreeModel.kickLazyExpand(root) call after rebuildRows().
        TreeModel.rearmAutoExpandForFilter(root);
    }

    // compactScale changes the row pixel height, which moves the visible
    // bottom row in `_shouldExpandMore`. Re-evaluate after the change.
    onCompactScaleChanged: TreeModel.kickLazyExpand(root)

    Component {
        id: fsModelComponent
        FileSystemModel {}
    }

    Gitignore {
        id: gitignoreSvc
        enabled: root.respectGitignore
    }

    Timer {
        id: ggTimer
        interval: 500
        onTriggered: root._pendingG = false
    }

    // File-operation processes driven by FileOpsHandler / ChordHandler via
    // TreeKeyHandler's scope. No pasteFailed cleanup needed — the tree sets no
    // optimistic paste state (see setPendingPasteFocus).
    PasteRunner { id: pasteProcess }
    ClipboardCopyRunner { id: clipboardCopyProcess }

    Connections {
        target: root.windowState

        function onSearchQueryChanged(): void { TreeModel.computeMatches(root, false); }
        function onCurrentMatchIndexChanged(): void { SearchHandler.jumpToCurrentMatch(root, view); }
        function onSearchCancelled(): void {
            const safe = Math.min(root._preSearchIndex, Math.max(0, root._rows.length - 1));
            view.currentIndex = safe;
            view.positionViewAtIndex(safe, ListView.Contain);
            Qt.callLater(() => view.forceActiveFocus());
        }
        function onSearchConfirmed(): void {
            Qt.callLater(() => view.forceActiveFocus());
        }

        // Any modal closing returns focus to the view. Required because the
        // popup (a top-level Loader at FileManager scope) sits outside the
        // tree's FocusScope, so closing it leaves focus orphaned — keyboard
        // appears dead until something explicitly reclaims it. Mirrors the
        // same handler in FileList.qml.
        function onActiveModalChanged(): void {
            if (root.windowState.activeModal === root.windowState.modalNone)
                Qt.callLater(() => view.forceActiveFocus());
        }

        // Focus the fuzzy-finder's pick (or stash its name for rebuildRows when
        // it lands under a not-yet-built parent). Mechanics in TreeModel.focusFuzzyResult.
        function onFuzzyFinderNavigated(filename: string): void {
            TreeModel.focusFuzzyResult(root, filename);
        }
    }

    // Lazy-expand re-arm bridge. When the user scrolls or the viewport
    // height changes (window resize, panel toggle), the visible-bottom row
    // moves and the "rows beyond" budget may go negative — `_kickLazyExpand`
    // gates on that and expands one more directory if so. Connected to the
    // ListView's signals rather than autobinding on a property so we don't
    // pay the eval cost on every contentY tick when lazyExpand is off
    // (the function short-circuits on `lazyExpand: false` regardless).
    Connections {
        target: view
        function onContentYChanged(): void { TreeModel.kickLazyExpand(root); }
        function onHeightChanged(): void { TreeModel.kickLazyExpand(root); }
    }

    // Status-provider live-update bridge. Target null (no provider attached)
    // is fine — Connections silently ignores it. When the provider signals
    // statusChanged(), bumping _statusVersion invalidates every visible row's
    // badge binding in one pass.
    Connections {
        target: root.statusProvider
        ignoreUnknownSignals: true
        function onStatusChanged(): void {
            root._statusVersion = root._statusVersion + 1;
        }
    }

    StyledRect {
        anchors.fill: parent
        color: FmTheme.layer(FmTheme.palette.surfaceContainerLow)
    }

    Loader {
        anchors.centerIn: parent
        active: view.count === 0 && !root._loading
        sourceComponent: PreviewStateIndicator {
            iconName: "folder_open"
            message: qsTr("Empty")
        }
    }

    ListView {
        id: view

        anchors.fill: parent
        anchors.margins: FmTheme.padding.sm
        clip: true
        focus: true
        keyNavigationEnabled: false
        boundsBehavior: Flickable.StopAtBounds
        model: root._rows

        Component.onCompleted: view.forceActiveFocus()

        ScrollBar.vertical: SlimScrollBar {
            policy: ScrollBar.AsNeeded
            // Explicit overflow gate: the custom thumb renders at constant
            // opacity regardless of `AsNeeded`, so without this the track
            // paints as a faint gutter for content-fit consumers (e.g. the
            // IDE's Active Changes pane). 0.5px epsilon absorbs subpixel
            // rounding from compactScale row-height multiplications.
            visible: view.contentHeight > view.height + 0.5
        }

        delegate: FileTreeRow {
            windowState: root.windowState
            compactScale: root.compactScale
            indentPixels: root.indentPixels
            statusProvider: root.statusProvider
            statusVersion: root._statusVersion
            // Single-click already set view.currentIndex to this row (the
            // StateLayer in FileTreeRow), so activating the current row is the
            // same row that was double-clicked — mirrors FileList.qml.
            onActivated: TreeModel.activate(root, root.currentRow)
        }

        Keys.onPressed: function(event) {
            TreeKeyHandler.handleKey(event, root, view);
        }

        // Cancel a half-entered chord / bookmark sub-mode when focus leaves
        // the tree (e.g. a popup steals it) — mirrors FileList.qml.
        onActiveFocusChanged: {
            if (!activeFocus && root.windowState) {
                if (root.windowState.activeChordPrefix !== "")
                    root.windowState.activeChordPrefix = "";
                if (root.windowState.bookmarkSubModeActive)
                    root.windowState.bookmarkSubMode = "";
            }
        }
    }
}
