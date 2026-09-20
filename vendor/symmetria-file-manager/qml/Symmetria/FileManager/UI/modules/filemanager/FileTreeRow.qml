pragma ComponentBehavior: Bound

// FileTreeView's ListView delegate — one flattened tree row. Pure presentation:
// it renders indent guides, the search-match / current-item / flash highlights,
// the file icon + name, and the optional git-status badge + line-delta accessory
// from the row data the parent (FileTreeView) supplies. The parent owns all
// state; this row reads it through bound inputs and emits `activated()` on
// double-click so the parent decides what activation means (toggle dir vs. open
// file). Single-click current-index changes are handled here via the ListView
// attached object, exactly as FileListItem does.

import Symmetria.FileManager.UI
import "handlers/TreeFlashHandler.js" as TreeFlashHandler
import QtQuick

Item {
    id: root

    // Auto-injected by the ListView for each row.
    required property int index
    required property var modelData

    // Inputs bound at the delegate site by FileTreeView.
    property WindowState windowState: null
    property real compactScale: 1.0
    property int indentPixels: 16
    property var statusProvider: null
    property int statusVersion: 0

    readonly property int rowDepth: modelData ? modelData.depth : 0
    readonly property bool rowIsDir: modelData ? modelData.isDir : false
    readonly property bool rowExpanded: modelData ? modelData.expanded : false

    // Flash match for THIS row's index (null if not a match or flash inactive).
    readonly property var _flashMatch: windowState && windowState.flashActive
        ? windowState.flashCurrentMatchMap[root.index] : null
    readonly property bool _isFlashMatch: !!_flashMatch

    signal activated()

    width: ListView.view ? ListView.view.width : 0
    implicitHeight: Config.fileManager.sizes.itemHeight * root.compactScale

    // NO zebra striping. Even rows used to take a faint gray lift so adjacent
    // rows separated visually; it was removed with the flat-aesthetic move
    // (user decision). Over a near-black base the alternation read as banding
    // rather than as a reading aid, and the tree is quieter without it — row
    // separation is carried by the indent guides and the row spacing instead.
    // Mirrored in FileListItem, so the tree and the Miller list stay identical;
    // change both or neither. Restoring it is a revert of one commit.

    // Search-match tint (rendered beneath the current-item highlight)
    Rectangle {
        anchors.fill: parent
        anchors.leftMargin: FmTheme.padding.sm
        anchors.rightMargin: FmTheme.padding.sm
        radius: FmTheme.rounding.sm
        color: FmTheme.palette.primary
        opacity: root.windowState && root.windowState._matchIndexSet[root.index] ? 0.08 : 0
        Behavior on opacity { Anim {} }
    }

    Rectangle {
        anchors.fill: parent
        anchors.leftMargin: FmTheme.padding.sm
        anchors.rightMargin: FmTheme.padding.sm
        radius: FmTheme.rounding.sm
        color: FmTheme.palette.secondaryContainer
        opacity: root.ListView.isCurrentItem ? 0.35 : 0
        Behavior on opacity { Anim {} }
    }

    Repeater {
        model: root.rowDepth
        delegate: Rectangle {
            required property int index
            width: 1
            height: root.height
            x: index * root.indentPixels + FmTheme.padding.lg * root.compactScale
            color: FmTheme.palette.outlineVariant
            opacity: 0.4
        }
    }

    Row {
        x: root.rowDepth * root.indentPixels + FmTheme.padding.lg * root.compactScale
        anchors.verticalCenter: parent.verticalCenter
        spacing: FmTheme.spacing.md * root.compactScale

        // Dim non-matching rows during flash so labels stand out.
        opacity: root.windowState && root.windowState.flashActive && !root._isFlashMatch ? 0.25 : 1.0
        Behavior on opacity { Anim {} }

        MaterialIcon {
            anchors.verticalCenter: parent.verticalCenter
            visible: root.rowIsDir
            text: root.rowExpanded ? "expand_more" : "chevron_right"
            color: FmTheme.palette.onSurfaceVariant
            font.pointSize: FmTheme.font.size.md * root.compactScale
        }
        Item {
            visible: !root.rowIsDir
            width: FmTheme.font.size.md * root.compactScale
            height: 1
        }
        FileIcon {
            anchors.verticalCenter: parent.verticalCenter
            width: FmTheme.font.size.xl * 1.5 * root.compactScale
            height: FmTheme.font.size.xl * 1.5 * root.compactScale
            materialPointSize: FmTheme.font.size.xl * root.compactScale
            iconPath: root.modelData?.entry?.iconPath ?? ""
            materialIconName: {
                if (!root.modelData) return "description";
                const e = root.modelData.entry;
                if (!e) return "description";
                if (e.isDir) return "folder";
                if (e.isImage) return "image";
                return FileManagerService.iconNameForMime(e.mimeType);
            }
            materialColor: root.rowIsDir
                           ? FmTheme.palette.primary
                           : FmTheme.palette.onSurfaceVariant
            materialFill: root.rowIsDir ? 1 : 0
        }
        StyledText {
            anchors.verticalCenter: parent.verticalCenter
            textFormat: root._isFlashMatch ? Text.RichText : Text.PlainText
            text: {
                const name = root.modelData ? root.modelData.name : "";
                if (root._isFlashMatch && root.windowState)
                    return TreeFlashHandler.highlightFlash(name, root.windowState.flashQuery,
                                                           root._flashMatch.label,
                                                           root._flashMatch.matchStart);
                return name;
            }
            color: FmTheme.palette.onSurface
            font.pointSize: FmTheme.font.size.md * root.compactScale
        }
        Loader {
            id: statusBadgeLoader
            anchors.verticalCenter: parent.verticalCenter
            // Read statusVersion to register the binding dependency — bumping the
            // counter (via the parent's Connections.onStatusChanged) forces a
            // re-query of the provider here. The void expression keeps the
            // dependency live without affecting the returned value.
            readonly property var _badge: {
                const _tick = root.statusVersion;
                void _tick;
                if (!root.statusProvider) return null;
                if (!root.modelData) return null;
                try {
                    return root.statusProvider.statusForPath(root.modelData.path);
                } catch (e) {
                    // Provider threw — degrade gracefully, no badge.
                    return null;
                }
            }
            active: _badge !== null
            sourceComponent: GitStatusBadge {
                status: statusBadgeLoader._badge
            }
        }
        // Optional inline `+adds -dels` accessory. Reads from the
        // SAME `_badge` object the badge Loader already computed
        // — no second `statusForPath` call. Active only when the
        // provider supplied at least one non-zero count, so the
        // standalone FM (whose provider doesn't set these
        // fields) renders nothing here at zero cost.
        Loader {
            id: deltaLoader
            anchors.verticalCenter: parent.verticalCenter
            // Cache the badge snapshot on the Loader itself so the
            // sourceComponent's bindings read a stable local property
            // rather than traversing back to statusBadgeLoader._badge
            // on every evaluation. This also eliminates the null-race
            // window where active flips to true but _badge transitions
            // to null before the inner bindings evaluate — the
            // sourceComponent reads _delta which holds the snapshot
            // captured at the same time active was computed.
            readonly property var _delta: statusBadgeLoader._badge
            active: _delta !== null && _delta !== undefined
                && ((_delta.adds || 0) > 0
                    || (_delta.dels || 0) > 0)
            sourceComponent: Row {
                spacing: FmTheme.spacing.sm * root.compactScale
                StyledText {
                    visible: (deltaLoader._delta ? deltaLoader._delta.adds : 0) > 0
                    text: "+" + (deltaLoader._delta ? deltaLoader._delta.adds : 0)
                    color: FmTheme.gitStatus.addsGreen
                    font.pointSize: FmTheme.font.size.sm * root.compactScale
                }
                StyledText {
                    visible: (deltaLoader._delta ? deltaLoader._delta.dels : 0) > 0
                    text: "-" + (deltaLoader._delta ? deltaLoader._delta.dels : 0)
                    color: FmTheme.gitStatus.delsRed
                    font.pointSize: FmTheme.font.size.sm * root.compactScale
                }
            }
        }
    }

    // Clipboard indicator strip — left edge, mirrors FileListItem so yank/cut
    // marks stay visible when the user switches views mid-operation.
    IndicatorStrip {
        stripColor: FileManagerService.clipboardMode === "cut" ? FmTheme.indicator.cut : FmTheme.indicator.yank
        // Read _clipboardSet directly so QML tracks the dependency and
        // re-evaluates when the set object reference changes.
        active: !!FileManagerService._clipboardSet[root.modelData?.path ?? ""]
    }

    // Selection indicator strip — left edge, yellow. Takes precedence visually
    // when both are present (selection is the active user intent). Unlike
    // FileListItem (which takes an `isSelected` bound input from FileList's
    // delegate site), this row reads selectedPaths directly — it already holds
    // a windowState reference, so an extra pass-through input adds nothing.
    IndicatorStrip {
        stripColor: FmTheme.indicator.selection
        active: root.windowState && root.windowState.selectedPaths
                ? !!root.windowState.selectedPaths[root.modelData?.path ?? ""] : false
    }

    StateLayer {
        // Root is a plain Item (no radius), so StateLayer's parent?.radius
        // fallback yields a square hover — shape it to match the search-match
        // and current-item rectangles above (same side insets, sm rounding).
        anchors.leftMargin: FmTheme.padding.sm
        anchors.rightMargin: FmTheme.padding.sm
        radius: FmTheme.rounding.sm

        onClicked: root.ListView.view.currentIndex = root.index
        onDoubleClicked: root.activated()
    }
}
