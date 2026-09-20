// Flash navigation: key handling, match recomputation, cross-column jump.
//
// Non-library JS — shares the QML component scope of FileList.qml.
// FlashLogic (`.pragma library`) is accessed via the component's import scope.
// Component IDs accessed via scope: fsModel.
// Logger singleton is accessed via scope.

// Cached flat entry list across all three columns.  Rebuilt only when
// invalidated (directory change, file-watcher update, flash mode exit).
var _cachedAllEntries = null;

function invalidateEntryCache() {
    _cachedAllEntries = null;
}

function handleKey(event, root, view) {
    var windowState = root.windowState;
    var key = event.key;

    if (key === Qt.Key_Shift || key === Qt.Key_Control
        || key === Qt.Key_Alt || key === Qt.Key_Meta) {
        event.accepted = true;
        return;
    }

    if (key === Qt.Key_Escape) {
        Logger.debug("Flash", "Escape → cancel flash");
        view.currentIndex = root._preFlashIndex;
        view.positionViewAtIndex(view.currentIndex, ListView.Contain);
        windowState.clearFlash();
        event.accepted = true;
        return;
    }

    if (key === Qt.Key_Backspace) {
        // Cancel pending 2-char label without touching the query
        if (windowState.flashPendingLabel !== "") {
            Logger.debug("Flash", "Backspace → cancel pending 2-char label '" + windowState.flashPendingLabel + "'");
            windowState.flashPendingLabel = "";
        } else if (windowState.flashQuery.length > 0) {
            Logger.debug("Flash", "Backspace → query '" + windowState.flashQuery + "' → '" + windowState.flashQuery.slice(0, -1) + "'");
            windowState.flashQuery = windowState.flashQuery.slice(0, -1);
            recompute(root, view);
        } else {
            Logger.debug("Flash", "Backspace → empty query, cancel flash");
            view.currentIndex = root._preFlashIndex;
            view.positionViewAtIndex(view.currentIndex, ListView.Contain);
            windowState.clearFlash();
        }
        event.accepted = true;
        return;
    }

    var ch = event.text.toLowerCase();
    if (ch === "") {
        Logger.debug("Flash", "Ignored non-printable key=" + key + " text='" + event.text + "'");
        event.accepted = true;
        return;
    }

    if (Logger.minLevel <= Logger.levelDebug) {
        Logger.debug("Flash", "Keypress '" + ch + "' | query='" + windowState.flashQuery
            + "' | isLabel=" + !!windowState.flashLabelChars[ch]
            + " | isContinuation=" + !!windowState.flashContinuations[ch]
            + " | pendingLabel='" + windowState.flashPendingLabel + "'");
    }

    // Resolve second char of a 2-char label
    if (windowState.flashPendingLabel !== "") {
        var fullLabel = windowState.flashPendingLabel + ch;
        windowState.flashPendingLabel = "";
        var pending = windowState.flashMatches;
        for (var i = 0; i < pending.length; i++) {
            if (pending[i].label === fullLabel) {
                Logger.info("Flash", "2-char label '" + fullLabel + "' → jump " + pending[i].column + ":" + pending[i].index + " " + pending[i].path);
                windowState.flashJump(pending[i].column, pending[i].index, pending[i].path);
                windowState.clearFlash();
                event.accepted = true;
                return;
            }
        }
        Logger.debug("Flash", "Invalid 2-char label '" + fullLabel + "' — ignored");
        event.accepted = true;
        return;
    }

    // Check if char is a label
    if (windowState.flashLabelChars[ch]) {
        var matches = windowState.flashMatches;
        // Try exact 1-char label
        for (var j = 0; j < matches.length; j++) {
            if (matches[j].label === ch) {
                Logger.info("Flash", "Label '" + ch + "' → jump " + matches[j].column + ":" + matches[j].index + " " + matches[j].path);
                windowState.flashJump(matches[j].column, matches[j].index, matches[j].path);
                windowState.clearFlash();
                event.accepted = true;
                return;
            }
        }
        // Check if first char of any 2-char label
        for (var k = 0; k < matches.length; k++) {
            if (matches[k].label.length === 2 && matches[k].label[0] === ch) {
                Logger.debug("Flash", "'" + ch + "' is 2-char label prefix → waiting for second char");
                windowState.flashPendingLabel = ch;
                event.accepted = true;
                return;
            }
        }
    }

    // Check if char is a continuation → extend query.
    // When query is empty, every printable char is a valid first search char
    // (no continuations or labels exist yet).
    if (windowState.flashQuery === "" || windowState.flashContinuations[ch]) {
        Logger.debug("Flash", "Continuation '" + ch + "' → query becomes '" + windowState.flashQuery + ch + "'");
        windowState.flashQuery += ch;
        recompute(root, view);
        event.accepted = true;
        return;
    }

    // Neither label nor continuation — ignore
    Logger.warn("Flash", "'" + ch + "' is neither label nor continuation — dropped");
    event.accepted = true;
}

function _buildAllEntries(root) {
    var allEntries = [];

    var currentEntries = fsModel.entries;
    for (var i = 0; i < currentEntries.length; i++) {
        allEntries.push({
            name:   currentEntries[i].name,
            column: "current",
            index:  i,
            path:   currentEntries[i].path,
            isDir:  currentEntries[i].isDir
        });
    }

    // Only include preview entries if the directory path is resolved
    // (avoids searching stale entries during the 150ms debounce window)
    var prevEntries = root.previewDirectoryPath !== "" ? root.previewDirectoryEntries : null;
    if (prevEntries) {
        for (var j = 0; j < prevEntries.length; j++) {
            allEntries.push({
                name:   prevEntries[j].name,
                column: "preview",
                index:  j,
                path:   prevEntries[j].path,
                isDir:  prevEntries[j].isDir
            });
        }
    }

    var parEntries = root.parentEntries;
    for (var k = 0; k < parEntries.length; k++) {
        allEntries.push({
            name:   parEntries[k].name,
            column: "parent",
            index:  k,
            path:   parEntries[k].path,
            isDir:  parEntries[k].isDir
        });
    }

    return allEntries;
}

function recompute(root, view) {
    var windowState = root.windowState;
    var query = windowState.flashQuery.toLowerCase();
    if (query === "") {
        // Reset result state only — flash remains active, just with no matches yet.
        // Do not clear flashActive or flashPendingLabel here.
        windowState.flashMatches = [];
        windowState.flashLabelChars = {};
        windowState.flashContinuations = {};
        windowState.flashCurrentMatchMap = {};
        windowState.flashParentMatchMap = {};
        windowState.flashPreviewMatchMap = {};
        return;
    }

    if (!_cachedAllEntries)
        _cachedAllEntries = _buildAllEntries(root);

    var result = FlashLogic.computeFlash(query, _cachedAllEntries, view.currentIndex);
    windowState.flashMatches = result.matches;
    windowState.flashLabelChars = result.labelChars;
    windowState.flashContinuations = result.continuations;

    // Build per-column match maps so each ListView only re-evaluates
    // when its own column's matches change (not all three at once).
    var currentMap = {};
    var parentMap = {};
    var previewMap = {};
    for (var m = 0; m < result.matches.length; m++) {
        var match = result.matches[m];
        if (match.column === "current") currentMap[match.index] = match;
        else if (match.column === "parent") parentMap[match.index] = match;
        else if (match.column === "preview") previewMap[match.index] = match;
    }
    windowState.flashCurrentMatchMap = currentMap;
    windowState.flashParentMatchMap = parentMap;
    windowState.flashPreviewMatchMap = previewMap;

    if (Logger.minLevel <= Logger.levelDebug) {
        var contKeys = Object.keys(result.continuations).join("");
        var labelKeys = Object.keys(result.labelChars).join("");
        var labelList = result.matches.map(function(entry) { return entry.label + "→" + entry.name.substring(0, 15); }).join(", ");
        Logger.debug("Flash", "Recompute query='" + query + "' | entries=" + _cachedAllEntries.length
            + " | matches=" + result.matches.length
            + " | continuations=[" + contKeys + "] | labelPool=[" + labelKeys + "]"
            + " | labels: " + labelList);
    }
}

// Cross-column flash jump handler.
// Order-critical: for parent column, saveCursor MUST execute BEFORE
// _saveCursorAndNavigate (which saves currentPath's cursor — a different path).
function handleJump(column, index, path, root, view) {
    var windowState = root.windowState;
    Logger.info("Flash", "Jump → " + column + ":" + index + " path=" + path);
    if (column === "current") {
        view.currentIndex = index;
        view.positionViewAtIndex(index, ListView.Contain);
    } else if (column === "preview") {
        if (root.previewDirectoryPath !== "") {
            windowState.saveCursor(root.previewDirectoryPath, index);
            root._saveCursorAndNavigate(function() { windowState.navigate(root.previewDirectoryPath); });
        }
    } else if (column === "parent") {
        var parentPath = Paths.parentDir(windowState.currentPath);
        // Save the flash target cursor BEFORE _saveCursorAndNavigate, which saves
        // currentPath's cursor (a different path). Order is load-bearing.
        windowState.saveCursor(parentPath, index);
        root._saveCursorAndNavigate(function() { windowState.goUp(); });
    }
}
