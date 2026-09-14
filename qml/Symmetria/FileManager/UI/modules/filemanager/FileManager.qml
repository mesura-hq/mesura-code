pragma ComponentBehavior: Bound

import Symmetria.FileManager.UI
import Symmetria.FileManager.Models
import QtQuick
import QtQuick.Layouts

Item {
    id: root

    signal closeRequested()

    // Set by WindowFactory — determines starting directory for this window
    property string initialPath: Paths.home

    // Per-window tab manager — owns one WindowState per tab
    TabManager {
        id: tabManager
        initialPath: root.initialPath
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        TabBar {
            Layout.fillWidth: true
            Layout.preferredHeight: tabManager.showBar ? implicitHeight : 0
            tabManager: tabManager
            clip: true
            onCloseRequested: root.closeRequested()
        }

        PathBar {
            Layout.fillWidth: true
            windowState: tabManager.activeTab
        }

        // Active view — swapped via Ctrl-E. MillerColumns is the default;
        // FileTreeView is the recursive tree mode. Each tab's WindowState
        // owns its own viewMode, so tabs can independently choose.
        Loader {
            id: viewLoader
            Layout.fillWidth: true
            Layout.fillHeight: true
            sourceComponent: (tabManager.activeTab && tabManager.activeTab.viewMode === tabManager.activeTab.viewTree)
                             ? treeComponent : millerComponent
        }

        StatusBar {
            Layout.fillWidth: true
            windowState: tabManager.activeTab
            fileCount: viewLoader.item ? viewLoader.item.fileCount : 0
            currentEntry: viewLoader.item ? viewLoader.item.currentEntry : null
        }
    }

    Component {
        id: millerComponent
        MillerColumns {
            windowState: tabManager.activeTab
            tabManager: tabManager
            onCloseRequested: root.closeRequested()
        }
    }

    Component {
        id: treeComponent
        // Tree mode wrapped in a SOLID rounded card so it floats on the window
        // backdrop exactly like a MillerColumns column (Tahoe/Files look). The
        // chrome gap + surface live HERE, in the standalone host — NOT in the
        // shared FileTreeView, whose flush, content-fit `implicitHeight` the IDE
        // sidebar consumers depend on. The card mirrors MillerColumns' per-column
        // StyledRect; FileTreeView's own background stays transparent
        // (FmTheme.layer) and reveals this surface, just as FileList does over
        // its column surface.
        Item {
            // Re-expose the outputs FileManager reads off `viewLoader.item` so
            // this wrapper satisfies the same implicit interface MillerColumns does.
            property alias fileCount: treeView.fileCount
            property alias currentEntry: treeView.currentEntry
            // The tree's positional props are relative to the FileTreeView,
            // which sits two `padding.md` insets deep in this wrapper (chrome
            // gap + card inset) — offset them back into wrapper coordinates
            // for RenamePopup.
            readonly property real currentItemBottomY: treeView.currentItemBottomY + FmTheme.padding.md * 2
            readonly property real currentColumnX: treeView.currentColumnX + FmTheme.padding.md * 2
            // No offset — treeView.width is already the inset content width;
            // only the X/Y origins need shifting into wrapper coordinates.
            readonly property real currentColumnWidth: treeView.currentColumnWidth

            // Chrome gap — the card floats `padding.md` inside the view cell,
            // matching the Miller layout's outer margin.
            Item {
                anchors.fill: parent
                anchors.margins: FmTheme.padding.md

                // Pane surface — the fourth copy of the idiom documented at the
                // first column in MillerColumns.qml. `palette.surface` matches
                // the host background on purpose; change all four together.
                StyledRect {
                    anchors.fill: parent
                    radius: FmTheme.rounding.lg
                    color: FmTheme.palette.surface
                    border.color: FmTheme.overlay.subtle
                    border.width: 1
                }

                // Inset `padding.md` over the surface so the rows clear the
                // rounded corners (same inset MillerColumns gives FileList).
                FileTreeView {
                    id: treeView
                    anchors.fill: parent
                    anchors.margins: FmTheme.padding.md
                    rootPath: tabManager.activeTab ? tabManager.activeTab.currentPath : Paths.home
                    showHidden: Config.fileManager.showHidden
                    windowState: tabManager.activeTab
                    onFileActivated: function(path) { fmFileOpener.open(path, ""); }
                    onShowHiddenToggleRequested: Config.fileManager.showHidden = !Config.fileManager.showHidden
                }

                // Chord hints (g/c/, which-key). Miller shows this over the
                // parent panel; the tree has no side column, so it overlays
                // the tree card itself. Renders only while a chord or
                // bookmark sub-mode is active (opacity-gated internally).
                WhichKeyPopup {
                    anchors.fill: parent
                    anchors.margins: FmTheme.padding.md
                    windowState: tabManager.activeTab
                }
            }
        }
    }

    FileOpener {
        id: fmFileOpener
    }

    // Modal overlays — render above the entire layout.
    // Each popup is itself a Loader with its own active guard;
    // picker guard is folded into the popup's active binding.
    DeleteConfirmPopup {
        anchors.fill: parent
        windowState: tabManager.activeTab
    }
    CreateFilePopup {
        anchors.fill: parent
        windowState: tabManager.activeTab
    }
    RenamePopup {
        anchors.fill: parent
        windowState: tabManager.activeTab
        targetItemY: viewLoader.y + (viewLoader.item ? viewLoader.item.currentItemBottomY : 0)
        targetColumnX: viewLoader.x + (viewLoader.item ? viewLoader.item.currentColumnX : 0)
        targetColumnWidth: viewLoader.item ? viewLoader.item.currentColumnWidth : 0
    }
    ContextMenuPopup {
        anchors.fill: parent
        windowState: tabManager.activeTab
    }
    ZoxidePopup {
        anchors.fill: parent
        windowState: tabManager.activeTab
    }
    FuzzyFinderPopup {
        anchors.fill: parent
        windowState: tabManager.activeTab
    }
    HelpPopup {
        anchors.fill: parent
        windowState: tabManager.activeTab
    }

    // Train zoxide's frecency database on every directory visit.
    // Fire-and-forget: exit code is irrelevant.
    // _pendingPath holds the most-recent path that arrived while the
    // process was busy — replayed in onExited so rapid navigation doesn't
    // silently drop directory visits from zoxide's database.
    ShellRunner {
        id: zoxideAddProcess

        property string _pendingPath: ""

        onExited: {
            if (_pendingPath !== "") {
                const path = _pendingPath;
                _pendingPath = "";
                zoxideAddProcess.command = ["zoxide", "add", "--", path];
                zoxideAddProcess.start();
            }
        }
    }

    Connections {
        target: tabManager.activeTab
        function onCurrentPathChanged(): void {
            const path = tabManager.activeTab.currentPath;
            if (!path || path === "")
                return;
            if (zoxideAddProcess.running) {
                // Process busy — queue the path; onExited will replay it.
                zoxideAddProcess._pendingPath = path;
            } else {
                zoxideAddProcess.command = ["zoxide", "add", "--", path];
                zoxideAddProcess.start();
            }
        }
    }
}
