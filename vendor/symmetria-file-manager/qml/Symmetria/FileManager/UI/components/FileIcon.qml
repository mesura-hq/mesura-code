import QtQuick
import Symmetria.FileManager.UI

Item {
    id: root

    // Absolute path to a themed icon file ("" → fall back to the Material glyph).
    // A plain string rather than a FileSystemEntry so any caller that can supply a
    // path works: FileListItem passes entry.iconPath, the fuzzy finder passes its
    // model's iconPath role. FileIcon lives in components/ and does not import the
    // plugin, so it could not type an entry object anyway.
    property string iconPath: ""
    required property string materialIconName

    property color materialColor: FmTheme.palette.onSurfaceVariant
    property real materialFill: 0
    property real materialPointSize: FmTheme.font.size.xl
    // -1 means "use the font's default weight". QML does not support binding font.weight
    // directly as a property initializer, so weight is applied in Component.onCompleted.
    property int materialWeight: -1

    readonly property bool useSystemIcon: Config.fileManager.iconMode === "system"
                                          && root.iconPath !== ""

    implicitWidth: FmTheme.font.size.xl * 1.5
    implicitHeight: FmTheme.font.size.xl * 1.5

    Image {
        anchors.centerIn: parent
        width: root.width
        height: root.height
        source: root.useSystemIcon ? "file://" + root.iconPath : ""
        visible: root.useSystemIcon
        sourceSize: Qt.size(width * 2, height * 2)
        fillMode: Image.PreserveAspectFit
        asynchronous: true
        smooth: true
    }

    MaterialIcon {
        id: materialIcon
        anchors.centerIn: parent
        visible: !root.useSystemIcon
        text: root.materialIconName
        color: root.materialColor
        fill: root.materialFill
        font.pointSize: root.materialPointSize
        Component.onCompleted: {
            // font.weight cannot be set as a plain property binding in QML; it must
            // be assigned imperatively after the component tree is complete.
            if (root.materialWeight >= 0)
                materialIcon.font.weight = root.materialWeight;
        }
    }
}
