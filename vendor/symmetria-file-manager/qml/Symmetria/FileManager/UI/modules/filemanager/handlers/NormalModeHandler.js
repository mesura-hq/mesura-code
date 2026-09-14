// Normal-mode key handling for the Miller-columns view.
//
// As of the keybinding-registry migration this is a THIN ADAPTER: it builds the
// Miller dispatch `ctx` (view + injected singletons + the view-adapter
// capabilities) and delegates to KeyRegistry.dispatch. The actual key→command
// table — including the file operations that used to live in FileOpsHandler and
// the navigation switch that used to live here — is now data in KeyRegistry.js.
//
// The helper functions below are retained because the registry's Miller-specific
// run-bodies call them through this file's scope (NormalModeHandler.*):
//   _jumpToDirFileBoundary (Tab), _copyPickerPathToClipboard (Shift+Enter in a
//   picker), and _halfPageCount (Ctrl+D/U, via ctx.halfPageCount).
//
// Non-library JS — shares the QML component scope of FileList.qml. Singletons
// (FileManagerService, Config, Paths) and sibling handlers (KeyRegistry,
// FlashHandler) resolve through that scope; fsModel via its id.

function handleKey(event, root, view, pasteProcess, clipboardCopyProcess) {
    var ctx = {
        root: root,
        view: view,
        windowState: root.windowState,
        viewKind: "miller",
        pasteProcess: pasteProcess,
        clipboardCopyProcess: clipboardCopyProcess,
        services: { fileManager: FileManagerService, config: Config, paths: Paths },
        activateCurrent: function() { root._activateCurrentItem(); },
        halfPageCount: function() { return _halfPageCount(view); },
        nav: function(fn) { root._saveCursorAndNavigate(fn); },
        invalidateFlashCache: function() { FlashHandler.invalidateEntryCache(); }
    };
    KeyRegistry.dispatch(event, ctx);
}

// --- Internal helpers (called by the registry's Miller run-bodies via scope) ---

// Returns the clipboard-preview path for the current picker state, or "" if
// the current state has no selectable target.
function _resolvePickerPath(root) {
    if (FileManagerService.pickerSaveMode) {
        var dir = root.windowState.currentPath;
        var name = FileManagerService.pickerSuggestedName;
        if (name) {
            return dir.endsWith("/") ? dir + name : dir + "/" + name;
        }
        return dir;
    } else if (FileManagerService.pickerDirectory) {
        if (root.currentEntry && root.currentEntry.isDir)
            return root.currentEntry.path;
    } else {
        if (root.currentEntry && !root.currentEntry.isDir)
            return root.currentEntry.path;
    }
    return "";
}

// Copies picker path(s) to system clipboard, then invokes onDone() once wl-copy exits.
function _copyPickerPathToClipboard(root, clipboardCopyProcess, onDone) {
    if (clipboardCopyProcess.running)
        return;
    var text;
    if (FileManagerService.pickerMultiple && root.windowState.selectedCount > 0) {
        text = root.windowState.getSelectedPathsArray().join("\n");
    } else {
        text = _resolvePickerPath(root);
    }
    if (!text)
        return;
    clipboardCopyProcess._pendingCallback = onDone;
    clipboardCopyProcess.command = FileManagerService.clipboardCopyCommand(text);
    clipboardCopyProcess.start();
}

function _halfPageCount(view) {
    return Math.max(1, Math.floor(view.height / Config.fileManager.sizes.itemHeight / 2));
}

function _findFirstEntryOfType(targetIsDir) {
    var entries = fsModel.entries;
    for (var i = 0; i < entries.length; i++) {
        if (entries[i].isDir === targetIsDir)
            return i;
    }
    return -1;
}

function _jumpToDirFileBoundary(root, view) {
    if (!root.currentEntry) return;
    var target = _findFirstEntryOfType(!root.currentEntry.isDir);
    if (target < 0) return;

    view.currentIndex = target;
    view.positionViewAtIndex(target, ListView.Contain);
}
