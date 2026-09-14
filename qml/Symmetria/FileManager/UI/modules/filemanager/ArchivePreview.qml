import Symmetria.FileManager.UI
import Symmetria.FileManager.Models
import QtQuick
import QtQuick.Layouts

Item {
    id: root

    required property var entry

    // Exposed for PreviewMetadata
    readonly property int fileCount: archiveModel.fileCount
    readonly property int dirCount: archiveModel.dirCount

    ArchivePreviewModel {
        id: archiveModel
        filePath: root.entry ? root.entry.path : ""
    }

    // Imperative update avoids binding loops — QML re-enters declarative bindings
    // when the C++ model emits multiple NOTIFY signals in the same batch.
    // Non-readonly: written imperatively by _updateEmpty to avoid binding loop re-entry.
    property bool _isEmpty: false

    function _updateEmpty() {
        _isEmpty = !archiveModel.loading
            && archiveModel.error === ""
            && archiveModel.totalEntries === 0
            && archiveModel.filePath !== "";
    }

    // Each signal triggers re-evaluation of the empty-state condition
    Connections {
        target: archiveModel
        function onLoadingChanged() { root._updateEmpty(); }
        function onErrorChanged() { root._updateEmpty(); }
        function onTotalEntriesChanged() { root._updateEmpty(); }
        function onFilePathChanged() { root._updateEmpty(); }
    }

    Component.onCompleted: root._updateEmpty()

    // QUIRK: explicit x/y/width/height required — anchors.margins silently ignored inside
    // Loader sourceComponent. See QUIRKS.md §1 for full explanation.
    ListView {
        id: archiveListView

        x: FmTheme.padding.sm
        y: FmTheme.padding.sm
        width: parent.width - FmTheme.padding.sm * 2
        height: parent.height - FmTheme.padding.sm * 2
        clip: true
        focus: false
        interactive: false
        keyNavigationEnabled: false
        currentIndex: -1
        boundsBehavior: Flickable.StopAtBounds

        model: archiveModel

        delegate: Item {
            id: delegateRoot

            required property string name
            required property string fullPath
            required property int size
            required property bool isDir
            required property int depth

            width: archiveListView.width
            implicitHeight: delegateLayout.implicitHeight

            RowLayout {
                id: delegateLayout

                anchors.fill: parent
                anchors.leftMargin: FmTheme.padding.md + (delegateRoot.depth * 18)
                anchors.rightMargin: FmTheme.padding.md
                spacing: FmTheme.spacing.sm

                MaterialIcon {
                    text: delegateRoot.isDir ? "folder" : "description"
                    color: delegateRoot.isDir
                        ? FmTheme.palette.primary
                        : FmTheme.palette.onSurfaceVariant
                    font.pointSize: FmTheme.font.size.xs
                    font.weight: delegateRoot.isDir ? Font.DemiBold : Font.Normal
                }

                StyledText {
                    Layout.fillWidth: true
                    text: delegateRoot.name
                    elide: Text.ElideRight
                    color: FmTheme.palette.onSurface
                    font.pointSize: FmTheme.font.size.xs
                }

                StyledText {
                    visible: !delegateRoot.isDir
                    text: FileManagerService.formatSize(delegateRoot.size)
                    color: FmTheme.palette.outline
                    font.pointSize: FmTheme.font.size.sm
                    font.family: FmTheme.font.family.mono
                }
            }
        }

        opacity: archiveModel.fileCount > 0 || archiveModel.dirCount > 0 ? 1 : 0

        Behavior on opacity {
            Anim {}
        }
    }

    // Truncation indicator — shown when archive has more entries than MaxEntries
    StyledText {
        visible: archiveModel.truncated
        anchors.bottom: parent.bottom
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.bottomMargin: FmTheme.padding.sm
        text: qsTr("Showing %1 of %2 entries").arg(archiveListView.count).arg(archiveModel.totalEntries)
        color: FmTheme.palette.outline
        font.pointSize: FmTheme.font.size.sm
        font.family: FmTheme.font.family.mono
    }

    // Loading indicator
    Loader {
        anchors.centerIn: parent
        active: archiveModel.loading
        asynchronous: true

        sourceComponent: PreviewLoadingIndicator {}
    }

    // Error state (corrupted/password-protected archive)
    Loader {
        anchors.centerIn: parent
        active: archiveModel.error !== ""
        asynchronous: true

        sourceComponent: PreviewStateIndicator {
            iconName: "block"
            message: qsTr("Cannot preview")
        }
    }

    // Empty archive indicator
    Loader {
        anchors.centerIn: parent
        active: root._isEmpty
        asynchronous: true

        sourceComponent: PreviewStateIndicator {
            iconName: "inventory_2"
            message: qsTr("Empty archive")
        }
    }
}
