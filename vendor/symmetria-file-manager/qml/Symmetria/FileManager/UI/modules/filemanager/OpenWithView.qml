pragma ComponentBehavior: Bound

import Symmetria.FileManager.UI
import QtQuick
import QtQuick.Layouts

// "Open with…" application picker — the context menu's "openWith" viewMode.
// Presentation only: it renders the filter field + the resolved app list the
// parent (ContextMenuPopup) discovers, and emits intent — filterEdited as the
// user types, appActivated when a row is chosen. The parent owns the app list,
// the filter state, the launch process, and the keyboard navigation; this view
// holds no business logic. The filter TextInput self-focuses on show.
ColumnLayout {
    id: root

    required property var filteredApps
    required property string appFilterQuery
    required property int appIndex
    required property bool loading

    signal filterEdited(string text)
    signal appActivated(string desktopId)

    spacing: FmTheme.spacing.sm

    // Filter input
    StyledRect {
        Layout.fillWidth: true
        radius: FmTheme.rounding.sm
        color: Qt.alpha(FmTheme.palette.onSurface, 0.06)
        implicitHeight: filterRow.implicitHeight + FmTheme.padding.md * 2

        RowLayout {
            id: filterRow

            anchors.left: parent.left
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            anchors.leftMargin: FmTheme.padding.lg
            anchors.rightMargin: FmTheme.padding.lg
            spacing: FmTheme.spacing.sm

            MaterialIcon {
                text: "search"
                color: FmTheme.palette.outline
                font.pointSize: FmTheme.font.size.sm
            }

            TextInput {
                id: filterInput

                Layout.fillWidth: true
                color: FmTheme.palette.onSurface
                font.pointSize: FmTheme.font.size.sm
                font.family: FmTheme.font.family.mono
                selectionColor: FmTheme.palette.primary
                selectedTextColor: FmTheme.palette.onPrimary
                clip: true
                Component.onCompleted: forceActiveFocus()

                onTextChanged: root.filterEdited(text)

                // Let navigation keys bubble up to the parent dialog's key handler
                Keys.onPressed: function(event) {
                    if (event.key === Qt.Key_Down || event.key === Qt.Key_Up
                        || event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                        || event.key === Qt.Key_Escape) {
                        event.accepted = false;
                    }
                }
            }
        }
    }

    // Loading indicator
    StyledText {
        visible: root.loading
        text: "Loading applications…"
        color: FmTheme.palette.outline
        font.pointSize: FmTheme.font.size.sm
    }

    // No results
    StyledText {
        visible: !root.loading && root.filteredApps.length === 0
        text: root.appFilterQuery !== ""
            ? "No matching applications"
            : "No registered applications"
        color: FmTheme.palette.outline
        font.pointSize: FmTheme.font.size.sm
    }

    // App list
    ListView {
        id: appListView

        Layout.fillWidth: true
        Layout.preferredHeight: Math.min(contentHeight, 250)
        clip: true
        spacing: FmTheme.spacing.sm
        model: root.filteredApps
        currentIndex: root.appIndex
        boundsBehavior: Flickable.StopAtBounds

        delegate: StyledRect {
            id: appDelegate

            required property int index
            required property var modelData

            // Read the per-row model data once into qualified properties — children
            // reference appDelegate.* rather than the bare context modelData.
            readonly property string appName: appDelegate.modelData.name ?? ""
            readonly property string appDesktopId: appDelegate.modelData.desktopId ?? ""
            readonly property string appIconPath: appDelegate.modelData.iconPath ?? ""

            width: appListView.width
            radius: FmTheme.rounding.sm
            color: appDelegate.index === root.appIndex
                ? Qt.alpha(FmTheme.palette.primary, 0.12)
                : "transparent"
            implicitHeight: appRow.implicitHeight + FmTheme.padding.md * 2

            Behavior on color { CAnim {} }

            RowLayout {
                id: appRow

                anchors.left: parent.left
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                anchors.leftMargin: FmTheme.padding.lg
                anchors.rightMargin: FmTheme.padding.lg
                spacing: FmTheme.spacing.lg

                // Fixed-size icon cell — a real themed app icon when resolved, the
                // generic "apps" glyph otherwise. The cell is HARD-pinned
                // (min == preferred == max) so the layout cannot grow it toward a
                // child's implicit size; that pinning keeps every app name's left
                // edge aligned regardless of icon/glyph natural dimensions.
                Item {
                    readonly property real cellSize: Math.round(FmTheme.font.size.md * 1.6)

                    Layout.minimumWidth: cellSize
                    Layout.preferredWidth: cellSize
                    Layout.maximumWidth: cellSize
                    Layout.minimumHeight: cellSize
                    Layout.preferredHeight: cellSize
                    Layout.maximumHeight: cellSize
                    Layout.alignment: Qt.AlignVCenter

                    Image {
                        anchors.fill: parent
                        source: appDelegate.appIconPath !== ""
                            ? "file://" + appDelegate.appIconPath
                            : ""
                        visible: appDelegate.appIconPath !== ""
                        sourceSize: Qt.size(width * 2, height * 2)
                        fillMode: Image.PreserveAspectFit
                        asynchronous: true
                        smooth: true
                    }

                    MaterialIcon {
                        anchors.centerIn: parent
                        visible: appDelegate.appIconPath === ""
                        text: "apps"
                        color: FmTheme.palette.onSurfaceVariant
                        font.pointSize: FmTheme.font.size.md
                    }
                }

                // Plain Column (not ColumnLayout): a nested ColumnLayout here was NOT
                // stretched by the RowLayout — it collapsed to its widest child (the
                // desktopId) and the row's slack centered the block, so each row's
                // name started at a different x. A plain Column is a regular Item, so
                // Layout.fillWidth stretches it and it left-packs both lines at a
                // constant x.
                Column {
                    Layout.fillWidth: true
                    Layout.alignment: Qt.AlignVCenter
                    spacing: 1

                    StyledText {
                        width: parent.width
                        elide: Text.ElideRight
                        text: appDelegate.appName
                        color: FmTheme.palette.onSurface
                        font.pointSize: FmTheme.font.size.sm
                        font.weight: Font.Medium
                    }

                    StyledText {
                        width: parent.width
                        elide: Text.ElideRight
                        text: appDelegate.appDesktopId
                        color: FmTheme.palette.onSurfaceVariant
                        font.pointSize: FmTheme.font.size.xs
                        font.family: FmTheme.font.family.mono
                    }
                }
            }

            StateLayer {
                onClicked: root.appActivated(appDelegate.appDesktopId)
            }
        }
    }

    // Back hint
    StyledText {
        text: "Esc to go back"
        color: FmTheme.palette.outline
        font.pointSize: FmTheme.font.size.xs
    }
}
