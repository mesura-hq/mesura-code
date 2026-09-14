pragma ComponentBehavior: Bound

// HelpPopup — the `?`-triggered keyboard cheat-sheet. Renders entirely from
// KeyRegistry.js (the single source of truth) plus the static "Modes" rows, so
// a binding added to the registry appears here automatically. Modal gated on
// WindowState.modalHelp, following the same Loader pattern as ZoxidePopup et al.
//
// Self-contained read-side component: it never executes a binding's run(), only
// displays its metadata (keycap / label / icon / group), and hides any binding
// suppressed by the current picker state so the sheet never lies.

import Symmetria.FileManager.UI
import QtQuick
import QtQuick.Layouts
import QtQuick.Controls
import "handlers/KeyRegistry.js" as KeyRegistry

Loader {
    id: root

    property WindowState windowState

    anchors.fill: parent

    // Single source for visibility; `active` is driven from THIS (not the
    // animated opacity) to avoid a race where the Loader activates mid-fade-out
    // with an already-closed state.
    readonly property bool _shown: windowState && windowState.activeModal === windowState.modalHelp

    opacity: _shown ? 1 : 0
    active: _shown
    asynchronous: true

    sourceComponent: FocusScope {
        id: popupScope

        focus: true

        // Escape or ? closes. Lives on the FocusScope (the item that actually
        // holds active focus) — NOT on the card, which never receives key events.
        // Everything else is swallowed so keys don't leak past the scrim.
        Keys.onPressed: function(event) {
            if (event.key === Qt.Key_Escape || event.key === Qt.Key_Question)
                root.windowState.closeModal();
            event.accepted = true;
        }

        // Which view's bindings to show — the active tab's view mode.
        readonly property string viewKind: root.windowState && root.windowState.viewMode === root.windowState.viewTree ? "tree" : "miller"
        // Two balanced columns of grouped sections, rebuilt when the view flips.
        readonly property var columns: popupScope._buildColumns(viewKind)

        Component.onCompleted: forceActiveFocus()

        // Build the ordered, grouped, picker-filtered section list for a view.
        // "Chords" is intentionally absent from this order: the registry's bare
        // chord-prefix rows are for DISPATCH; the help instead renders the full
        // chord tree from windowState.chordBindings (see _chordSections), the
        // same source the live WhichKeyPopup HUD reads — one definition, two
        // surfaces.
        function _sectionsFor(kind: string): var {
            // Group order is owned by KeyRegistry.HELP_GROUPS (single source);
            // "Chords" is dropped here because the chord tree is rendered
            // separately from chordBindings (see _chordSections).
            const order = KeyRegistry.HELP_GROUPS.filter(function(g) { return g !== "Chords"; });
            const binds = KeyRegistry.bindingsFor(kind).filter(function(b) {
                return b.group !== "Chords" && !KeyRegistry.isSuppressedInPicker(b, FileManagerService);
            });
            const byGroup = {};
            for (let i = 0; i < binds.length; i++) {
                const g = binds[i].group;
                (byGroup[g] = byGroup[g] || []).push(binds[i]);
            }
            const sections = [];
            for (let i = 0; i < order.length; i++) {
                if (byGroup[order[i]])
                    sections.push({ title: order[i], rows: byGroup[order[i]] });
            }
            // Chord sub-menus, from the shared chordBindings source.
            const chordSections = popupScope._chordSections();
            for (let i = 0; i < chordSections.length; i++)
                sections.push(chordSections[i]);
            // Text-input modes are not registry bindings — appended statically.
            sections.push({ title: "Modes", rows: KeyRegistry.MODES });
            return sections;
        }

        // One section per chord prefix, built from windowState.chordBindings.
        // Each row's keycap is the full chord (prefix + the bind's key), e.g.
        // "gg", "cf", ",a/A". Separators are dropped; user bookmarks and the
        // built-in actions both render (they carry label/icon already).
        function _chordSections(): var {
            const cb = root.windowState ? root.windowState.chordBindings : null;
            if (!cb)
                return [];
            const prefixes = ["g", "c", ","];
            const out = [];
            for (let p = 0; p < prefixes.length; p++) {
                const prefix = prefixes[p];
                if (!cb[prefix])
                    continue;
                const rows = [];
                const binds = cb[prefix].binds;
                for (let i = 0; i < binds.length; i++) {
                    if (binds[i].isSeparator)
                        continue;
                    rows.push({ keycap: prefix + binds[i].key, label: binds[i].label, icon: binds[i].icon });
                }
                out.push({ title: prefix + " · " + cb[prefix].label, rows: rows });
            }
            return out;
        }

        // Greedy balance: assign each section to the currently-shorter column.
        function _buildColumns(kind: string): var {
            const sections = popupScope._sectionsFor(kind);
            const left = [], right = [];
            let lh = 0, rh = 0;
            for (let i = 0; i < sections.length; i++) {
                const weight = sections[i].rows.length + 1; // +1 for the header
                if (lh <= rh) { left.push(sections[i]); lh += weight; }
                else { right.push(sections[i]); rh += weight; }
            }
            return [left, right];
        }

        // === Scrim backdrop — click to dismiss ===
        MouseArea {
            anchors.fill: parent
            hoverEnabled: true
            onClicked: root.windowState.closeModal()
        }

        StyledRect {
            anchors.fill: parent
            color: Qt.alpha(FmTheme.palette.shadow, 0.5)
        }

        // === Dialog card ===
        PillCard {
            id: dialog

            anchors.centerIn: parent

            width: Math.min(parent.width - FmTheme.padding.lg * 4, 760)
            implicitHeight: Math.min(contentLayout.implicitHeight + FmTheme.padding.lg * 3,
                                     parent.height - FmTheme.padding.lg * 4)

            scale: 0.1
            Component.onCompleted: scale = 1

            Behavior on scale {
                NumberAnimation {
                    duration: FmTheme.animDuration
                    easing.type: Easing.OutBack
                    easing.overshoot: 1.5
                }
            }

            // Block clicks from reaching the scrim MouseArea.
            MouseArea {
                anchors.fill: parent
            }

            ColumnLayout {
                id: contentLayout

                anchors.fill: parent
                anchors.margins: FmTheme.padding.lg * 1.5
                spacing: FmTheme.spacing.md

                // Header
                RowLayout {
                    Layout.fillWidth: true
                    spacing: FmTheme.spacing.sm

                    MaterialIcon {
                        text: "keyboard"
                        color: FmTheme.palette.primary
                        font.pointSize: FmTheme.font.size.lg
                    }

                    StyledText {
                        text: qsTr("Keyboard shortcuts")
                        color: FmTheme.palette.onSurface
                        font.pointSize: FmTheme.font.size.md
                        font.weight: Font.DemiBold
                    }

                    Item { Layout.fillWidth: true }

                    StyledText {
                        text: popupScope.viewKind === "tree" ? qsTr("Tree view") : qsTr("Miller view")
                        color: FmTheme.palette.onSurfaceVariant
                        font.pointSize: FmTheme.font.size.xs
                        font.family: FmTheme.font.family.mono
                    }
                }

                Rectangle {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 1
                    color: FmTheme.overlay.subtle
                }

                // Scrollable two-column body
                Flickable {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    // A Flickable has NO implicit height of its own. Without
                    // this, the enclosing ColumnLayout counts the body as 0px,
                    // so the dialog's implicitHeight sums only header+separator+
                    // footer and the card collapses (the body squeezes to ~0).
                    // preferredHeight feeds the real content height into the
                    // layout; fillHeight then lets it shrink + scroll when the
                    // dialog hits its parent.height cap.
                    Layout.preferredHeight: columnsRow.implicitHeight

                    contentHeight: columnsRow.implicitHeight
                    clip: true
                    boundsBehavior: Flickable.StopAtBounds

                    ScrollBar.vertical: SlimScrollBar {
                        policy: ScrollBar.AsNeeded
                    }

                    RowLayout {
                        id: columnsRow

                        width: parent.width
                        spacing: FmTheme.spacing.lg * 2

                        // Two columns of sections
                        Repeater {
                            model: popupScope.columns

                            ColumnLayout {
                                id: colDelegate

                                required property var modelData

                                Layout.fillWidth: true
                                Layout.preferredWidth: 1 // equal split via fillWidth
                                Layout.alignment: Qt.AlignTop
                                spacing: FmTheme.spacing.lg

                                Repeater {
                                    model: colDelegate.modelData

                                    // One group section: title + its binding rows
                                    ColumnLayout {
                                        id: secDelegate

                                        required property var modelData

                                        Layout.fillWidth: true
                                        spacing: FmTheme.spacing.xs

                                        StyledText {
                                            text: secDelegate.modelData.title
                                            color: FmTheme.palette.primary
                                            font.pointSize: FmTheme.font.size.xs
                                            font.weight: Font.Bold
                                        }

                                        Repeater {
                                            model: secDelegate.modelData.rows

                                            RowLayout {
                                                id: rowDelegate

                                                required property var modelData

                                                Layout.fillWidth: true
                                                spacing: FmTheme.spacing.sm

                                                // Keycap badge — sizes to its label
                                                Rectangle {
                                                    radius: 6
                                                    implicitWidth: Math.max(22, capText.implicitWidth + 12)
                                                    implicitHeight: 20
                                                    color: Qt.alpha("#ffffff", 0.06)
                                                    border.color: FmTheme.overlay.emphasis
                                                    border.width: 1

                                                    StyledText {
                                                        id: capText
                                                        anchors.centerIn: parent
                                                        text: rowDelegate.modelData.keycap ?? ""
                                                        color: FmTheme.palette.onSurface
                                                        font.family: FmTheme.font.family.mono
                                                        font.pointSize: FmTheme.font.size.xs
                                                        font.weight: Font.DemiBold
                                                    }
                                                }

                                                MaterialIcon {
                                                    text: rowDelegate.modelData.icon ?? ""
                                                    color: FmTheme.palette.onSurfaceVariant
                                                    font.pointSize: FmTheme.font.size.sm
                                                }

                                                StyledText {
                                                    Layout.fillWidth: true
                                                    text: rowDelegate.modelData.label ?? ""
                                                    color: FmTheme.palette.onSurface
                                                    font.pointSize: FmTheme.font.size.xs
                                                    elide: Text.ElideRight
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // Footer hint
                StyledText {
                    Layout.fillWidth: true
                    Layout.topMargin: FmTheme.spacing.xs
                    text: qsTr("Press ? or Esc to close")
                    color: FmTheme.palette.onSurfaceVariant
                    font.pointSize: FmTheme.font.size.xs
                    horizontalAlignment: Text.AlignHCenter
                }
            }
        }
    }

    Behavior on opacity {
        Anim {}
    }
}
