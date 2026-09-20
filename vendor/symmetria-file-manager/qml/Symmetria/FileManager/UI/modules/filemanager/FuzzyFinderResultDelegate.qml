pragma ComponentBehavior: Bound

// FuzzyFinderResultDelegate — one result row in the FuzzyFinderPopup's ListView.
//
// Displays a themed file icon, a bold filename label (clipped at 55% of the row
// width), and a dim italic parent-path label (fillWidth). Both labels switch
// between RichText+clip (when there are fuzzy-match highlights) and
// PlainText+elide (when there are none), because Qt's Text element cannot
// reliably elide RichText.
//
// The two helper functions (_trimTrailingSlash, _highlightRange) live here so
// this component is self-contained; _htmlEscape is shared via HighlightUtils.js
// (also used by FileListItem) and keeps the popup file under the 500-line gate.

import Symmetria.FileManager.UI
import QtQuick
import QtQuick.Layouts
import "handlers/HighlightUtils.js" as HighlightUtils

StyledRect {
    id: root

    // Required model roles — injected automatically by ListView (ComponentBehavior: Bound).
    required property int index
    required property string path
    required property string name
    required property bool isDir
    required property string fullPath
    required property var matchIndices
    required property string iconPath

    // The currently highlighted row index in the parent popup — determines
    // selection color. Bound at the delegate site by FuzzyFinderPopup.
    required property int selectedIndex

    // Emitted when the user clicks this row. The popup handles both updating
    // selectedIndex and confirming the selection (open file / navigate dir).
    signal activated()

    // Path with any trailing dir-slash removed, plus the index at which the
    // filename segment begins — the single split point both label halves use.
    readonly property string _trimmedPath:
        root._trimTrailingSlash(root.path, root.isDir)
    // _nameStart = 0 when the file is at the root of the search tree
    // (name === trimmedPath). Math.max(0, ...) guards against negative values —
    // if name is somehow longer than trimmedPath, the whole trimmedPath is
    // treated as the filename.
    readonly property int _nameStart:
        Math.max(0, _trimmedPath.length - root.name.length)

    // Highlighting forces RichText, which Qt's Text cannot reliably elide —
    // so the two labels switch between RichText+clip (matches) and
    // PlainText+elide (no match). Raw substrings feed the plain case (the
    // highlighter HTML-escapes, which would leak literal &amp; into
    // un-highlighted text).
    readonly property bool _hasMatch:
        root.matchIndices && root.matchIndices.length > 0
    readonly property string _nameText: _trimmedPath.substring(_nameStart)
    readonly property string _prefixText: _trimmedPath.substring(0, _nameStart)

    width: ListView.view ? ListView.view.width : 0
    radius: FmTheme.rounding.sm
    color: root.index === root.selectedIndex
        ? Qt.alpha(FmTheme.palette.primary, 0.15)
        : "transparent"
    implicitHeight: resultRow.implicitHeight + FmTheme.padding.sm * 2

    Behavior on color {
        CAnim {}
    }

    RowLayout {
        id: resultRow

        anchors.left: parent.left
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        anchors.leftMargin: FmTheme.padding.md
        anchors.rightMargin: FmTheme.padding.md
        spacing: FmTheme.spacing.md

        // Themed file/folder icon (real Symmetria icon when iconMode is
        // "system"; Material glyph otherwise).
        FileIcon {
            iconPath: root.iconPath
            materialIconName: root.isDir ? "folder" : "description"
            materialColor: root.isDir
                ? FmTheme.palette.primary
                : FmTheme.palette.onSurfaceVariant
            materialFill: root.isDir ? 1 : 0
            materialPointSize: FmTheme.font.size.md
            Layout.preferredWidth: implicitWidth
            Layout.preferredHeight: implicitHeight
        }

        // Filename — emphasised (bold, full-contrast). Capped so a pathological
        // name can't crowd out the parent path; clip (match) or ElideRight (no
        // match) keeps it strictly inside that cap — never painting over the path.
        StyledText {
            Layout.fillWidth: false
            Layout.maximumWidth: resultRow.width * 0.55
            text: root._hasMatch
                ? root._highlightRange(
                    root._trimmedPath, root.matchIndices,
                    root._nameStart, root._trimmedPath.length)
                : root._nameText
            textFormat: root._hasMatch ? Text.RichText : Text.PlainText
            clip: root._hasMatch
            elide: root._hasMatch ? Text.ElideNone : Text.ElideRight
            color: root.index === root.selectedIndex
                ? FmTheme.palette.onSurface
                : FmTheme.palette.onSurfaceVariant
            font.pointSize: FmTheme.font.size.sm
            font.family: FmTheme.font.family.mono
            font.weight: Font.DemiBold
        }

        // Parent path — de-emphasised (smaller, dim, italic).
        // No match → ElideLeft (keeps the directories nearest the file).
        // Match → RichText can't elide, so clip; the fillWidth box bounds it
        // so it can't overflow either.
        StyledText {
            // MUST stay visible even when empty (root-level files have no
            // parent path). It is the row's only Layout.fillWidth item; hiding
            // it removes the slack consumer, and QtQuick.Layouts then floats
            // the (fillWidth:false) filename to CENTER instead of left. Empty
            // text renders nothing but keeps the row left-packed.
            // See the FileIcon-era layout fix in FuzzyFinderPopup.
            Layout.fillWidth: true
            text: root._hasMatch
                ? root._highlightRange(
                    root._trimmedPath, root.matchIndices,
                    0, root._nameStart)
                : root._prefixText
            textFormat: root._hasMatch ? Text.RichText : Text.PlainText
            clip: root._hasMatch
            elide: root._hasMatch ? Text.ElideNone : Text.ElideLeft
            color: FmTheme.palette.onSurfaceVariant
            font.pointSize: FmTheme.font.size.xs
            font.family: FmTheme.font.family.mono
            font.italic: true
        }
    }

    StateLayer {
        onClicked: root.activated()
    }

    // ── Helper functions ───────────────────────────────────────────────────

    // A directory's path/fullPath carries a trailing "/" (fff convention);
    // its name role is the bare last segment. Strip the slash so the name
    // split lines up — for files the path is returned unchanged.
    function _trimTrailingSlash(path: string, isDir: bool): string {
        return (isDir && path.endsWith("/")) ? path.slice(0, -1) : path;
    }

    // Emit highlighted HTML for the slice text[start, end). `indices` are
    // absolute character positions into `text` (the fuzzy-match positions),
    // so the same index set drives both the filename and parent-path halves
    // without re-basing — each call just renders its own range.
    function _highlightRange(text: string, indices: var, start: int, end: int): string {
        const hasIndices = indices && indices.length > 0;

        // Build a set of highlighted positions for O(1) lookup.
        const highlighted = {};
        if (hasIndices)
            for (let i = 0; i < indices.length; i++)
                highlighted[indices[i]] = true;

        const spanOpen = "<span style=\"background-color: " + FmTheme.palette.secondaryContainer
                       + "; color: " + FmTheme.palette.onSecondaryContainer + ";\">";
        const spanClose = "</span>";

        let result = "";
        let inSpan = false;
        for (let i = start; i < end; i++) {
            const on = hasIndices && highlighted[i] === true;
            if (on && !inSpan) {
                result += spanOpen;
                inSpan = true;
            } else if (!on && inSpan) {
                result += spanClose;
                inSpan = false;
            }
            result += HighlightUtils.htmlEscape(text[i]);
        }
        if (inSpan)
            result += spanClose;

        return result;
    }

}
