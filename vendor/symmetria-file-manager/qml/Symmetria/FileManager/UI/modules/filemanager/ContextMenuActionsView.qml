pragma ComponentBehavior: Bound

import Symmetria.FileManager.UI
import QtQuick
import QtQuick.Layouts

// Actions list — the context menu's default "actions" viewMode (Open with, and
// conditionally Play/Pause and Extract). Pure presentation over the parent's
// actionItems model + actionIndex selection; a click emits actionTriggered, which
// the parent routes through _executeAction. Keyboard navigation and focus-on-show
// stay in the parent (ContextMenuPopup).
ColumnLayout {
    id: root

    required property var actionItems
    required property int actionIndex

    signal actionTriggered(string actionId)

    spacing: FmTheme.spacing.sm

    Repeater {
        model: root.actionItems

        StyledRect {
            id: actionDelegate

            required property int index
            required property var modelData

            Layout.fillWidth: true
            radius: FmTheme.rounding.sm
            color: actionDelegate.index === root.actionIndex
                ? Qt.alpha(FmTheme.palette.primary, 0.12)
                : "transparent"
            implicitHeight: actionRow.implicitHeight + FmTheme.padding.md * 2

            Behavior on color { CAnim {} }

            RowLayout {
                id: actionRow

                anchors.left: parent.left
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                anchors.leftMargin: FmTheme.padding.lg
                anchors.rightMargin: FmTheme.padding.lg
                spacing: FmTheme.spacing.md

                // Keycap badge — fixed-width column
                Rectangle {
                    Layout.preferredWidth: 24
                    Layout.preferredHeight: 24
                    Layout.alignment: Qt.AlignVCenter
                    radius: 6
                    color: FmTheme.overlay.subtle
                    border.color: FmTheme.overlay.emphasis
                    border.width: 1

                    StyledText {
                        anchors.centerIn: parent
                        text: actionDelegate.modelData.key
                        color: FmTheme.palette.onSurface
                        font.family: FmTheme.font.family.mono
                        font.pointSize: FmTheme.font.size.xs
                        font.weight: Font.DemiBold
                    }
                }

                // Icon — fixed-width column
                MaterialIcon {
                    Layout.preferredWidth: 20
                    Layout.alignment: Qt.AlignVCenter
                    horizontalAlignment: Text.AlignHCenter
                    text: actionDelegate.modelData.icon
                    color: FmTheme.palette.onSurfaceVariant
                    font.pointSize: FmTheme.font.size.md
                }

                // Label — fills remaining space
                StyledText {
                    Layout.fillWidth: true
                    Layout.alignment: Qt.AlignVCenter
                    text: actionDelegate.modelData.label
                    color: FmTheme.palette.onSurface
                    font.pointSize: FmTheme.font.size.sm
                }
            }

            StateLayer {
                onClicked: root.actionTriggered(actionDelegate.modelData.actionId)
            }
        }
    }
}
