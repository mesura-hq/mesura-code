pragma ComponentBehavior: Bound

import Symmetria.FileManager.UI
import QtQuick.Layouts

ColumnLayout {
    id: root

    spacing: FmTheme.spacing.sm

    MaterialIcon {
        Layout.alignment: Qt.AlignHCenter
        text: "hourglass_empty"
        color: FmTheme.palette.outline
        font.pointSize: FmTheme.font.size.xxl
    }

    StyledText {
        Layout.alignment: Qt.AlignHCenter
        text: qsTr("Loading\u2026")
        color: FmTheme.palette.outline
        font.pointSize: FmTheme.font.size.md
    }
}
