import Symmetria.FileManager.UI
import Symmetria.FileManager.Models
import QtQuick
import QtQuick.Layouts

Loader {
    id: root

    property WindowState windowState

    // Positioning inputs from MillerColumns — coordinates relative to FileManager
    property real targetItemY: 0
    property real targetColumnX: 0
    property real targetColumnWidth: 0

    anchors.fill: parent

    opacity: windowState && windowState.activeModal === windowState.modalRename ? 1 : 0
    active: windowState && windowState.activeModal === windowState.modalRename
    asynchronous: true

    sourceComponent: FocusScope {
        id: popupScope

        // Snapshot on creation — Loader destroys/recreates each activation
        property string originalPath
        property string originalName
        property bool includeExtension

        Component.onCompleted: {
            originalPath = root.windowState.renameTargetPath;
            includeExtension = root.windowState.renameIncludeExtension;

            // Extract filename from path
            const lastSlash = originalPath.lastIndexOf("/");
            originalName = originalPath.substring(lastSlash + 1);

            // Pre-fill and set selection after the TextInput is ready
            renameInput.text = originalName;
            Qt.callLater(_applySelection);
        }

        function _applySelection(): void {
            renameInput.forceActiveFocus();
            if (includeExtension) {
                renameInput.selectAll();
            } else {
                const dotIndex = originalName.lastIndexOf(".");
                if (dotIndex > 0)
                    renameInput.select(0, dotIndex);
                else
                    renameInput.selectAll();
            }
        }

        // Click outside the card to dismiss — no scrim
        MouseArea {
            anchors.fill: parent
            onClicked: root.windowState.closeModal()
        }

        // Dialog card — claymorphism (shared PillCard), positioned below the
        // selected item, aligned to the file list column
        PillCard {
            id: renameDialog

            // Horizontal: align to the current file list column
            x: root.targetColumnX
            width: Math.min(root.targetColumnWidth, 360)

            // Vertical: just below the selected item, clamped to stay in bounds
            y: {
                const desiredY = root.targetItemY;
                const maxY = parent.height - renameDialog.implicitHeight - FmTheme.padding.lg;
                return Math.max(FmTheme.padding.sm, Math.min(desiredY, maxY));
            }

            implicitHeight: renameLayout.implicitHeight + FmTheme.padding.lg * 3

            // Block clicks from reaching the dismiss MouseArea
            MouseArea {
                anchors.fill: parent
            }

            ColumnLayout {
                id: renameLayout

                anchors.fill: parent
                anchors.margins: FmTheme.padding.lg * 1.5
                spacing: FmTheme.spacing.md

                // Label row
                RowLayout {
                    spacing: FmTheme.spacing.sm

                    MaterialIcon {
                        text: "edit"
                        color: FmTheme.palette.primary
                        font.pointSize: FmTheme.font.size.lg
                    }

                    StyledText {
                        text: qsTr("Rename:")
                        color: FmTheme.palette.onSurface
                        font.pointSize: FmTheme.font.size.md
                        font.weight: Font.DemiBold
                    }
                }

                // Text input container
                StyledRect {
                    Layout.fillWidth: true
                    radius: FmTheme.rounding.sm
                    color: Qt.alpha(FmTheme.palette.onSurface, 0.06)
                    implicitHeight: renameInput.implicitHeight + FmTheme.padding.md * 2

                    TextInput {
                        id: renameInput

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

                        Keys.onPressed: function(event) {
                            if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                                popupScope._attemptRename();
                                event.accepted = true;
                            } else if (event.key === Qt.Key_Escape) {
                                root.windowState.closeModal();
                                event.accepted = true;
                            } else if (event.key === Qt.Key_Tab) {
                                // Toggle between name-only and full-name selection
                                popupScope.includeExtension = !popupScope.includeExtension;
                                popupScope._applySelection();
                                event.accepted = true;
                            }
                        }
                    }
                }

                // Inline error (hidden by default)
                StyledText {
                    id: errorLabel

                    Layout.fillWidth: true
                    visible: text !== ""
                    text: ""
                    color: FmTheme.palette.error
                    font.pointSize: FmTheme.font.size.xs
                    font.family: FmTheme.font.family.mono
                    wrapMode: Text.WrapAtWordBoundaryOrAnywhere
                }
            }
        }

        function _attemptRename(): void {
            const newName = renameInput.text.trim();

            if (newName === "" || newName === "." || newName === ".." || newName.indexOf("/") !== -1)
                return;
            if (newName === originalName) {
                root.windowState.closeModal();
                return;
            }
            if (checkProcess.running || renameProcess.running)
                return;

            errorLabel.text = "";

            const parentDir = Paths.parentDir(originalPath);
            const newPath = parentDir + "/" + newName;

            checkProcess.pendingNewPath = newPath;
            checkProcess.pendingNewName = newName;
            checkProcess.command = ["test", "-e", newPath];
            checkProcess.start();
        }

        // Existence check process
        ShellRunner {
            id: checkProcess

            property string pendingNewPath: ""
            property string pendingNewName: ""

            onExited: (exitCode, exitStatus) => {
                if (exitCode === 0) {
                    errorLabel.text = qsTr("'%1' already exists").arg(pendingNewName);
                } else {
                    popupScope._runRename();
                }
            }
        }

        function _runRename(): void {
            renameProcess.command = ["mv", "--", originalPath, checkProcess.pendingNewPath];
            renameProcess.start();
        }

        // Rename process
        ShellRunner {
            id: renameProcess
            onExited: (exitCode, exitStatus) => {
                if (exitCode === 0) {
                    root.windowState.renameCompleted(checkProcess.pendingNewName);
                    root.windowState.closeModal();
                } else {
                    errorLabel.text = qsTr("Rename failed (exit code %1)").arg(exitCode);
                }
            }
        }
    }

    Behavior on opacity {
        Anim {}
    }
}
