.pragma library

// Flash navigation label computation — port of Flash.nvim's core algorithm.
//
// Labels are assigned ONLY from characters that cannot continue any current
// match, making the search→jump transition implicit: if a keypress is a label
// it jumps, if it's a continuation it extends the query.

// Home-row-optimized label character pool (same priority order as Flash.nvim).
var LABEL_CHARS = "asdfghjklqwertyuiopzxcvbnm";

// Compute flash matches and labels for a given query across all columns.
//
// Parameters:
//   query       — current flash search string (already lowercase)
//   allEntries  — array of { name, column, index, path, isDir }
//                  column: "current" | "preview" | "parent"
//   cursorIndex — cursor position in the "current" column (for priority sort)
//
// Returns: {
//   matches:       [{ name, column, index, path, isDir, label, matchStart }],
//   continuations: { char: true },   // chars that could extend the query
//   labelChars:    { char: true }    // chars assigned as labels
// }
function computeFlash(query, allEntries, cursorIndex) {
    if (query === "")
        return { matches: [], continuations: {}, labelChars: {} };

    // 1. Find all matching entries (case-insensitive substring)
    var matches = [];
    for (var i = 0; i < allEntries.length; i++) {
        var entry = allEntries[i];
        var lowerName = entry.name.toLowerCase();
        var pos = lowerName.indexOf(query);
        if (pos !== -1) {
            matches.push({
                name:       entry.name,
                column:     entry.column,
                index:      entry.index,
                path:       entry.path,
                isDir:      entry.isDir,
                label:      "",
                matchStart: pos
            });
        }
    }

    if (matches.length === 0)
        return { matches: [], continuations: {}, labelChars: {} };

    // 2. Collect continuation characters — the char immediately after EVERY
    //    occurrence of query in EVERY matching name. These chars CANNOT be labels.
    var continuations = _continuationChars(query, matches);

    // Also exclude characters present in the query itself to avoid visual confusion
    for (var qi = 0; qi < query.length; qi++)
        continuations[query[qi]] = true;

    // 3. Build available label pool (preserving home-row priority order)
    var available = [];
    for (var li = 0; li < LABEL_CHARS.length; li++) {
        var ch = LABEL_CHARS[li];
        if (!continuations[ch])
            available.push(ch);
    }

    // 4. Sort matches by priority: current (closest to cursor) → preview → parent
    matches = _sortByPriority(matches, cursorIndex);

    // 5. Assign labels
    var labelChars = _assignLabels(matches, available);

    return {
        matches:       matches,
        continuations: continuations,
        labelChars:    labelChars
    };
}

// Collect characters that appear immediately after every occurrence of query
// in every matching entry's name. Returns an object used as a set.
function _continuationChars(query, matches) {
    var chars = {};
    var qLen = query.length;

    for (var i = 0; i < matches.length; i++) {
        var lowerName = matches[i].name.toLowerCase();
        var searchFrom = 0;
        var pos;
        // Find ALL occurrences, not just the first
        while ((pos = lowerName.indexOf(query, searchFrom)) !== -1) {
            var afterPos = pos + qLen;
            if (afterPos < lowerName.length)
                chars[lowerName[afterPos]] = true;
            searchFrom = pos + 1;
        }
    }

    return chars;
}

// Sort matches: current column by distance from cursor, then preview, then parent.
function _sortByPriority(matches, cursorIndex) {
    var columnOrder = { "current": 0, "preview": 1, "parent": 2 };

    matches.sort(function(a, b) {
        var colA = columnOrder[a.column];
        var colB = columnOrder[b.column];
        if (colA !== colB)
            return colA - colB;

        // Within same column, sort by distance from cursor (current) or by index
        if (a.column === "current") {
            var distA = Math.abs(a.index - cursorIndex);
            var distB = Math.abs(b.index - cursorIndex);
            return distA - distB;
        }

        return a.index - b.index;
    });

    return matches;
}

// Assign labels to sorted matches from the available character pool.
// Returns a set of all characters used as labels (for O(1) lookup).
function _assignLabels(matches, available) {
    var labelChars = {};
    var assignedCount = 0;

    // Phase 1: single-char labels for as many matches as possible
    var singleLimit = Math.min(matches.length, available.length);
    for (var i = 0; i < singleLimit; i++) {
        matches[i].label = available[i];
        labelChars[available[i]] = true;
        assignedCount++;
    }

    // Phase 2: 2-char labels if we ran out of single chars.
    // CRITICAL: 2-char label prefixes must NOT overlap with 1-char labels,
    // otherwise the 1-char match always wins and 2-char targets are unreachable.
    if (assignedCount < matches.length && available.length >= 2) {
        var usedAsSingle = {};
        for (var u = 0; u < singleLimit; u++)
            usedAsSingle[available[u]] = true;

        // Only chars NOT already used as 1-char labels can be 2-char prefixes
        var twoCharPrefixes = [];
        for (var p = 0; p < available.length; p++) {
            if (!usedAsSingle[available[p]])
                twoCharPrefixes.push(available[p]);
        }

        // If twoCharPrefixes is empty (all available chars were used as 1-char labels),
        // the outer loop never executes and remaining matches stay unlabeled — they simply
        // won't have a jump target. This is expected graceful degradation.
        var twoCharIdx = assignedCount;
        for (var first = 0; first < twoCharPrefixes.length && twoCharIdx < matches.length; first++) {
            for (var second = 0; second < available.length && twoCharIdx < matches.length; second++) {
                if (twoCharPrefixes[first] === available[second])
                    continue;

                var label = twoCharPrefixes[first] + available[second];
                matches[twoCharIdx].label = label;
                labelChars[twoCharPrefixes[first]] = true;
                labelChars[available[second]] = true;
                twoCharIdx++;
            }
        }
    }

    return labelChars;
}
