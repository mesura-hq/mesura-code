pragma ComponentBehavior: Bound

// GitStatusBadge — small colored chip that renders a single character.
//
// The FM is intentionally git-agnostic: this component does NOT decide what
// "M" or "?" means. The statusProvider (typically in a consumer like
// Symmetria-IDE) decides the character, color, and tooltip per file path, and
// this component just renders what it's told.
//
// Expected `status` shape (all fields optional except `char` and `color`):
//   {
//     char:      "M" | "?" | "A" | "D" | ...   // single character to render
//     color:     <color>                        // background tint
//     textColor: <color>                        // optional, defaults to badgeText
//     tooltip:   <string>                       // optional hover hint
//   }
//
// Missing or malformed `status` falls back to a visible "?" so a buggy
// provider degrades to a visual rather than crashing the row delegate.

import Symmetria.FileManager.UI
import QtQuick
import QtQuick.Controls

Rectangle {
    id: root

    required property var status

    readonly property string _char: (status && typeof status.char === "string" && status.char.length > 0)
                                    ? status.char.charAt(0) : "?"
    readonly property color _bg: (status && status.color !== undefined)
                                 ? status.color : FmTheme.palette.outline
    readonly property color _fg: (status && status.textColor !== undefined)
                                 ? status.textColor : FmTheme.gitStatus.badgeText
    readonly property string _tooltip: (status && typeof status.tooltip === "string")
                                       ? status.tooltip : ""

    implicitWidth: 16
    implicitHeight: 16
    radius: 3
    color: _bg

    Behavior on color { CAnim {} }

    StyledText {
        anchors.centerIn: parent
        text: root._char
        color: root._fg
        font.pointSize: FmTheme.font.size.sm
        font.family: FmTheme.font.family.mono
        font.weight: Font.Bold
    }

    HoverHandler {
        id: hover
        enabled: root._tooltip !== ""
    }

    ToolTip {
        visible: hover.hovered && root._tooltip !== ""
        text: root._tooltip
        delay: 400
    }
}
