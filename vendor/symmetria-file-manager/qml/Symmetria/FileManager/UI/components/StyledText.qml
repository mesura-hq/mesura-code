import Symmetria.FileManager.UI
import QtQuick

Text {
    id: root

    renderType: Text.NativeRendering
    textFormat: Text.PlainText
    color: FmTheme.palette.onSurface
    font.family: FmTheme.font.family.sans
    font.pointSize: FmTheme.font.size.sm

    Behavior on color {
        CAnim {}
    }
}
