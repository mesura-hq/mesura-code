pragma ComponentBehavior: Bound

import Symmetria.FileManager.UI
import Symmetria.FileManager.Models
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Item {
    id: root

    property WindowState windowState

    readonly property var entries: parentModel.entries

    readonly property string _parentPath: {
        if (!windowState) return "";
        const path = windowState.currentPath;
        return path === "/" ? "" : Paths.parentDir(path);
    }

    readonly property string _currentDirName: {
        if (!windowState) return "";
        const path = windowState.currentPath;
        return path === "/" ? "" : Paths.basename(path);
    }

    // Background — match PreviewPanel shade
    StyledRect {
        anchors.fill: parent
        color: FmTheme.layer(FmTheme.palette.surfaceContainerLow)
    }

    // Empty state when at filesystem root
    Loader {
        anchors.centerIn: parent
        opacity: root._parentPath === "" ? 1 : 0
        active: opacity > 0
        asynchronous: true

        sourceComponent: PreviewStateIndicator {
            iconName: "device_hub"
            message: qsTr("Root")
        }

        Behavior on opacity {
            Anim {}
        }
    }

    ListView {
        id: parentView

        anchors.fill: parent
        anchors.margins: FmTheme.padding.sm
        visible: root._parentPath !== ""
        clip: true
        focus: false
        keyNavigationEnabled: false
        boundsBehavior: Flickable.StopAtBounds

        ScrollBar.vertical: ScrollBar {
            policy: ScrollBar.AsNeeded
        }

        model: FileSystemModel {
            id: parentModel
            path: root._parentPath
            showHidden: Config.fileManager.showHidden
            sortBy: root.windowState ? root.windowState.sortBy : FileSystemModel.Modified
            sortReverse: root.windowState ? root.windowState.sortReverse : true
            watchChanges: true
        }

        delegate: FileListItem {
            width: parentView.width
            flashActive: root.windowState ? root.windowState.flashActive : false
            flashQuery: root.windowState ? root.windowState.flashQuery : ""
            flashLabel: root.windowState?.flashParentMatchMap[index]?.label ?? ""
            flashMatchStart: root.windowState?.flashParentMatchMap[index]?.matchStart ?? -1
            onActivated: {
                if (modelData.isDir)
                    root.windowState.navigate(modelData.path);
                else {
                    fileOpener.open(modelData.path, modelData.mimeType);
                }
            }
        }

        // Highlight the entry that matches the current directory name
        Connections {
            target: parentModel
            function onEntriesChanged() {
                root._syncHighlight();
            }
        }

        // Prevent single-click from desyncing the highlight — the parent
        // panel's highlight always tracks the current directory, not user clicks
        onCurrentIndexChanged: Qt.callLater(root._syncHighlight)
    }

    function _syncHighlight(): void {
        if (_currentDirName === "") {
            parentView.currentIndex = -1;
            return;
        }
        // Skip O(n) scan if already pointing at the correct entry
        if (parentView.currentIndex >= 0
            && parentView.currentIndex < parentModel.entries.length
            && parentModel.entries[parentView.currentIndex].name === _currentDirName)
            return;
        for (let i = 0; i < parentModel.entries.length; i++) {
            if (parentModel.entries[i].name === _currentDirName) {
                parentView.currentIndex = i;
                return;
            }
        }
        parentView.currentIndex = -1;
    }

    FileOpener {
        id: fileOpener
    }

    // Re-sync when the current path changes (parent path may stay the same
    // but the highlighted entry needs to update, e.g. navigating between siblings)
    Connections {
        target: windowState
        function onCurrentPathChanged() {
            root._syncHighlight();
        }
    }
}
