// Tree-view flash handler. Parallels FlashHandler.js but operates on the
// flattened `_rows` array — a single logical column with no cross-view
// navigation. All jumps land inside the same FileTreeView ListView.
//
// Non-library JS — shares the QML component scope of FileTreeView.qml.
// FlashLogic (`.pragma library`) is accessed via the importing file's scope.
// Logger singleton is accessed via scope.

// Per-importer cache. Non-library JS is NOT shared — each QML file that imports
// this handler gets its own instance. FileTreeRow.qml imports this file for
// highlightFlash only and never calls recompute(), so its _cachedAllEntries stays
// permanently null and is harmless. Only the FileTreeView.qml import populates it.
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
        Logger.debug("TreeFlash", "Escape → cancel flash");
        view.currentIndex = root._preFlashIndex;
        view.positionViewAtIndex(view.currentIndex, ListView.Contain);
        windowState.clearFlash();
        event.accepted = true;
        return;
    }

    if (key === Qt.Key_Backspace) {
        // Cancel pending 2-char label without touching the query
        if (windowState.flashPendingLabel !== "") {
            Logger.debug("TreeFlash", "Backspace → cancel pending 2-char label '" + windowState.flashPendingLabel + "'");
            windowState.flashPendingLabel = "";
        } else if (windowState.flashQuery.length > 0) {
            Logger.debug("TreeFlash", "Backspace → query '" + windowState.flashQuery + "' → '" + windowState.flashQuery.slice(0, -1) + "'");
            windowState.flashQuery = windowState.flashQuery.slice(0, -1);
            recompute(root, view);
        } else {
            Logger.debug("TreeFlash", "Backspace → empty query, cancel flash");
            view.currentIndex = root._preFlashIndex;
            view.positionViewAtIndex(view.currentIndex, ListView.Contain);
            windowState.clearFlash();
        }
        event.accepted = true;
        return;
    }

    var ch = event.text.toLowerCase();
    if (ch === "") {
        Logger.debug("TreeFlash", "Ignored non-printable key=" + key + " text='" + event.text + "'");
        event.accepted = true;
        return;
    }

    if (Logger.minLevel <= Logger.levelDebug) {
        Logger.debug("TreeFlash", "Keypress '" + ch + "' | query='" + windowState.flashQuery
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
                Logger.info("TreeFlash", "2-char label '" + fullLabel + "' → jump index=" + pending[i].index + " " + pending[i].name);
                _jump(view, pending[i].index);
                windowState.clearFlash();
                event.accepted = true;
                return;
            }
        }
        Logger.debug("TreeFlash", "Invalid 2-char label '" + fullLabel + "' — ignored");
        event.accepted = true;
        return;
    }

    // Check if char is a label
    if (windowState.flashLabelChars[ch]) {
        var matches = windowState.flashMatches;
        // Try exact 1-char label
        for (var j = 0; j < matches.length; j++) {
            if (matches[j].label === ch) {
                Logger.info("TreeFlash", "Label '" + ch + "' → jump index=" + matches[j].index + " " + matches[j].name);
                _jump(view, matches[j].index);
                windowState.clearFlash();
                event.accepted = true;
                return;
            }
        }
        // Check if first char of any 2-char label
        for (var k = 0; k < matches.length; k++) {
            if (matches[k].label.length === 2 && matches[k].label[0] === ch) {
                Logger.debug("TreeFlash", "'" + ch + "' is 2-char label prefix → waiting for second char");
                windowState.flashPendingLabel = ch;
                event.accepted = true;
                return;
            }
        }
    }

    // Continuation (or first char of an empty query) → extend
    if (windowState.flashQuery === "" || windowState.flashContinuations[ch]) {
        Logger.debug("TreeFlash", "Continuation '" + ch + "' → query becomes '" + windowState.flashQuery + ch + "'");
        windowState.flashQuery += ch;
        recompute(root, view);
        event.accepted = true;
        return;
    }

    // Neither label nor continuation — drop
    Logger.warn("TreeFlash", "'" + ch + "' is neither label nor continuation — dropped");
    event.accepted = true;
}

function _jump(view, index) {
    view.currentIndex = index;
    view.positionViewAtIndex(index, ListView.Contain);
}

function _buildAllEntries(root) {
    var allEntries = [];
    var rows = root._rows;
    for (var i = 0; i < rows.length; i++) {
        allEntries.push({
            name:   rows[i].name,
            column: "current",
            index:  i
        });
    }
    return allEntries;
}

function recompute(root, view) {
    var windowState = root.windowState;
    var query = windowState.flashQuery.toLowerCase();
    if (query === "") {
        windowState.flashMatches = [];
        windowState.flashLabelChars = {};
        windowState.flashContinuations = {};
        windowState.flashCurrentMatchMap = {};
        return;
    }

    if (!_cachedAllEntries)
        _cachedAllEntries = _buildAllEntries(root);

    // FlashLogic is in scope via FileTreeView.qml's `import "FlashLogic.js" as FlashLogic`
    var result = FlashLogic.computeFlash(query, _cachedAllEntries, view.currentIndex);
    windowState.flashMatches = result.matches;
    windowState.flashLabelChars = result.labelChars;
    windowState.flashContinuations = result.continuations;

    var currentMap = {};
    for (var m = 0; m < result.matches.length; m++)
        currentMap[result.matches[m].index] = result.matches[m];
    windowState.flashCurrentMatchMap = currentMap;

    if (Logger.minLevel <= Logger.levelDebug) {
        var contKeys = Object.keys(result.continuations).join("");
        var labelKeys = Object.keys(result.labelChars).join("");
        var labelList = result.matches.map(function(entry) { return entry.label + "→" + entry.name.substring(0, 15); }).join(", ");
        Logger.debug("TreeFlash", "Recompute query='" + query + "' | entries=" + _cachedAllEntries.length
            + " | matches=" + result.matches.length
            + " | continuations=[" + contKeys + "] | labelPool=[" + labelKeys + "]"
            + " | labels: " + labelList);
    }
}

// Flash-label rendering — kept intentionally identical to FileListItem._highlightFlash
// so the visual is the same across Miller and Tree views. Both are independent copies
// pending consolidation into a shared FlashRenderHelper.js (tracked as tech-debt).
// Lives here (a non-`.pragma library` handler) rather than in FlashLogic.js because
// it reads FmTheme palette/font tokens, which resolve through the importing file's
// QML scope (FileTreeView.qml and FileTreeRow.qml both import this handler and the
// UI module that provides FmTheme). A `.pragma library` script has no QML scope
// and could not see FmTheme.
function htmlEscape(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function highlightFlash(name, query, label, matchStart) {
    if (matchStart < 0 || query === "" || label === "")
        return htmlEscape(name);
    var before = name.substring(0, matchStart);
    var match = name.substring(matchStart, matchStart + query.length);
    var afterMatchStart = matchStart + query.length;
    var replacedEnd = Math.min(afterMatchStart + label.length, name.length);
    var after = name.substring(replacedEnd);
    var querySpan = "<span style=\"background-color: " + FmTheme.palette.secondaryContainer
                    + "; color: " + FmTheme.palette.onSecondaryContainer + ";\">"
                    + htmlEscape(match) + "</span>";
    var labelSpan = "<span style=\"background-color: " + FmTheme.palette.primary
                    + "; color: " + FmTheme.palette.onPrimary
                    + "; font-weight: 700; font-family: " + FmTheme.font.family.mono + ";\">"
                    + htmlEscape(label) + "</span>";
    return htmlEscape(before) + querySpan + labelSpan + htmlEscape(after);
}
