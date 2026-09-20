import Symmetria.FileManager.UI
import QtQuick
import QtQuick.Layouts

Item {
    id: root

    required property var entry

    // Derived visibility flags — avoids repeating the same null-guard expression
    // on both the label and value cells of each optional grid row.
    readonly property bool _showOwner: (root.entry?.owner ?? "") !== ""
    readonly property bool _showSymlinkTarget: root.entry?.isSymlink ?? false

    ColumnLayout {
        anchors.centerIn: parent
        width: parent.width - FmTheme.padding.lg * 2
        spacing: FmTheme.spacing.md

        // Mime-based icon via centralized FileManagerService.iconNameForMime()
        FileIcon {
            Layout.alignment: Qt.AlignHCenter
            iconPath: root.entry?.iconPath ?? ""
            implicitWidth: FmTheme.font.size.xxl * 4
            implicitHeight: FmTheme.font.size.xxl * 4
            materialIconName: {
                if (!root.entry)
                    return "description";
                return FileManagerService.iconNameForMime(root.entry.mimeType);
            }
            materialColor: FmTheme.palette.outline
            materialPointSize: FmTheme.font.size.xxl * 2
            materialWeight: 500
        }

        // Filename
        StyledText {
            Layout.alignment: Qt.AlignHCenter
            Layout.maximumWidth: parent.width
            text: root.entry?.name ?? ""
            color: FmTheme.palette.onSurface
            font.pointSize: FmTheme.font.size.lg
            font.weight: Font.Medium
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WrapAtWordBoundaryOrAnywhere
            elide: Text.ElideMiddle
            maximumLineCount: 3
        }

        // File size
        StyledText {
            Layout.alignment: Qt.AlignHCenter
            text: root.entry ? FileManagerService.formatSize(root.entry.size) : ""
            color: FmTheme.palette.onSurfaceVariant
            font.pointSize: FmTheme.font.size.sm
            font.family: FmTheme.font.family.mono
        }

        // MIME type
        StyledText {
            Layout.alignment: Qt.AlignHCenter
            text: root.entry?.mimeType ?? ""
            color: FmTheme.palette.outline
            font.pointSize: FmTheme.font.size.xs
            font.family: FmTheme.font.family.mono
        }

        // Separator
        Rectangle {
            Layout.fillWidth: true
            Layout.topMargin: FmTheme.padding.sm
            Layout.bottomMargin: FmTheme.padding.sm
            implicitHeight: 1
            color: FmTheme.palette.outlineVariant
        }

        // Metadata detail grid
        GridLayout {
            Layout.alignment: Qt.AlignHCenter
            columns: 2
            columnSpacing: FmTheme.spacing.md
            rowSpacing: FmTheme.spacing.sm

            // Modified
            StyledText {
                text: qsTr("Modified")
                color: FmTheme.palette.outline
                font.pointSize: FmTheme.font.size.xs
                font.family: FmTheme.font.family.mono
            }
            StyledText {
                text: root.entry ? FileManagerService.formatDate(root.entry.modifiedDate) : ""
                color: FmTheme.palette.onSurfaceVariant
                font.pointSize: FmTheme.font.size.xs
                font.family: FmTheme.font.family.mono
            }

            // Permissions
            StyledText {
                text: qsTr("Permissions")
                color: FmTheme.palette.outline
                font.pointSize: FmTheme.font.size.xs
                font.family: FmTheme.font.family.mono
            }
            StyledText {
                text: root.entry?.permissions ?? ""
                color: FmTheme.palette.onSurfaceVariant
                font.pointSize: FmTheme.font.size.xs
                font.family: FmTheme.font.family.mono
            }

            // Owner (hidden when empty)
            StyledText {
                visible: root._showOwner
                text: qsTr("Owner")
                color: FmTheme.palette.outline
                font.pointSize: FmTheme.font.size.xs
                font.family: FmTheme.font.family.mono
            }
            StyledText {
                visible: root._showOwner
                text: root.entry?.owner ?? ""
                color: FmTheme.palette.onSurfaceVariant
                font.pointSize: FmTheme.font.size.xs
                font.family: FmTheme.font.family.mono
            }

            // Symlink target (only for symlinks)
            StyledText {
                visible: root._showSymlinkTarget
                text: qsTr("Target")
                color: FmTheme.palette.outline
                font.pointSize: FmTheme.font.size.xs
                font.family: FmTheme.font.family.mono
            }
            StyledText {
                visible: root._showSymlinkTarget
                // Constrain width: two sides × two levels of padding (column + outer item)
                Layout.maximumWidth: root.width - FmTheme.padding.lg * 4
                text: root.entry?.symlinkTarget ?? ""
                color: FmTheme.palette.onSurfaceVariant
                font.pointSize: FmTheme.font.size.xs
                font.family: FmTheme.font.family.mono
                elide: Text.ElideMiddle
            }
        }
    }
}
