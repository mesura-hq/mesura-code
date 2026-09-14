pragma ComponentBehavior: Bound

// Left-edge indicator strip for file-row delegates (clipboard yank/cut mark,
// Space-selection mark). Self-anchors to the parent delegate's left edge and
// full height; the caller only supplies the color and the active flag.
//
// The inner Rectangle is wider than the clipped Item so only its LEFT corners
// read as rounded — the right side is cut flat against the row content.
//
// Colors are hardcoded by callers (FmTheme.indicator.*) instead of palette
// tokens because palette tokens change with wallpaper-derived color schemes,
// so indicator colors must stay fixed to remain visually distinguishable.

import Symmetria.FileManager.UI
import QtQuick

Item {
    id: root

    required property color stripColor
    required property bool active

    anchors.left: parent.left
    anchors.top: parent.top
    anchors.bottom: parent.bottom
    width: 5
    clip: true

    Rectangle {
        anchors.left: parent.left
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        width: parent.width + FmTheme.rounding.sm
        radius: FmTheme.rounding.sm
        color: root.stripColor
        opacity: root.active ? 0.85 : 0

        Behavior on opacity { Anim {} }
    }
}
