import Symmetria.FileManager.UI
import Symmetria.FileManager.Models
import QtQuick
import QtQuick.Layouts

Item {
    id: root

    required property var entry

    // Exposed for PreviewMetadata — reflects actual image dimensions
    readonly property size naturalSize: preview.status === Image.Ready
        ? Qt.size(preview.implicitWidth, preview.implicitHeight)
        : Qt.size(0, 0)

    // Resolves PDF transparency by compositing over white background in C++.
    // Normal images pass through untouched (zero overhead).
    PreviewImageHelper {
        id: previewHelper
        source: root.entry ? root.entry.path : ""
    }

    Image {
        id: preview

        anchors.fill: parent
        anchors.margins: FmTheme.padding.md

        source: previewHelper.resolvedUrl
        asynchronous: true
        fillMode: Image.PreserveAspectFit
        smooth: true
        mipmap: true

        // Cap decoded pixel dimensions for memory safety.
        // 2x multiplier ensures sharp rendering on HiDPI displays.
        sourceSize.width: Math.max(root.width, 1) * 2
        sourceSize.height: Math.max(root.height, 1) * 2

        opacity: status === Image.Ready ? 1 : 0

        Behavior on opacity {
            Anim {}
        }
    }

    // Loading indicator — covers both C++ PDF compositing (previewHelper.loading)
    // and Qt image decode (Image.Loading). Either phase means content is not yet ready.
    Loader {
        anchors.centerIn: parent
        active: previewHelper.loading || preview.status === Image.Loading
        asynchronous: true

        sourceComponent: PreviewLoadingIndicator {}
    }

    // Error state
    Loader {
        anchors.centerIn: parent
        active: !previewHelper.loading && preview.status === Image.Error
        asynchronous: true

        sourceComponent: PreviewStateIndicator {
            iconName: "broken_image"
            message: qsTr("Cannot preview")
        }
    }
}
