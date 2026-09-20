import Symmetria.FileManager.UI
import QtQuick
import QtQuick.Layouts

Item {
    id: root

    required property var entry
    property size imageDimensions: Qt.size(0, 0)
    property string textLanguage: ""
    property int textLineCount: 0
    property int archiveFileCount: 0
    property int archiveDirCount: 0
    property int spreadsheetSheetCount: 0
    property int spreadsheetActiveSheet: 0
    property int spreadsheetTotalRows: 0
    property int spreadsheetTotalCols: 0
    property string audioDuration: ""

    visible: !!entry
    implicitHeight: metaLayout.implicitHeight + FmTheme.padding.sm * 2

    // Subtle top separator
    Rectangle {
        anchors.top: parent.top
        anchors.left: parent.left
        anchors.right: parent.right
        height: 1
        color: FmTheme.palette.outlineVariant
    }

    RowLayout {
        id: metaLayout

        anchors.fill: parent
        anchors.margins: FmTheme.padding.sm
        anchors.leftMargin: FmTheme.padding.md
        anchors.rightMargin: FmTheme.padding.md
        spacing: FmTheme.spacing.sm

        // Symlink indicator
        MaterialIcon {
            visible: root.entry?.isSymlink ?? false
            text: "link"
            color: FmTheme.palette.outline
            font.pointSize: FmTheme.font.size.xs
        }

        // Filename (takes remaining space)
        StyledText {
            Layout.fillWidth: true
            text: root.entry?.name ?? ""
            elide: Text.ElideMiddle
            color: FmTheme.palette.onSurfaceVariant
            font.pointSize: FmTheme.font.size.xs
            font.family: FmTheme.font.family.mono
        }

        // Image/video dimensions (only shown when available)
        StyledText {
            visible: root.imageDimensions.width > 0
            text: root.imageDimensions.width + "\u00d7" + root.imageDimensions.height
            color: FmTheme.palette.outline
            font.pointSize: FmTheme.font.size.xs
            font.family: FmTheme.font.family.mono
        }

        // Text language badge (only shown for text previews)
        StyledText {
            visible: root.textLanguage !== ""
            text: root.textLanguage
            color: FmTheme.palette.outline
            font.pointSize: FmTheme.font.size.xs
            font.family: FmTheme.font.family.mono
        }

        // Text line count (only shown for text previews)
        StyledText {
            visible: root.textLineCount > 0
            text: qsTr("%1 lines").arg(root.textLineCount)
            color: FmTheme.palette.outline
            font.pointSize: FmTheme.font.size.xs
            font.family: FmTheme.font.family.mono
        }

        // Spreadsheet metadata (only shown for spreadsheet previews)
        StyledText {
            visible: root.spreadsheetTotalRows > 0
            text: {
                let info = root.spreadsheetTotalRows + "\u00d7" + root.spreadsheetTotalCols;
                if (root.spreadsheetSheetCount > 1)
                    info = qsTr("Sheet %1 of %2").arg(root.spreadsheetActiveSheet + 1).arg(root.spreadsheetSheetCount) + " \u00b7 " + info;
                return info;
            }
            color: FmTheme.palette.outline
            font.pointSize: FmTheme.font.size.xs
            font.family: FmTheme.font.family.mono
        }

        // Archive contents summary (only shown for archive previews)
        StyledText {
            visible: root.archiveFileCount > 0 || root.archiveDirCount > 0
            text: {
                let parts = [];
                if (root.archiveDirCount > 0)
                    parts.push(qsTr("%1 dirs").arg(root.archiveDirCount));
                if (root.archiveFileCount > 0)
                    parts.push(qsTr("%1 files").arg(root.archiveFileCount));
                return parts.join(", ");
            }
            color: FmTheme.palette.outline
            font.pointSize: FmTheme.font.size.xs
            font.family: FmTheme.font.family.mono
        }

        // Audio duration (only shown for audio previews)
        StyledText {
            visible: root.audioDuration !== ""
            text: root.audioDuration
            color: FmTheme.palette.outline
            font.pointSize: FmTheme.font.size.xs
            font.family: FmTheme.font.family.mono
        }

        // Modified date
        StyledText {
            visible: !!root.entry
            text: root.entry ? FileManagerService.formatDate(root.entry.modifiedDate) : ""
            color: FmTheme.palette.outline
            font.pointSize: FmTheme.font.size.xs
            font.family: FmTheme.font.family.mono
        }

        // File size
        StyledText {
            text: root.entry ? FileManagerService.formatSize(root.entry.size) : ""
            color: FmTheme.palette.outline
            font.pointSize: FmTheme.font.size.xs
            font.family: FmTheme.font.family.mono
        }
    }
}
