// Search matching and cursor positioning.
//
// Non-library JS — shares the QML component scope of the importing file
// (FileList.qml).  All component-specific references are passed explicitly
// as function parameters; QML singletons are accessed through scope.
// Component IDs accessed via scope: fsModel.

function computeMatches(root, view, preservePosition) {
    var windowState = root.windowState;
    var query = windowState.searchQuery.toLowerCase();
    if (query === "") {
        windowState.matchIndices = [];
        windowState.currentMatchIndex = -1;
        return;
    }

    var entries = fsModel.entries;
    var indices = [];
    for (var i = 0; i < entries.length; i++) {
        if (entries[i].name.toLowerCase().indexOf(query) !== -1)
            indices.push(i);
    }

    windowState.matchIndices = indices;

    if (indices.length === 0) {
        windowState.currentMatchIndex = -1;
    } else if (preservePosition) {
        var previousTarget = view.currentIndex;
        var newPos = indices.indexOf(previousTarget);
        windowState.currentMatchIndex = newPos >= 0 ? newPos : 0;
    } else {
        windowState.currentMatchIndex = 0;
    }

    // Always jump after recomputing — the onChanged signal won't fire
    // when currentMatchIndex stays at the same numeric value (e.g. 0→0)
    // even though matchIndices changed and the target file is different.
    jumpToCurrentMatch(root, view);
}

function jumpToCurrentMatch(root, view) {
    var idx = root.windowState.currentMatchIndex;
    var matches = root.windowState.matchIndices;
    if (idx >= 0 && idx < matches.length) {
        view.currentIndex = matches[idx];
        view.positionViewAtIndex(view.currentIndex, ListView.Contain);
    }
}
