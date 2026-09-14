import Symmetria.FileManager.UI
import QtQuick
import QtQuick.Layouts

Item {
    id: root

    property WindowState windowState

    readonly property var _binds: {
        if (!windowState) return [];

        // Bookmark delete sub-mode: show only user-defined bookmarks
        if (windowState.bookmarkSubMode === "delete") {
            const bms = BookmarkService.bookmarks;
            return Object.entries(bms).map(([key, bm]) => ({
                key: key, label: bm.label, icon: BookmarkService.iconForPath(bm.path), isUser: true
            })).sort((a, b) => a.key.localeCompare(b.key));
        }

        // Bookmark create sub-mode: show no binds (just the prompt header)
        if (windowState.bookmarkSubMode === "create")
            return [];

        // Normal chord mode
        const prefix = windowState.activeChordPrefix;
        if (prefix === "")
            return [];
        const bindings = windowState.chordBindings;
        return bindings.hasOwnProperty(prefix) ? bindings[prefix].binds : [];
    }

    visible: opacity > 0
    opacity: windowState && (windowState.chordActive || windowState.bookmarkSubModeActive) ? 1 : 0

    Behavior on opacity {
        Anim {}
    }

    // Claymorphism card background (shared PillCard). Keeps the compact `sm`
    // rounding — this is a small HUD, so the card's default `lg` would look
    // overly bubbly here; the clay depth + rim still apply.
    PillCard {
        anchors.fill: parent
        radius: FmTheme.rounding.sm
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: FmTheme.padding.md
        spacing: FmTheme.spacing.sm

        // Header: prefix key badge + group label
        RowLayout {
            Layout.fillWidth: true
            spacing: FmTheme.spacing.sm

            Rectangle {
                width: root.windowState && root.windowState.bookmarkSubModeActive ? 32 : 22
                height: 22
                radius: 6
                color: Qt.alpha(FmTheme.palette.primary, 0.18)

                StyledText {
                    anchors.centerIn: parent
                    text: {
                        if (!root.windowState) return "";
                        if (root.windowState.bookmarkSubMode === "create") return "gn";
                        if (root.windowState.bookmarkSubMode === "delete") return "gx";
                        return root.windowState.activeChordPrefix;
                    }
                    color: FmTheme.palette.primary
                    font.family: FmTheme.font.family.mono
                    font.pointSize: FmTheme.font.size.sm
                    font.weight: Font.Bold
                }
            }

            StyledText {
                text: {
                    if (!root.windowState) return "";
                    if (root.windowState.bookmarkSubMode === "create")
                        return "assign letter for " + Paths.shortenHome(root.windowState.currentPath);
                    if (root.windowState.bookmarkSubMode === "delete")
                        return "delete bookmark";
                    const prefix = root.windowState.activeChordPrefix;
                    if (prefix === "") return "";
                    const bindings = root.windowState.chordBindings;
                    return bindings.hasOwnProperty(prefix) ? bindings[prefix].label : "";
                }
                color: FmTheme.palette.onSurfaceVariant
                font.pointSize: FmTheme.font.size.sm
                font.weight: Font.Medium
            }
        }

        // Thin separator
        Rectangle {
            Layout.fillWidth: true
            height: 1
            color: FmTheme.overlay.subtle
        }

        // Binding rows
        Repeater {
            model: root._binds

            // Separator or keybind row — chosen by visibility, no Loader needed
            ColumnLayout {
                Layout.fillWidth: true
                spacing: 0

                // Thin separator (only for separator entries)
                Rectangle {
                    Layout.fillWidth: true
                    height: 1
                    visible: modelData.isSeparator === true
                    color: FmTheme.overlay.subtle
                }

                // Keybind row (hidden for separator entries)
                RowLayout {
                    Layout.fillWidth: true
                    visible: modelData.isSeparator !== true
                    spacing: FmTheme.spacing.sm

                    // Keycap badge — user bookmarks get a primary tint
                    Rectangle {
                        width: 22
                        height: 22
                        radius: 6
                        color: modelData.isUser ? Qt.alpha(FmTheme.palette.primary, 0.15)
                                                : Qt.alpha("#ffffff", 0.06)
                        border.color: modelData.isUser ? Qt.alpha(FmTheme.palette.primary, 0.30)
                                                       : FmTheme.overlay.emphasis
                        border.width: 1

                        StyledText {
                            anchors.centerIn: parent
                            text: modelData.key ?? ""
                            color: modelData.isUser ? FmTheme.palette.primary
                                                    : FmTheme.palette.onSurface
                            font.family: FmTheme.font.family.mono
                            font.pointSize: FmTheme.font.size.xs
                            font.weight: Font.DemiBold
                        }
                    }

                    // Icon
                    MaterialIcon {
                        text: modelData.icon ?? ""
                        color: modelData.isAction ? Qt.alpha(FmTheme.palette.onSurfaceVariant, 0.6)
                                                  : FmTheme.palette.onSurfaceVariant
                        font.pointSize: FmTheme.font.size.md
                    }

                    // Label
                    StyledText {
                        text: modelData.label ?? ""
                        color: modelData.isAction ? Qt.alpha(FmTheme.palette.onSurface, 0.6)
                                                  : FmTheme.palette.onSurface
                        font.pointSize: FmTheme.font.size.sm
                    }
                }
            }
        }

        // Push bindings to top
        Item {
            Layout.fillHeight: true
        }
    }
}
