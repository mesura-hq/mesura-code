pragma ComponentBehavior: Bound

import Symmetria.FileManager.UI
import Symmetria.FileManager.Models
import QtQuick
import QtQuick.Layouts

Loader {
    id: root

    property WindowState windowState

    // Embedder seam (Symmetria IDE). When true, confirming a selection
    // emits `activated(path, isDir)` INSTEAD of the FM-native flow
    // (navigate to the parent dir + focus the file in the list). Hosts
    // that open files in their own surface — the IDE routes files to
    // nvim via RPC — set this and handle the signal; the FM's own
    // instance keeps the default. recordOpen() fires on both paths, but it
    // writes fff's QUERY TRACKER, not frecency — and that record is keyed on
    // the absolute index root, so a host shares the learning only when it
    // indexes the identical root. See FuzzyFinder::recordOpen.
    property bool externalActivation: false

    signal activated(string path, bool isDir)

    anchors.fill: parent

    opacity: windowState && windowState.activeModal === windowState.modalFuzzyFinder ? 1 : 0
    // Drive active from the source property, not from animated opacity — avoids
    // a race where the Loader activates mid-fade-out with an already-closed state.
    active: windowState && windowState.activeModal === windowState.modalFuzzyFinder
    asynchronous: true

    sourceComponent: FocusScope {
        id: popupScope

        property int selectedIndex: 0

        // Rich data for the highlighted row, populated from the model's roles.
        // QAbstractListModel.data() is not reactive on selectedIndex, so we read
        // it explicitly whenever the selection or the result set changes.
        property var selectedEntry: ({})

        Component.onCompleted: fuzzyModel.searchPath = root.windowState.currentPath;

        Component.onDestruction: fuzzyModel.clear()

        onSelectedIndexChanged: popupScope._refreshSelected()

        // === Rust fff file-search model ===
        FuzzyFinder {
            id: fuzzyModel
            showHidden: Config.fileManager.showHidden
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

            // Widen to make room for the File Info panel once there are results.
            // Caps are the natural max; Math.min still clamps to the window on
            // small screens. The Info panel is pinned at 360, so the extra width
            // flows into the results list (more of each path visible).
            width: Math.min(parent.width - FmTheme.padding.lg * 4,
                            fuzzyModel.resultCount > 0 ? 1080 : 672)
            implicitHeight: Math.min(dialogLayout.implicitHeight + FmTheme.padding.lg * 3,
                                     parent.height - FmTheme.padding.lg * 4)

            scale: 0.1
            Component.onCompleted: scale = 1

            Behavior on width {
                Anim {}
            }

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

            // Swallow all keys not handled by searchInput
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
                        text: "search"
                        color: FmTheme.palette.primary
                        font.pointSize: FmTheme.font.size.lg
                    }

                    StyledText {
                        text: qsTr("Find file")
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
                                if (popupScope.selectedIndex < fuzzyModel.resultCount - 1)
                                    popupScope.selectedIndex++;
                                resultsList.positionViewAtIndex(popupScope.selectedIndex, ListView.Contain);
                                event.accepted = true;
                            } else if (event.key === Qt.Key_Up
                                       || (event.key === Qt.Key_K && (event.modifiers & Qt.ControlModifier))) {
                                if (popupScope.selectedIndex > 0)
                                    popupScope.selectedIndex--;
                                resultsList.positionViewAtIndex(popupScope.selectedIndex, ListView.Contain);
                                event.accepted = true;
                            }
                        }
                    }
                }

                // Result count and scanning indicator
                RowLayout {
                    Layout.fillWidth: true
                    spacing: FmTheme.spacing.md

                    StyledText {
                        text: fuzzyModel.resultCount + " " + qsTr("results")
                        color: FmTheme.palette.onSurfaceVariant
                        font.pointSize: FmTheme.font.size.xs
                        font.family: FmTheme.font.family.mono
                        visible: fuzzyModel.resultCount > 0
                    }

                    StyledText {
                        text: qsTr("Scanning…")
                        color: FmTheme.palette.primary
                        font.pointSize: FmTheme.font.size.xs
                        font.family: FmTheme.font.family.mono
                        visible: fuzzyModel.scanning
                    }

                    Item { Layout.fillWidth: true }
                }

                // Results list (left) + File Info panel (right)
                RowLayout {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    spacing: FmTheme.spacing.md

                    // === Results ListView (virtualized — up to 200 items) ===
                    ListView {
                        id: resultsList

                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        Layout.minimumWidth: 240
                        Layout.preferredHeight: 432
                        clip: true

                        model: fuzzyModel
                        boundsBehavior: Flickable.StopAtBounds

                        delegate: FuzzyFinderResultDelegate {
                            // selectedIndex bound here so the delegate can shade itself
                            // without querying back up to popupScope on every paint.
                            selectedIndex: popupScope.selectedIndex
                            onActivated: {
                                popupScope.selectedIndex = index;
                                popupScope._confirmSelection();
                            }
                        }
                    }

                    // === File Info panel (size/type/git/modified + shared preview) ===
                    FuzzyFinderInfoPanel {
                        // Hard-cap the width: without max/min, the long filename and
                        // wide preview blow this column out to full width and starve
                        // the results ListView (preferredWidth alone is only a hint).
                        Layout.preferredWidth: 360
                        Layout.minimumWidth: 360
                        Layout.maximumWidth: 360
                        Layout.fillWidth: false
                        Layout.fillHeight: true
                        visible: fuzzyModel.resultCount > 0

                        entry: popupScope.selectedEntry
                        windowState: root.windowState
                    }
                }

                // Empty state
                StyledText {
                    Layout.fillWidth: true
                    Layout.topMargin: FmTheme.spacing.md
                    visible: fuzzyModel.resultCount === 0
                             && !fuzzyModel.scanning
                             && !fuzzyModel.loading
                             && searchInput.text.length > 0
                    text: qsTr("No matches")
                    color: FmTheme.palette.onSurfaceVariant
                    font.pointSize: FmTheme.font.size.sm
                    horizontalAlignment: Text.AlignHCenter
                }

                // Engine/index error — shown when fff failed to create or index.
                StyledText {
                    Layout.fillWidth: true
                    Layout.topMargin: FmTheme.spacing.sm
                    visible: fuzzyModel.error.length > 0
                    text: fuzzyModel.error
                    color: FmTheme.palette.error
                    font.pointSize: FmTheme.font.size.xs
                    horizontalAlignment: Text.AlignHCenter
                    wrapMode: Text.WordWrap
                }
            }
        }

        // === Functions ===

        function _confirmSelection(): void {
            if (fuzzyModel.resultCount === 0 || popupScope.selectedIndex < 0
                || popupScope.selectedIndex >= fuzzyModel.resultCount)
                return;

            // Read data BEFORE closing the modal — closeModal() deactivates the
            // Loader, which fires Component.onDestruction and clears fuzzyModel.
            const idx = fuzzyModel.index(popupScope.selectedIndex, 0);
            const targetFullPath = fuzzyModel.data(idx, FuzzyFinder.FullPathRole);
            const targetIsDir = fuzzyModel.data(idx, FuzzyFinder.IsDirRole);
            const targetName = fuzzyModel.data(idx, FuzzyFinder.NameRole);

            // Record the open in fff's QUERY TRACKER — it does NOT teach
            // frecency; see FuzzyFinder::recordOpen for the evidence.
            // Synchronous read of the path happens inside recordOpen before
            // the model is cleared.
            fuzzyModel.recordOpen(popupScope.selectedIndex, searchInput.text);

            root.windowState.closeModal();

            // Embedder seam: hand the selection to the host and stop —
            // no FM-side navigation. Emitted AFTER closeModal() so the
            // host's focus handling sees the modal already gone.
            if (root.externalActivation) {
                root.activated(targetFullPath, targetIsDir);
                return;
            }

            if (targetIsDir) {
                root.windowState.navigate(targetFullPath);
            } else {
                // Navigate to the file's parent directory and focus the file.
                // Emit fuzzyFinderNavigated BEFORE navigate — this sets _pendingFocusName
                // in FileList so the cursor lands on the file after the path change.
                // For same-directory files, navigate() returns early, but the signal
                // handler in FileList handles immediate focus in that case.
                const parentPath = Paths.parentDir(targetFullPath);
                // INVARIANT: fuzzyFinderNavigated MUST be emitted BEFORE navigate().
                // FileTreeView._rebuildRows matches the pending file by depth=0,
                // relying on the tree's root already being the file's parent when
                // the rebuild fires. Swapping the order breaks cross-dir focus.
                root.windowState.fuzzyFinderNavigated(targetName);
                root.windowState.navigate(parentPath);
            }
        }

        // Read the highlighted row's roles into selectedEntry (data() is not a
        // reactive binding source, so this is called on selection/result changes).
        function _refreshSelected(): void {
            if (fuzzyModel.resultCount === 0 || popupScope.selectedIndex < 0
                || popupScope.selectedIndex >= fuzzyModel.resultCount) {
                popupScope.selectedEntry = ({});
                return;
            }
            const idx = fuzzyModel.index(popupScope.selectedIndex, 0);
            popupScope.selectedEntry = {
                name:      fuzzyModel.data(idx, FuzzyFinder.NameRole),
                fullPath:  fuzzyModel.data(idx, FuzzyFinder.FullPathRole),
                isDir:     fuzzyModel.data(idx, FuzzyFinder.IsDirRole),
                size:      fuzzyModel.data(idx, FuzzyFinder.SizeRole),
                modified:  fuzzyModel.data(idx, FuzzyFinder.ModifiedRole),
                gitStatus: fuzzyModel.data(idx, FuzzyFinder.GitStatusRole),
                isBinary:  fuzzyModel.data(idx, FuzzyFinder.IsBinaryRole),
            };
        }

        // === Debounce timer ===
        Timer {
            id: debounceTimer
            interval: 100
            repeat: false
            onTriggered: {
                fuzzyModel.query = searchInput.text;
                popupScope.selectedIndex = 0;
            }
        }

        // Reset selection when results change, and refresh the File Info panel
        // (selectedIndex may stay 0 across a result reset, so refresh explicitly).
        Connections {
            target: fuzzyModel
            function onResultCountChanged() {
                popupScope.selectedIndex = 0;
                popupScope._refreshSelected();
            }
        }
    }

    Behavior on opacity {
        Anim {}
    }
}
