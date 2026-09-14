pragma ComponentBehavior: Bound

import Symmetria.FileManager.UI
import Symmetria.FileManager.Models
import QtQuick
import QtQuick.Layouts
import "handlers/HighlightUtils.js" as HighlightUtils

Item {
    id: root

    required property int index
    required property FileSystemEntry modelData
    property string searchQuery: ""

    signal activated()

    function _highlightMatches(name: string, query: string): string {
        if (query === "")
            return name;

        const lowerName = name.toLowerCase();
        const lowerQuery = query.toLowerCase();
        const qLen = query.length;
        const spanOpen = "<span style=\"background-color: " + FmTheme.palette.secondaryContainer
                       + "; color: " + FmTheme.palette.onSecondaryContainer + ";\">";
        const spanClose = "</span>";

        let result = "";
        let pos = 0;
        let matchPos;
        while ((matchPos = lowerName.indexOf(lowerQuery, pos)) !== -1) {
            result += HighlightUtils.htmlEscape(name.substring(pos, matchPos));
            result += spanOpen + HighlightUtils.htmlEscape(name.substring(matchPos, matchPos + qLen)) + spanClose;
            pos = matchPos + qLen;
        }
        result += HighlightUtils.htmlEscape(name.substring(pos));
        return result;
    }

    function _highlightFlash(name: string, query: string, label: string, matchStart: int): string {
        if (matchStart < 0 || query === "" || label === "")
            return HighlightUtils.htmlEscape(name);

        const before = name.substring(0, matchStart);
        const match = name.substring(matchStart, matchStart + query.length);
        const afterMatchStart = matchStart + query.length;
        const replacedEnd = Math.min(afterMatchStart + label.length, name.length);
        const after = name.substring(replacedEnd);

        const querySpan = "<span style=\"background-color: " + FmTheme.palette.secondaryContainer
                        + "; color: " + FmTheme.palette.onSecondaryContainer + ";\">"
                        + HighlightUtils.htmlEscape(match) + "</span>";

        const labelSpan = "<span style=\"background-color: " + FmTheme.palette.primary
                        + "; color: " + FmTheme.palette.onPrimary
                        + "; font-weight: 700; font-family: " + FmTheme.font.family.mono + ";\">"
                        + HighlightUtils.htmlEscape(label) + "</span>";

        return HighlightUtils.htmlEscape(before) + querySpan + labelSpan + HighlightUtils.htmlEscape(after);
    }

    property bool isSearchMatch: false
    property bool isSelected: false

    // Flash navigation
    property bool flashActive: false
    property string flashQuery: ""
    property string flashLabel: ""
    property int flashMatchStart: -1
    readonly property bool isFlashMatch: flashActive && flashLabel !== ""

    // Optional per-row badge data. The list owns the version counter and bumps
    // it whenever the provider emits statusChanged; this delegate reads both
    // statusProvider AND statusVersion so the binding re-evaluates on every
    // update. Null provider (default) renders no badge.
    property var statusProvider: null
    property int statusVersion: 0

    implicitHeight: Config.fileManager.sizes.itemHeight

    // NO zebra striping. Even rows used to take a faint gray lift for the
    // GNOME-Files look; it was removed with the flat-aesthetic move (user
    // decision). Over a near-black base the alternation read as banding rather
    // than as a reading aid. Mirrored in FileTreeRow, so the Miller list and
    // the tree stay identical; change both or neither.

    // Search match highlight — subtle gray tint behind matching rows
    Rectangle {
        anchors.fill: parent
        anchors.leftMargin: FmTheme.padding.sm
        anchors.rightMargin: FmTheme.padding.sm
        radius: FmTheme.rounding.full
        color: FmTheme.palette.onSurface
        opacity: root.isSearchMatch ? 0.06 : 0
        Behavior on opacity { Anim {} }
    }

    // Selection highlight — matte pill for active item
    // Separate Rectangle avoids StyledRect's color animation
    // which would cause visible stutter during rapid j/k navigation
    Rectangle {
        id: selectionHighlight

        anchors.fill: parent
        anchors.leftMargin: FmTheme.padding.sm
        anchors.rightMargin: FmTheme.padding.sm
        radius: FmTheme.rounding.full
        color: FmTheme.pillStrong.background
        border.color: FmTheme.pillStrong.border
        border.width: root.ListView.isCurrentItem ? 1 : 0
        opacity: root.ListView.isCurrentItem ? 1 : 0

        // ⚠ NO rim highlight. A child Rectangle used to paint a white 0.08 →
        // transparent top gradient here — the "lit-from-above" cue that is the
        // single strongest claymorphism signal — and it was REMOVED with the
        // flat-aesthetic move (user decision).
        //
        // It is worth knowing why this one outlived the rest of the clay. The
        // depth recipe elsewhere lives in `PillSurface`, so zeroing
        // `Theme.depth`'s alphas flattened every surface that used it in one
        // edit. This gradient was inlined ON PURPOSE — a per-row PillSurface
        // would add colour animation and two GPU shadow nodes to every visible
        // row, which stutters during rapid j/k navigation — so it was invisible
        // to that change and kept rendering a clay pill after the whole rest of
        // the app had gone flat. The lesson generalises: a performance
        // exception that copies a visual recipe also opts out of the recipe's
        // single point of change.
        //
        // The matte fill + hairline border below stay; they are what marks the
        // row as current now.
    }

    // Clipboard indicator strip — left edge, above selection highlight.
    IndicatorStrip {
        stripColor: FileManagerService.clipboardMode === "cut" ? FmTheme.indicator.cut : FmTheme.indicator.yank
        // Read _clipboardSet directly so QML tracks the dependency and
        // re-evaluates when the set object reference changes.
        active: !!FileManagerService._clipboardSet[root.modelData?.path ?? ""]
    }

    // Selection indicator strip — left edge, yellow. Takes precedence visually
    // when both are present (selection is the active user intent).
    IndicatorStrip {
        stripColor: FmTheme.indicator.selection
        active: root.isSelected
    }

    StateLayer {
        // Root is a plain Item (no radius), so StateLayer's parent?.radius
        // fallback yields a square hover — shape it to match the selection
        // pill above (same side insets, full rounding).
        anchors.leftMargin: FmTheme.padding.sm
        anchors.rightMargin: FmTheme.padding.sm
        radius: FmTheme.rounding.full

        onClicked: root.ListView.view.currentIndex = root.index

        onDoubleClicked: root.activated()
    }

    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: FmTheme.padding.lg
        anchors.rightMargin: FmTheme.padding.lg
        spacing: FmTheme.spacing.md
        opacity: root.flashActive && !root.isFlashMatch ? 0.25 : 1.0
        Behavior on opacity { Anim {} }

        // File/folder icon
        FileIcon {
            iconPath: root.modelData?.iconPath ?? ""
            materialIconName: {
                if (!root.modelData)
                    return "description";
                if (root.modelData.isDir)
                    return "folder";
                if (root.modelData.isImage)
                    return "image";
                return FileManagerService.iconNameForMime(root.modelData.mimeType);
            }
            materialColor: root.modelData?.isDir ? FmTheme.palette.primary : FmTheme.palette.onSurfaceVariant
            materialFill: root.modelData?.isDir ? 1 : 0
            Layout.preferredWidth: implicitWidth
            Layout.preferredHeight: implicitHeight
        }

        // Remote mount indicator — inline network icon for SSHFS/NFS/FUSE mount points
        MaterialIcon {
            visible: root.modelData?.isRemoteMount ?? false
            text: "lan"
            color: FmTheme.palette.primary
            font.pointSize: FmTheme.font.size.xs
        }

        // File name
        StyledText {
            Layout.fillWidth: !(root.modelData?.isSymlink ?? false)
            clip: root.isSearchMatch || root.isFlashMatch
            textFormat: (root.isSearchMatch || root.isFlashMatch) ? Text.RichText : Text.PlainText
            elide: (root.isSearchMatch || root.isFlashMatch) ? Text.ElideNone : Text.ElideRight
            text: {
                const name = root.modelData?.name ?? "";
                if (root.isFlashMatch)
                    return root._highlightFlash(name, root.flashQuery, root.flashLabel, root.flashMatchStart);
                if (root.isSearchMatch)
                    return root._highlightMatches(name, root.searchQuery);
                return name;
            }
            color: FmTheme.palette.onSurface
            font.pointSize: FmTheme.font.size.md
        }

        // Symlink target indicator
        StyledText {
            visible: root.modelData?.isSymlink ?? false
            Layout.fillWidth: true
            text: "→ " + Paths.shortenHomeBare(root.modelData?.symlinkTarget ?? "")
            color: FmTheme.palette.outline
            font.pointSize: FmTheme.font.size.xs
            elide: Text.ElideMiddle
        }

        // Git status badge — populated when statusProvider is wired and
        // returns non-null for this row's path. Placed before the size column
        // so it sits at the right edge of the name region for both files
        // (which have a size column) and directories (which don't).
        Loader {
            id: statusBadgeLoader
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
            Layout.alignment: Qt.AlignVCenter
            sourceComponent: GitStatusBadge {
                status: statusBadgeLoader._badge
            }
        }

        // File size (hidden for directories)
        StyledText {
            visible: !(root.modelData?.isDir ?? true)
            text: root.modelData ? FileManagerService.formatSize(root.modelData.size) : ""
            color: FmTheme.palette.onSurfaceVariant
            font.pointSize: FmTheme.font.size.xs
            font.family: FmTheme.font.family.mono
            horizontalAlignment: Text.AlignRight
            Layout.minimumWidth: 50
        }
    }

}
