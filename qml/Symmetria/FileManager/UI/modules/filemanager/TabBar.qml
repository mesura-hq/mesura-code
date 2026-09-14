pragma ComponentBehavior: Bound

import Symmetria.FileManager.UI
import QtQuick

Item {
    id: root

    property TabManager tabManager
    signal closeRequested()

    readonly property real _barHorizontalMargin: FmTheme.padding.lg + FmTheme.padding.md
    // Tab pill height: match the PathBar breadcrumb pill height
    readonly property real _tabHeight: Config.fileManager.sizes.itemHeight + FmTheme.padding.sm * 2

    // Height is always set — ColumnLayout skips invisible items automatically
    implicitHeight: _tabHeight + FmTheme.padding.md * 2

    onHeightChanged: {
        if (tabManager)
            Logger.debug("TabBar", "height=" + height + " implicitHeight=" + implicitHeight + " showBar=" + tabManager.showBar + " tabCount=" + tabManager.count);
    }

    Row {
        id: tabRow

        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        anchors.leftMargin: root._barHorizontalMargin
        spacing: FmTheme.spacing.sm

        Repeater {
            model: root.tabManager ? root.tabManager.tabs : []

            Item {
                id: tabItem

                required property var modelData  // WindowState
                required property int index

                // Bind to tabManager.activeIndex explicitly so QML re-evaluates on every switch
                readonly property bool isActive: root.tabManager
                    && root.tabManager.activeIndex === tabItem.index
                readonly property bool isHovered: tabHoverArea.containsMouse

                readonly property string tabLabel: {
                    if (!modelData || !modelData.currentPath)
                        return "~";
                    const path = modelData.currentPath;
                    const home = Paths.home;
                    if (path === home)
                        return "~";
                    if (path === "/")
                        return "/";
                    return path.split("/").pop() || "/";
                }

                width: Math.max(120, tabLabel_text.implicitWidth + (tabItem.isHovered ? closeBtn.width + FmTheme.spacing.sm : 0) + FmTheme.padding.lg * 2)
                height: root._tabHeight

                Behavior on width { Anim {} }

                // Background: active tab raises into a claymorphism pill (matte
                // fill + border + convex depth); inactive stays flat with a
                // subtle outline. `elevated` gates the depth so the active tab
                // reads as a raised chip — same clay language as the shell.
                PillSurface {
                    anchors.fill: parent
                    elevated: tabItem.isActive
                    color: tabItem.isActive ? FmTheme.pillMedium.background : "transparent"
                    borderColor: tabItem.isActive ? FmTheme.pillMedium.border : FmTheme.palette.outlineVariant

                    // color/border.color transitions are eased inside PillSurface
                    // (StyledRect's internal CAnim + the baked border behavior);
                    // the shadow fade is eased by PillSurface's per-shadow CAnim.
                }

                // Hover/click area for the entire tab
                MouseArea {
                    id: tabHoverArea

                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: {
                        if (root.tabManager)
                            root.tabManager.activateTab(tabItem.index);
                    }
                }

                // Centered label: "1 dirname"
                StyledText {
                    id: tabLabel_text

                    anchors.centerIn: parent
                    // Offset left when close button is showing to keep text visually centered
                    anchors.horizontalCenterOffset: tabItem.isHovered ? -(closeBtn.width + FmTheme.spacing.sm) / 2 : 0

                    text: (tabItem.index + 1) + " " + tabItem.tabLabel
                    color: tabItem.isActive ? FmTheme.palette.onSurface : FmTheme.palette.onSurfaceVariant
                    font.pointSize: FmTheme.font.size.sm

                    Behavior on anchors.horizontalCenterOffset { Anim {} }
                }

                // Close button — only visible on hover
                Item {
                    id: closeBtn

                    anchors.right: parent.right
                    anchors.rightMargin: FmTheme.padding.md
                    anchors.verticalCenter: parent.verticalCenter
                    implicitWidth: closeIcon.implicitWidth + FmTheme.padding.sm * 2
                    implicitHeight: closeIcon.implicitHeight + FmTheme.padding.sm * 2
                    opacity: tabItem.isHovered ? 1 : 0

                    Behavior on opacity { Anim {} }

                    MaterialIcon {
                        id: closeIcon

                        anchors.centerIn: parent
                        text: "close"
                        color: FmTheme.palette.onSurfaceVariant
                        font.pointSize: FmTheme.font.size.sm
                    }

                    StateLayer {
                        radius: FmTheme.rounding.full
                        onClicked: {
                            if (root.tabManager) {
                                if (!root.tabManager.closeTab(tabItem.index))
                                    root.closeRequested();
                            }
                        }
                    }
                }
            }
        }
    }
}
