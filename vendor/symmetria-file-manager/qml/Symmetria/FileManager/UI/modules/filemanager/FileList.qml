pragma ComponentBehavior: Bound

import Symmetria.FileManager.UI
// DO NOT REMOVE: FlashHandler.js (non-pragma-library) reaches FlashLogic through this file's
// import scope at runtime. The linter cannot see cross-JS scope deps and reports this as
// unused — that is a false positive. Removing it silently breaks flash mode with a ReferenceError.
import "FlashLogic.js" as FlashLogic // qmllint disable unused-imports
import "handlers/SearchHandler.js" as SearchHandler
import "handlers/FlashHandler.js" as FlashHandler
import "handlers/ChordHandler.js" as ChordHandler
import "handlers/NormalModeHandler.js" as NormalModeHandler
// NormalModeHandler.js builds the dispatch ctx and delegates to KeyRegistry; the
// registry's Miller run-bodies in turn reach NormalModeHandler/FlashHandler
// through this file's import scope at runtime (same cross-JS mechanism as
// FlashLogic above) — the linter cannot see that and reports these unused.
import "handlers/KeyRegistry.js" as KeyRegistry // qmllint disable unused-imports
import Symmetria.FileManager.Models
import QtQuick
import QtQuick.Controls

Item {
    id: root

    property WindowState windowState
    property TabManager tabManager

    // Optional per-row badge data source — duck-typed extension point matching
    // FileTreeView.statusProvider. Null (default) renders no badges; otherwise
    // the consumer supplies an object with statusForPath(path) and a
    // statusChanged() signal. See FileTreeView.qml for the full contract.
    property var statusProvider: null

    // Monotonic counter incremented when statusProvider.statusChanged() fires.
    // Passed through to each FileListItem so its badge binding re-evaluates on
    // every update. Single Connections object on the list rather than N on the
    // delegates.
    property int _statusVersion: 0

    readonly property var currentEntry: view.currentIndex >= 0 && view.currentIndex < view.count ? fsModel.entries[view.currentIndex] : null
    readonly property int fileCount: view.count
    signal closeRequested()

    // Set by onPathChanged (sync, before C++ async scan starts), cleared by
    // onEntriesChanged (async, after QtConcurrent scan and applyChanges complete).
    // Ensures currentIndex resets only after new entries are populated.
    property bool _pathJustChanged: false

    // Search: cursor position saved before entering search mode
    property int _preSearchIndex: 0

    // Filename to focus once the model refreshes (set by paste, create, rename, etc.)
    property string _pendingFocusName: ""

    // Flash navigation: cross-column entry sources (wired from MillerColumns)
    property var parentEntries: []
    property var previewDirectoryEntries: []
    property string previewDirectoryPath: ""
    property int _preFlashIndex: 0

    // Invalidate flash entry cache when preview column entries change so a
    // flash session entered after the preview has loaded sees current entries.
    onPreviewDirectoryEntriesChanged: FlashHandler.invalidateEntryCache()

    // Publish whether the cursor sits on an image so WindowState can gate the
    // ci (image-to-clipboard) chord row to images only. Synced on cursor move,
    // on tab switch (onWindowStateChanged below), and at creation when toggling
    // into Miller view (onCurrentEntryChanged does NOT fire for the initial value).
    onCurrentEntryChanged: if (windowState) windowState.syncImageCursor(currentEntry)
    Component.onCompleted: if (windowState) windowState.syncImageCursor(currentEntry)

    // Save cursor before tab switch so it can be restored when returning
    Connections {
        target: root.tabManager
        enabled: root.tabManager !== null
        function onAboutToSwitchTab(): void {
            if (!root.windowState)
                return;
            root.windowState.saveCursor(root.windowState.currentPath, view.currentIndex);
            // Cancel transient modes on the departing tab
            if (root.windowState.searchActive)
                root.windowState.clearSearch();
            if (root.windowState.flashActive) {
                root.windowState.clearFlash();
                FlashHandler.invalidateEntryCache();
            }
            if (root.windowState.activeChordPrefix !== "")
                root.windowState.activeChordPrefix = "";
            if (root.windowState.bookmarkSubModeActive)
                root.windowState.bookmarkSubMode = "";
        }
    }

    // When the active tab (and thus windowState) changes, restore cursor position.
    // If the new tab has the same path, FSModel won't re-scan (no onPathChanged/onEntriesChanged),
    // so we must restore the cursor directly. If the path differs, onPathChanged will handle it.
    onWindowStateChanged: {
        if (windowState) {
            // Re-sync the new tab's image-chord gate to this view's cursor.
            windowState.syncImageCursor(currentEntry);
            const newPath = windowState.currentPath;
            if (newPath === fsModel.path && view.count > 0) {
                // Same directory AND model already populated — restore cursor immediately.
                // If count is 0, the model is still loading; onEntriesChanged will handle it.
                const restored = windowState.restoreCursor(newPath);
                const safeIndex = Math.min(restored, view.count - 1);
                view.currentIndex = safeIndex;
                view.positionViewAtIndex(safeIndex, ListView.Contain);
            }
            // Different path — FSModel.path binding triggers onPathChanged → _pathJustChanged flow
        }
    }

    // Y of the bottom edge of the current item, relative to FileList root.
    // Used by RenamePopup for contextual positioning below the selected item.
    readonly property real currentItemBottomY: {
        if (view.currentIndex < 0 || view.count === 0) return 0;
        const itemY = view.currentIndex * Config.fileManager.sizes.itemHeight - view.contentY;
        return itemY + Config.fileManager.sizes.itemHeight + FmTheme.padding.sm;
    }

    // --- FileOpsHandler contract (shared with FileTreeView) ---

    // Where paste/create land: the directory this list is showing.
    function fileOpsTargetDir(): string {
        return windowState.currentPath;
    }

    // Focus `name` once the model refreshes after a paste.
    function setPendingPasteFocus(name: string): void {
        _pendingFocusName = name;
    }

    function _saveCursorAndNavigate(navigateFn: var): void {
        windowState.saveCursor(windowState.currentPath, view.currentIndex);
        navigateFn();
    }

    function _navigateIntoCurrentItem(): void {
        if (!root.currentEntry || !root.currentEntry.isDir)
            return;
        _saveCursorAndNavigate(() => windowState.navigate(root.currentEntry.path));
    }

    function _activateCurrentItem(): void {
        if (FileManagerService.pickerMode) {
            FileManagerService.confirmPickerSelection(root.currentEntry, windowState);
            return;
        }

        if (!root.currentEntry)
            return;

        if (root.currentEntry.isDir)
            _navigateIntoCurrentItem();
        else if (root.currentEntry.mimeType === "application/x-shellscript" || root.currentEntry.mimeType === "text/x-shellscript")
            fileOpener.execute(root.currentEntry.path);
        else
            fileOpener.open(root.currentEntry.path, root.currentEntry.mimeType);
    }

    Connections {
        target: root.windowState

        function onSearchQueryChanged() {
            SearchHandler.computeMatches(root, view, false);
        }

        function onCurrentMatchIndexChanged() {
            SearchHandler.jumpToCurrentMatch(root, view);
        }

        function onSearchCancelled() {
            view.currentIndex = root._preSearchIndex;
            view.positionViewAtIndex(view.currentIndex, ListView.Contain);
            Qt.callLater(() => view.forceActiveFocus());
        }

        function onSearchConfirmed() {
            Qt.callLater(() => view.forceActiveFocus());
        }

        function onActiveModalChanged() {
            if (root.windowState.activeModal === root.windowState.modalNone)
                Qt.callLater(() => view.forceActiveFocus());
        }

        function onCreateCompleted(filename: string) {
            root._pendingFocusName = filename;
        }

        function onRenameCompleted(newName: string) {
            root._pendingFocusName = newName;
        }

        function onFuzzyFinderNavigated(filename: string) {
            // Try to focus immediately — handles same-directory files where
            // navigate() returns early and onEntriesChanged never fires.
            const entries = fsModel.entries;
            for (let i = 0; i < entries.length; i++) {
                if (entries[i].name === filename) {
                    view.currentIndex = i;
                    view.positionViewAtIndex(i, ListView.Contain);
                    return;
                }
            }
            // File not in current entries — will be picked up after navigate()
            // triggers a directory change and onEntriesChanged fires.
            root._pendingFocusName = filename;
        }

        function onFlashJump(column: string, index: int, path: string) {
            FlashHandler.handleJump(column, index, path, root, view);
        }
    }

    // Return focus to file list when inline save-name editing ends.
    // Guard against picker completion: if pickerMode is already false, the window
    // is closing — forcing focus on a departing view is a no-op and may emit warnings.
    Connections {
        target: FileManagerService

        function onSaveNameEditingChanged() {
            if (!FileManagerService.saveNameEditing && FileManagerService.pickerMode)
                Qt.callLater(() => view.forceActiveFocus());
        }
    }

    // Status-provider live-update bridge — bumps _statusVersion to invalidate
    // every visible delegate's badge binding in one pass. Mirror of the same
    // pattern in FileTreeView; null target is safe (Connections silently
    // ignores it when no provider is wired).
    Connections {
        target: root.statusProvider
        ignoreUnknownSignals: true
        function onStatusChanged() {
            root._statusVersion = root._statusVersion + 1;
        }
    }

    // Background
    StyledRect {
        anchors.fill: parent
        color: FmTheme.layer(FmTheme.palette.surfaceContainerLow)
    }

    // Empty state
    Loader {
        anchors.centerIn: parent
        opacity: view.count === 0 ? 1 : 0
        active: opacity > 0
        asynchronous: true

        sourceComponent: PreviewStateIndicator {
            iconName: "folder_open"
            message: qsTr("This folder is empty")
        }

        Behavior on opacity {
            Anim {}
        }
    }

    ListView {
        id: view

        anchors.fill: parent
        anchors.margins: FmTheme.padding.sm
        anchors.rightMargin: FmTheme.padding.sm + 10 // reserve space for re-parented scrollbar (6px wide + 4px clearance)

        clip: true
        focus: true
        keyNavigationEnabled: false
        boundsBehavior: Flickable.StopAtBounds
        Component.onCompleted: view.forceActiveFocus()

        // Re-parented to view.parent so the scrollbar lives outside the ListView's
        // clipping rect and can be positioned independently in the right margin gap.
        ScrollBar.vertical: SlimScrollBar {
            policy: ScrollBar.AlwaysOn
            parent: view.parent
            anchors.top: view.top
            anchors.bottom: view.bottom
            anchors.right: parent.right
            anchors.rightMargin: FmTheme.padding.sm + 3 // right-aligns the 6px bar with 3px clearance from the window edge
        }

        model: FileSystemModel {
            id: fsModel
            path: root.windowState ? root.windowState.currentPath : ""
            showHidden: Config.fileManager.showHidden
            sortBy: root.windowState ? root.windowState.sortBy : FileSystemModel.Modified
            sortReverse: root.windowState ? root.windowState.sortReverse : true
            watchChanges: true
            onPathChanged: root._pathJustChanged = true
            // NOTE: Do NOT add an onLoadingChanged handler that clears _pathJustChanged.
            // loadingChanged(false) fires BEFORE applyChanges() populates entries
            // (see filesystemmodel.cpp:625-636), so it would consume the flag before
            // the real onEntriesChanged arrives.  _pathJustChanged staying true for
            // empty directories is harmless — it's idempotent on next navigation.
            onEntriesChanged: {
                if (root._pathJustChanged) {
                    // The C++ model emits entriesChanged twice on path change:
                    // first with count=0 (stale-entry clear), then with the real
                    // entries after the async scan.  Skip the empty reset so we
                    // don't consume _pathJustChanged with a clamped-to-0 cursor.
                    if (view.count === 0)
                        return;
                    root._pathJustChanged = false;
                    // Fuzzy finder navigation: focus a specific file in the newly-navigated
                    // directory (set by fuzzyFinderNavigated signal before navigate() call).
                    if (root._pendingFocusName !== "") {
                        const pendingName = root._pendingFocusName;
                        root._pendingFocusName = "";
                        const entries = fsModel.entries;
                        for (let i = 0; i < entries.length; i++) {
                            if (entries[i].name === pendingName) {
                                view.currentIndex = i;
                                view.positionViewAtIndex(i, ListView.Contain);
                                return;
                            }
                        }
                    }
                    const restored = root.windowState ? root.windowState.restoreCursor(fsModel.path) : 0;
                    const safeIndex = Math.min(restored, Math.max(view.count - 1, 0));
                    view.currentIndex = safeIndex;
                    view.positionViewAtIndex(safeIndex, ListView.Beginning);
                } else {
                    // Clamp cursor after file deletion or external changes
                    if (view.currentIndex >= view.count && view.count > 0)
                        view.currentIndex = view.count - 1;
                    // Focus a specific file if pending (set by paste, create, etc.) —
                    // only applies to same-directory refreshes, never to path navigations
                    if (root._pendingFocusName !== "") {
                        const entries = fsModel.entries;
                        for (let i = 0; i < entries.length; i++) {
                            if (entries[i].name === root._pendingFocusName) {
                                view.currentIndex = i;
                                view.positionViewAtIndex(i, ListView.Contain);
                                break;
                            }
                        }
                        root._pendingFocusName = "";
                    }
                }
                // Re-compute matches if search is active (handles async model reload)
                if (root.windowState && root.windowState.searchQuery !== "")
                    SearchHandler.computeMatches(root, view, true);
                // Invalidate cached flash entries so the next flash session
                // builds from current directory contents, not stale data.
                FlashHandler.invalidateEntryCache();
            }
        }

        delegate: FileListItem {
            width: view.width
            searchQuery: root.windowState ? root.windowState.searchQuery : ""
            isSearchMatch: root.windowState ? !!root.windowState._matchIndexSet[index] : false
            // Reading selectedPaths in the expression makes QML re-evaluate
            // this binding whenever the object reference changes (toggleSelection
            // assigns a new object each time, triggering the notify signal).
            isSelected: root.windowState && root.windowState.selectedPaths
                        ? !!root.windowState.selectedPaths[modelData?.path ?? ""] : false
            flashActive: root.windowState ? root.windowState.flashActive : false
            flashQuery: root.windowState ? root.windowState.flashQuery : ""
            flashLabel: root.windowState?.flashCurrentMatchMap[index]?.label ?? ""
            flashMatchStart: root.windowState?.flashCurrentMatchMap[index]?.matchStart ?? -1
            statusProvider: root.statusProvider
            statusVersion: root._statusVersion
            onActivated: root._activateCurrentItem()
        }

        // Vim-style keyboard navigation
        Keys.onPressed: function(event) {
            // Block all keys while a modal popup is visible
            if (root.windowState.activeModal !== root.windowState.modalNone) {
                event.accepted = true;
                return;
            }

            // Bookmark sub-mode: capture a single letter for create/delete
            if (root.windowState.bookmarkSubModeActive) {
                ChordHandler.handleBookmarkSubMode(event, root);
                return;
            }

            // Resolve active chord BEFORE picker suppression — otherwise a
            // chord like g,d is broken because 'd' gets suppressed before
            // the chord resolver can see it.
            if (root.windowState.activeChordPrefix !== "") {
                ChordHandler.resolveChord(event, root, view, clipboardCopyProcess);
                return;
            }

            // Flash navigation mode: intercept all keys for search/label/jump
            if (root.windowState.flashActive) {
                FlashHandler.handleKey(event, root, view);
                return;
            }

            // Normal mode: picker suppression + main key dispatch
            NormalModeHandler.handleKey(event, root, view, pasteProcess, clipboardCopyProcess);
        }

        onActiveFocusChanged: {
            if (!activeFocus) {
                if (root.windowState.activeChordPrefix !== "")
                    root.windowState.activeChordPrefix = "";
                if (root.windowState.bookmarkSubModeActive)
                    root.windowState.bookmarkSubMode = "";
            }
        }
    }

    FileOpener {
        id: fileOpener
    }

    PasteRunner {
        id: pasteProcess
        onPasteFailed: root._pendingFocusName = ""
    }

    ClipboardCopyRunner {
        id: clipboardCopyProcess
    }
}
