pragma ComponentBehavior: Bound

import Symmetria.FileManager.UI
import QtQuick
import QtQuick.Layouts

ColumnLayout {
    id: root

    required property string iconName
    required property string message

    spacing: FmTheme.spacing.md

    MaterialIcon {
        Layout.alignment: Qt.AlignHCenter
        text: root.iconName
        color: FmTheme.palette.outline
        font.pointSize: FmTheme.font.size.xxl * 2
        font.weight: Font.Medium
    }

    StyledText {
        Layout.alignment: Qt.AlignHCenter
        text: root.message
        color: FmTheme.palette.outline
        font.pointSize: FmTheme.font.size.xl
        font.weight: Font.Medium
    }
}
