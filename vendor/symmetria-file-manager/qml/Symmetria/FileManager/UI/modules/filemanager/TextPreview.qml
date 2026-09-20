import Symmetria.FileManager.UI
import Symmetria.FileManager.Models
import QtQuick
import QtQuick.Layouts

Item {
    id: root

    required property var entry

    // Exposed for PreviewMetadata
    readonly property int lineCount: helper.lineCount
    readonly property string language: helper.language

    SyntaxHighlightHelper {
        id: helper
        filePath: root.entry ? root.entry.path : ""
    }

    // QUIRK: explicit x/y/width/height required — anchors.margins silently ignored inside
    // Loader sourceComponent. See QUIRKS.md §1 for full explanation.
    Flickable {
        id: textFlickable

        x: FmTheme.padding.lg
        y: FmTheme.padding.md
        width: parent.width - FmTheme.padding.lg * 2
        height: parent.height - FmTheme.padding.md * 2
        clip: true
        contentWidth: Math.max(textEdit.implicitWidth, textFlickable.width)
        contentHeight: textEdit.implicitHeight
        boundsBehavior: Flickable.StopAtBounds
        interactive: false

        TextEdit {
            id: textEdit

            readOnly: true
            selectByMouse: false
            activeFocusOnPress: false
            focus: false
            text: helper.highlightedContent
            textFormat: TextEdit.RichText
            font.family: FmTheme.font.family.mono
            font.pointSize: FmTheme.font.size.xs
            wrapMode: TextEdit.NoWrap
            // Text color is set by the <pre style="color:..."> injected in SyntaxHighlightHelper.
            // The QML color property has no effect in RichText mode when the HTML provides its own color.
            renderType: TextEdit.QtRendering
        }

        opacity: helper.hasContent ? 1 : 0

        Behavior on opacity {
            Anim {}
        }
    }

    // Loading indicator
    Loader {
        anchors.centerIn: parent
        active: helper.loading
        asynchronous: true

        sourceComponent: PreviewLoadingIndicator {}
    }

    // Error state (binary file or read failure)
    Loader {
        anchors.centerIn: parent
        active: helper.error
        asynchronous: true

        sourceComponent: PreviewStateIndicator {
            iconName: "block"
            message: qsTr("Cannot preview")
        }
    }
}
