// FileTreeView keyboard dispatcher — the ListView's Keys.onPressed body.
//
// Non-library JS — shares the QML component scope of FileTreeView.qml (the sole
// importer). FileTreeView state is reached through `root`; the ListView through
// `view`; sibling handlers and component ids resolve via the importing file's
// scope (same mechanism as TreeFlashHandler reaching FlashLogic).
//
// Component IDs accessed via scope: ggTimer (the windowState-less `gg`-chord
//   timer), pasteProcess, clipboardCopyProcess (ShellRunner wrappers).
// Sibling handlers accessed via scope: TreeModel (expand/collapse/toggle/
//   activate/jumpToParent/halfPageCount/refreshAll), TreeFlashHandler (handleKey),
//   ChordHandler (chord resolution + bookmark sub-mode), KeyRegistry (the
//   shared dispatch table used when windowState exists — operation keys live
//   THERE, not in this embedded-only switch).
// Singletons accessed via scope: Qt.

function handleKey(event, root, view) {
    var mods = event.modifiers;
    var key = event.key;

    // Swallow all keys while a modal is open. The popup is a sibling
    // Loader at FileManager scope, so without this guard a focus race
    // can leave keystrokes hitting the tree ListView instead of the
    // popup's TextInput — search input would stay empty and the
    // popup would appear "broken". Matches FileList.qml's first
    // guard in its Keys.onPressed.
    if (root.windowState && root.windowState.activeModal !== root.windowState.modalNone) {
        event.accepted = true;
        return;
    }

    // Bookmark sub-mode: capture a single letter for create/delete
    if (root.windowState && root.windowState.bookmarkSubModeActive) {
        ChordHandler.handleBookmarkSubMode(event, root);
        return;
    }

    // Resolve active chord (g=navigate, c=copy-path, ,=sort) — mirrors
    // FileList.qml's ordering: chords resolve before anything else so a
    // chord's second key can't be swallowed by another handler.
    if (root.windowState && root.windowState.activeChordPrefix !== "") {
        ChordHandler.resolveChord(event, root, view, clipboardCopyProcess);
        return;
    }

    if (key === Qt.Key_E && (mods & Qt.ControlModifier)) {
        if (root.windowState) root.windowState.toggleViewMode();
        event.accepted = true;
        return;
    }

    // Flash mode captures every key — labels jump, continuations
    // extend the query, Escape/Backspace exit.
    if (root.windowState && root.windowState.flashActive) {
        TreeFlashHandler.handleKey(event, root, view);
        return;
    }

    // FULL file-manager path: a windowState means the registry owns dispatch
    // (file ops + navigation + picker suppression, shared with the Miller view
    // via KeyRegistry). dispatch() leaves event.accepted false when no binding
    // matches, so an unconsumed key (e.g. Escape with no selection — the tree
    // deliberately has no escapeSwallow binding) still propagates to the host's
    // close-window handling, preserving the tree's pre-existing behavior.
    if (root.windowState) {
        var ctx = {
            root: root,
            view: view,
            windowState: root.windowState,
            viewKind: "tree",
            pasteProcess: pasteProcess,
            clipboardCopyProcess: clipboardCopyProcess,
            services: { fileManager: FileManagerService, config: Config, paths: Paths },
            activateCurrent: function() { TreeModel.activate(root, root.currentRow); },
            halfPageCount: function() { return TreeModel.halfPageCount(); },
            nav: function(fn) { fn(); },  // tree: passthrough (no cursor-save, matching the old switch)
            invalidateFlashCache: function() { TreeFlashHandler.invalidateEntryCache(); }
        };
        KeyRegistry.dispatch(event, ctx);
        return;
    }

    // EMBEDDED path (no windowState — IDE sidebar): navigation-only legacy
    // switch + the gg-chord timer. The registry and chord systems don't exist
    // for this consumer, so this stays its authoritative handler.
    switch (key) {
    case Qt.Key_J:
    case Qt.Key_Down:
        if (view.currentIndex < view.count - 1) view.currentIndex++;
        event.accepted = true;
        break;

    case Qt.Key_K:
    case Qt.Key_Up:
        if (view.currentIndex > 0) view.currentIndex--;
        event.accepted = true;
        break;

    case Qt.Key_G:
        // With a windowState, bare g is claimed by the registry as the "g"
        // chord start (bookmarks + which-key, gg handled by ChordHandler), so
        // only Shift+G lands here. The timer-based gg below is the fallback
        // for embedded consumers with no windowState (IDE sidebar), where the
        // chord system doesn't exist.
        if (mods & Qt.ShiftModifier) {
            if (view.count > 0) view.currentIndex = view.count - 1;
            root._pendingG = false;
            ggTimer.stop();
        } else if (root._pendingG) {
            if (view.count > 0) view.currentIndex = 0;
            root._pendingG = false;
            ggTimer.stop();
        } else {
            root._pendingG = true;
            ggTimer.restart();
        }
        event.accepted = true;
        break;

    case Qt.Key_H:
        if (mods & Qt.ShiftModifier) {
            root.showHiddenToggleRequested();
        } else {
            var curH = root.currentRow;
            if (curH && curH.isDir && curH.expanded) TreeModel.collapse(root, curH.path);
            else TreeModel.jumpToParent(root);
        }
        event.accepted = true;
        break;

    case Qt.Key_Left: {
        var rowLeft = root.currentRow;
        if (rowLeft && rowLeft.isDir && rowLeft.expanded) TreeModel.collapse(root, rowLeft.path);
        else TreeModel.jumpToParent(root);
        event.accepted = true;
        break;
    }

    case Qt.Key_L:
    case Qt.Key_Right: {
        var rowRight = root.currentRow;
        if (!rowRight) { event.accepted = true; break; }
        if (rowRight.isDir) {
            if (!rowRight.expanded) TreeModel.expand(root, rowRight.path);
            else if (view.currentIndex + 1 < view.count) view.currentIndex++;
        } else {
            root.fileActivated(rowRight.path);
        }
        event.accepted = true;
        break;
    }

    case Qt.Key_Return:
    case Qt.Key_Enter:
        TreeModel.activate(root, root.currentRow);
        event.accepted = true;
        break;

    case Qt.Key_D:
        // Bare d (delete) is claimed by the registry when a windowState exists.
        if ((mods & Qt.ControlModifier) && view.count > 0) {
            view.currentIndex = Math.min(view.currentIndex + TreeModel.halfPageCount(), view.count - 1);
            view.positionViewAtIndex(view.currentIndex, ListView.Contain);
            event.accepted = true;
        } else if ((mods & Qt.ShiftModifier) && root.windowState) {
            // Shift+D — navigate history forward (mirrors the PathBar forward button)
            root.windowState.forward();
            event.accepted = true;
        }
        break;

    case Qt.Key_U:
        if ((mods & Qt.ControlModifier) && view.count > 0) {
            view.currentIndex = Math.max(view.currentIndex - TreeModel.halfPageCount(), 0);
            view.positionViewAtIndex(view.currentIndex, ListView.Contain);
            event.accepted = true;
        }
        break;

    case Qt.Key_O: {
        var rowO = root.currentRow;
        if (rowO && rowO.isDir) TreeModel.toggle(root, rowO.path);
        event.accepted = true;
        break;
    }

    case Qt.Key_R:
        // Bare r (rename) is claimed by the registry; Shift+R stays the
        // tree's refresh-all (the rename popup's Tab toggles extension
        // selection, so rename-with-extension isn't lost).
        if (mods & Qt.ShiftModifier) {
            TreeModel.refreshAll(root);
            event.accepted = true;
        }
        break;

    case Qt.Key_Slash:
        if (root.windowState) {
            root._preSearchIndex = view.currentIndex;
            root.windowState.startSearch();
            event.accepted = true;
        }
        break;

    case Qt.Key_S:
        if (root.windowState) {
            if (mods & Qt.ShiftModifier) {
                // Shift+S — navigate history back (mirrors the PathBar back button)
                root.windowState.back();
            } else {
                root._preFlashIndex = view.currentIndex;
                TreeFlashHandler.invalidateEntryCache();
                root.windowState.startFlash();
            }
            event.accepted = true;
        }
        break;

    case Qt.Key_N:
        if (root.windowState && !root.windowState.searchActive && root.windowState.matchIndices.length > 0) {
            if (mods & Qt.ShiftModifier) root.windowState.previousMatch();
            else root.windowState.nextMatch();
            event.accepted = true;
        }
        break;

    case Qt.Key_Period:
        root.respectGitignore = !root.respectGitignore;
        event.accepted = true;
        break;

    case Qt.Key_F:
        if (root.windowState) {
            root.windowState.requestFuzzyFinder();
            event.accepted = true;
        }
        break;
    }
}
