import Symmetria.FileManager.UI
import Symmetria.FileManager.Models
import QtQuick
import QtQuick.Layouts

Loader {
    id: root

    property WindowState windowState

    anchors.fill: parent

    opacity: windowState && windowState.activeModal === windowState.modalZoxide ? 1 : 0
    // Drive active from the source property, not from animated opacity — avoids
    // a race where the Loader activates mid-fade-out with an already-closed state.
    active: windowState && windowState.activeModal === windowState.modalZoxide
    asynchronous: true

    sourceComponent: FocusScope {
        id: popupScope

        // Internal state
        property var results: []
        property int selectedIndex: 0
        property bool _dirty: false
        property bool _loading: false

        Component.onCompleted: _runQuery()

        // Stop any in-flight zoxide query when the popup is destroyed (e.g.,
        // user presses Escape while a query is running). Without this the orphaned
        // process fires onStreamFinished / onExited on a destroyed QML object.
        Component.onDestruction: {
            if (zoxideProcess.running)
                zoxideProcess.terminate();
        }

        // === Scrim backdrop — click to cancel ===
        MouseArea {
            anchors.fill: parent
            hoverEnabled: true
            onClicked: root.windowState.closeModal()
        }

        StyledRect {
            anchors.fill: parent
            color: Qt.alpha(FmTheme.palette.shadow, 0.5)
        }

        // === Dialog card — claymorphism (shared PillCard) ===
        PillCard {
            id: dialog

            anchors.centerIn: parent

            width: Math.min(parent.width - FmTheme.padding.lg * 4, 500)
            implicitHeight: dialogLayout.implicitHeight + FmTheme.padding.lg * 3

            scale: 0.1
            Component.onCompleted: scale = 1

            Behavior on scale {
                NumberAnimation {
                    duration: FmTheme.animDuration
                    easing.type: Easing.OutBack
                    easing.overshoot: 1.5
                }
            }

            // Block clicks from reaching the scrim MouseArea
            MouseArea {
                anchors.fill: parent
            }

            // Swallow all keys not handled by searchInput — prevents leaking
            // to components behind the scrim (consistent with DeleteConfirmPopup)
            Keys.onPressed: function(event) {
                event.accepted = true;
            }

            ColumnLayout {
                id: dialogLayout

                anchors.fill: parent
                anchors.margins: FmTheme.padding.lg * 1.5
                spacing: FmTheme.spacing.md

                // Header row
                RowLayout {
                    Layout.alignment: Qt.AlignHCenter
                    spacing: FmTheme.spacing.sm

                    MaterialIcon {
                        text: "jump_to_element"
                        color: FmTheme.palette.primary
                        font.pointSize: FmTheme.font.size.lg
                    }

                    StyledText {
                        text: qsTr("Jump to directory")
                        color: FmTheme.palette.onSurface
                        font.pointSize: FmTheme.font.size.md
                        font.weight: Font.DemiBold
                    }
                }

                // Search input container
                StyledRect {
                    Layout.fillWidth: true
                    radius: FmTheme.rounding.sm
                    color: Qt.alpha(FmTheme.palette.onSurface, 0.06)
                    implicitHeight: searchInput.implicitHeight + FmTheme.padding.md * 2

                    TextInput {
                        id: searchInput

                        anchors.left: parent.left
                        anchors.right: parent.right
                        anchors.verticalCenter: parent.verticalCenter
                        anchors.leftMargin: FmTheme.padding.lg
                        anchors.rightMargin: FmTheme.padding.lg

                        color: FmTheme.palette.onSurface
                        font.pointSize: FmTheme.font.size.sm
                        font.family: FmTheme.font.family.mono
                        selectionColor: FmTheme.palette.primary
                        selectedTextColor: FmTheme.palette.onPrimary
                        clip: true
                        focus: true

                        Component.onCompleted: forceActiveFocus()

                        onTextChanged: debounceTimer.restart()

                        Keys.onPressed: function(event) {
                            if (event.key === Qt.Key_Escape) {
                                root.windowState.closeModal();
                                event.accepted = true;
                            } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                                popupScope._confirmSelection();
                                event.accepted = true;
                            } else if (event.key === Qt.Key_Down
                                       || (event.key === Qt.Key_J && (event.modifiers & Qt.ControlModifier))) {
                                if (popupScope.selectedIndex < popupScope.results.length - 1)
                                    popupScope.selectedIndex++;
                                event.accepted = true;
                            } else if (event.key === Qt.Key_Up
                                       || (event.key === Qt.Key_K && (event.modifiers & Qt.ControlModifier))) {
                                if (popupScope.selectedIndex > 0)
                                    popupScope.selectedIndex--;
                                event.accepted = true;
                            }
                        }
                    }
                }

                // Results list (Repeater — max 10 items, no virtualization needed)
                Column {
                    Layout.fillWidth: true
                    spacing: 2
                    visible: popupScope.results.length > 0

                    Repeater {
                        model: popupScope.results

                        StyledRect {
                            required property var modelData
                            required property int index

                            width: parent.width
                            radius: FmTheme.rounding.sm
                            color: index === popupScope.selectedIndex
                                ? Qt.alpha(FmTheme.palette.primary, 0.15)
                                : "transparent"
                            implicitHeight: resultRow.implicitHeight + FmTheme.padding.sm * 2

                            Behavior on color {
                                CAnim {}
                            }

                            RowLayout {
                                id: resultRow

                                anchors.left: parent.left
                                anchors.right: parent.right
                                anchors.verticalCenter: parent.verticalCenter
                                anchors.leftMargin: FmTheme.padding.md
                                anchors.rightMargin: FmTheme.padding.md
                                spacing: FmTheme.spacing.md

                                // Score (dimmed, right-aligned, fixed width)
                                StyledText {
                                    Layout.preferredWidth: 50
                                    text: Math.round(modelData.score).toString()
                                    color: FmTheme.palette.onSurfaceVariant
                                    font.pointSize: FmTheme.font.size.xs
                                    font.family: FmTheme.font.family.mono
                                    horizontalAlignment: Text.AlignRight
                                }

                                // Path (with ~ substitution, elide in the middle for long paths)
                                StyledText {
                                    Layout.fillWidth: true
                                    text: Paths.shortenHome(modelData.path)
                                    color: index === popupScope.selectedIndex
                                        ? FmTheme.palette.onSurface
                                        : FmTheme.palette.onSurfaceVariant
                                    font.pointSize: FmTheme.font.size.sm
                                    font.family: FmTheme.font.family.mono
                                    elide: Text.ElideMiddle
                                }
                            }

                            StateLayer {
                                onClicked: {
                                    popupScope.selectedIndex = index;
                                    popupScope._confirmSelection();
                                }
                            }
                        }
                    }
                }

                // Empty state — hidden while a query is in progress to avoid a
                // "No matches" flash before the first results arrive.
                StyledText {
                    Layout.fillWidth: true
                    Layout.topMargin: FmTheme.spacing.md
                    visible: popupScope.results.length === 0 && !popupScope._loading
                    text: qsTr("No matches")
                    color: FmTheme.palette.onSurfaceVariant
                    font.pointSize: FmTheme.font.size.sm
                    horizontalAlignment: Text.AlignHCenter
                }
            }
        }

        // === Functions ===

        function _runQuery(): void {
            if (zoxideProcess.running) {
                _dirty = true;
                return;
            }
            const cmd = ["zoxide", "query", "--list", "--score"];
            const queryText = searchInput.text.trim();
            if (queryText !== "") {
                const keywords = queryText.split(/\s+/);
                for (const kw of keywords)
                    cmd.push(kw);
            }
            _loading = true;
            zoxideProcess.command = cmd;
            zoxideProcess.start();
        }

        function _parseResults(text: string): void {
            // Guard: empty stdout (e.g. no-match exit) — nothing to parse.
            if (!text.trim()) {
                results = [];
                selectedIndex = 0;
                return;
            }
            const lines = text.trim().split("\n");
            const parsed = [];
            const maxResults = 10;
            for (let i = 0; i < lines.length && parsed.length < maxResults; i++) {
                const m = lines[i].match(/^\s*([\d.]+)\s+(.+)$/);
                if (m)
                    parsed.push({ score: parseFloat(m[1]), path: m[2] });
            }
            results = parsed;
            selectedIndex = 0;
        }

        function _confirmSelection(): void {
            if (results.length === 0 || selectedIndex < 0 || selectedIndex >= results.length)
                return;
            const targetPath = results[selectedIndex].path;
            // navigate() calls closeModal() internally — popup closes automatically.
            root.windowState.navigate(targetPath);
        }

        // === Debounce timer ===
        Timer {
            id: debounceTimer
            interval: 100
            repeat: false
            onTriggered: popupScope._runQuery()
        }

        // === Zoxide query process ===
        ShellRunner {
            id: zoxideProcess

            onExited: (exitCode, exitStatus) => {
                popupScope._loading = false;
                if (exitCode !== 0) {
                    // Non-zero exit: either no matches (exit 1) or zoxide not found.
                    // ShellRunner exposes both via QProcess (no shell, so no exit
                    // code 127 convention to distinguish them reliably).
                    popupScope.results = [];
                } else {
                    popupScope._parseResults(stdoutText);
                }
                if (popupScope._dirty) {
                    popupScope._dirty = false;
                    popupScope._runQuery();
                }
            }
        }
    }

    Behavior on opacity {
        Anim {}
    }
}
