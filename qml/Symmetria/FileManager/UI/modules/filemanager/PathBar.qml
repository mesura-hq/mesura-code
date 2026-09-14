pragma ComponentBehavior: Bound

import Symmetria.FileManager.UI
import QtQuick
import QtQuick.Layouts

Item {
    id: root

    property WindowState windowState

    // Horizontal inset matching PathBar pill spacing in PathBar and StatusBar
    readonly property real _barHorizontalMargin: FmTheme.padding.lg + FmTheme.padding.md

    implicitHeight: inner.implicitHeight + FmTheme.padding.md * 2

    // Build breadcrumb segments: [{name, path, isHome}]
    readonly property var _segments: {
        if (!windowState) return [];
        const path = windowState.currentPath;
        const home = Paths.home;

        if (path === home)
            return [{name: "~", path: home, isHome: true}];

        if (path.startsWith(home + "/")) {
            const relative = path.slice(home.length + 1).split("/");
            let segments = [{name: "~", path: home, isHome: true}];
            let accumulated = home;
            for (const part of relative) {
                accumulated += "/" + part;
                segments.push({name: part, path: accumulated, isHome: false});
            }
            return segments;
        }

        // Outside home — absolute path
        const parts = path.split("/").filter(p => p !== "");
        let segments = [{name: "/", path: "/", isHome: false}];
        let accumulated = "";
        for (const part of parts) {
            accumulated += "/" + part;
            segments.push({name: part, path: accumulated, isHome: false});
        }
        return segments;
    }

    RowLayout {
        id: inner

        anchors.fill: parent
        anchors.topMargin: FmTheme.padding.md
        anchors.bottomMargin: FmTheme.padding.md
        anchors.leftMargin: root._barHorizontalMargin
        anchors.rightMargin: root._barHorizontalMargin
        spacing: FmTheme.spacing.sm

        // Back button
        Item {
            implicitWidth: implicitHeight
            implicitHeight: Math.max(backIcon.implicitHeight + FmTheme.padding.sm * 2, FmTheme.padding.md)

            StateLayer {
                radius: FmTheme.rounding.sm
                disabled: !root.windowState || !root.windowState.canGoBack
                onClicked: root.windowState.back()
            }

            MaterialIcon {
                id: backIcon

                anchors.centerIn: parent
                text: "arrow_back"
                color: root.windowState && root.windowState.canGoBack ? FmTheme.palette.onSurface : FmTheme.palette.outline
                grade: 200
            }
        }

        // Forward button
        Item {
            implicitWidth: implicitHeight
            implicitHeight: Math.max(forwardIcon.implicitHeight + FmTheme.padding.sm * 2, FmTheme.padding.md)

            StateLayer {
                radius: FmTheme.rounding.sm
                disabled: !root.windowState || !root.windowState.canGoForward
                onClicked: root.windowState.forward()
            }

            MaterialIcon {
                id: forwardIcon

                anchors.centerIn: parent
                text: "arrow_forward"
                color: root.windowState && root.windowState.canGoForward ? FmTheme.palette.onSurface : FmTheme.palette.outline
                grade: 200
            }
        }

        // Breadcrumb bar. `palette.surface` — the base colour, not the matte
        // pill's own fill: this bar spans the full width at the top of the
        // pane, so a fill above the ground reads as a lighter band across the
        // whole app rather than as a control. The hairline border it keeps
        // from PillSurface is what still marks it as a field. Same reasoning,
        // and the same value, as the pane surfaces in MillerColumns.
        PillSurface {
            id: breadcrumbContainer

            color: FmTheme.palette.surface

            Layout.fillWidth: true
            implicitHeight: breadcrumbs.implicitHeight + Math.round(FmTheme.padding.sm / 2) * 2

            RowLayout {
                id: breadcrumbs

                anchors.fill: parent
                anchors.margins: Math.round(FmTheme.padding.sm / 2)
                spacing: 0

                Item { Layout.fillWidth: true } // Left spacer — centers breadcrumbs

                Repeater {
                    model: root._segments

                    RowLayout {
                        id: segment

                        required property var modelData
                        required property int index

                        spacing: 0

                        // Separator "/"
                        StyledText {
                            Layout.rightMargin: 0
                            visible: segment.index > 0
                            text: "/"
                            color: FmTheme.palette.onSurfaceVariant
                            font.bold: true
                        }

                        // Clickable segment
                        Item {
                            implicitWidth: segmentName.implicitWidth + FmTheme.padding.sm * 2
                            implicitHeight: segmentName.implicitHeight + FmTheme.padding.sm * 2

                            // Clickable only if not the last segment
                            Loader {
                                anchors.fill: parent
                                active: segment.index < root._segments.length - 1
                                sourceComponent: StateLayer {
                                    radius: FmTheme.rounding.sm
                                    onClicked: root.windowState.navigate(segment.modelData.path)
                                }
                            }

                            StyledText {
                                id: segmentName

                                anchors.centerIn: parent

                                text: segment.modelData.name
                                color: segment.index < root._segments.length - 1 ? FmTheme.palette.onSurfaceVariant : FmTheme.palette.onSurface
                                font.bold: true
                            }
                        }
                    }
                }

                Item { Layout.fillWidth: true } // Right spacer — centers breadcrumbs
            }
        }

        // Hidden files toggle
        Item {
            implicitWidth: implicitHeight
            implicitHeight: Math.max(hiddenIcon.implicitHeight + FmTheme.padding.sm * 2, FmTheme.padding.md)

            StateLayer {
                radius: FmTheme.rounding.sm
                onClicked: {
                    Config.fileManager.showHidden = !Config.fileManager.showHidden;
                    Config.save();
                }
            }

            MaterialIcon {
                id: hiddenIcon

                anchors.centerIn: parent
                text: Config.fileManager.showHidden ? "visibility" : "visibility_off"
                color: Config.fileManager.showHidden ? FmTheme.palette.onSurface : FmTheme.palette.outline
                grade: 200
            }
        }
    }
}
