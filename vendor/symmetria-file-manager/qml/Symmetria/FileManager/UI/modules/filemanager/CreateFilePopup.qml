pragma ComponentBehavior: Bound

import Symmetria.FileManager.UI
import Symmetria.FileManager.Models
import QtQuick
import QtQuick.Layouts

Loader {
    id: root

    property WindowState windowState

    anchors.fill: parent

    opacity: windowState && windowState.activeModal === windowState.modalCreate ? 1 : 0
    // Drive active from the source property, not from animated opacity — avoids
    // a race where the Loader activates mid-fade-out with an already-closed state.
    active: windowState && windowState.activeModal === windowState.modalCreate
    asynchronous: true

    sourceComponent: FocusScope {
        id: popupScope

        // Snapshot path on creation — this component is destroyed/recreated each
        // time the Loader reactivates (active flips false→true), so onCompleted
        // always captures the correct path even though the target may change
        // while the popup is visible. createTargetDir is set by requestCreate
        // (Miller: currentPath; tree: hovered dir); the currentPath fallback
        // covers any non-keyboard caller that opens the modal directly.
        property string basePath

        // Internal state: populated by _attemptCreate, consumed by _runCreate
        property string _currentInput: ""
        property bool _isDirectory: false

        Component.onCompleted: basePath = root.windowState.createTargetDir || root.windowState.currentPath

        // Click outside the card to dismiss — NO dark scrim
        MouseArea {
            anchors.fill: parent
            onClicked: root.windowState.closeModal()
        }

        // Dialog card — claymorphism (shared PillCard), positioned at top-third
        // of file list area
        PillCard {
            id: createDialog

            anchors.horizontalCenter: parent.horizontalCenter
            y: parent.height * 0.2

            width: Math.min(parent.width - FmTheme.padding.lg * 4, 360)
            implicitHeight: createLayout.implicitHeight + FmTheme.padding.lg * 3

            // Component is always created with activeModal === modalCreate (Loader
            // active is driven by it), so the initial scale is always 1.
            scale: 1

            Behavior on scale {
                NumberAnimation {
                    duration: FmTheme.animDuration
                    easing.type: Easing.OutBack
                    easing.overshoot: 1.5
                }
            }

            // Block clicks from reaching the dismiss MouseArea
            MouseArea {
                anchors.fill: parent
            }

            ColumnLayout {
                id: createLayout

                anchors.fill: parent
                anchors.margins: FmTheme.padding.lg * 1.5
                spacing: FmTheme.spacing.md

                // Label row
                RowLayout {
                    spacing: FmTheme.spacing.sm

                    MaterialIcon {
                        text: "add"
                        color: FmTheme.palette.primary
                        font.pointSize: FmTheme.font.size.lg
                    }

                    StyledText {
                        text: qsTr("Create:")
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
                    implicitHeight: createInput.implicitHeight + FmTheme.padding.md * 2

                    TextInput {
                        id: createInput

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

                        Keys.onPressed: function(event) {
                            if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                                popupScope._attemptCreate();
                                event.accepted = true;
                            } else if (event.key === Qt.Key_Escape) {
                                root.windowState.closeModal();
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

        function _attemptCreate(): void {
            const rawInput = createInput.text.trim();

            // Reject empty input or input that is only slashes (e.g. "/", "///")
            if (rawInput === "" || rawInput.replace(/\//g, "") === "")
                return;
            if (checkProcess.running || mkdirProcess.running || createProcess.running)
                return;

            errorLabel.text = "";

            _isDirectory = rawInput.endsWith("/");
            _currentInput = rawInput;

            const topLevelName = rawInput.split("/")[0];

            // Check if the top-level entry already exists.
            // No -- needed: basePath is always absolute, so the path can never
            // be mistaken for a flag.  test(1) does not support -- anyway.
            checkProcess.command = ["test", "-e", basePath + "/" + topLevelName];
            checkProcess.start();
        }

        function _runCreate(): void {
            const cleanedInput = _currentInput.replace(/\/+$/, "");
            const fullPath = basePath + "/" + cleanedInput;
            const topLevelName = cleanedInput.split("/")[0];

            // Emit focus signal BEFORE starting the process — mkdir -p triggers
            // QFileSystemWatcher immediately, so the pending focus name must already
            // be set in FileList when onEntriesChanged fires.
            root.windowState.createCompleted(topLevelName);

            if (_isDirectory) {
                // Directory: single mkdir -p suffices; pass args as array (no shell).
                createProcess.command = ["mkdir", "-p", "--", fullPath];
                createProcess.start();
            } else {
                const lastSlash = fullPath.lastIndexOf("/");
                const parentDir = fullPath.substring(0, lastSlash);
                if (parentDir !== basePath) {
                    // Nested file: first create intermediate dirs, then touch the file
                    // in mkdirProcess.onExited. Two separate ShellRunner objects avoid sh -c.
                    mkdirProcess.pendingTouchPath = fullPath;
                    mkdirProcess.command = ["mkdir", "-p", "--", parentDir];
                    mkdirProcess.start();
                } else {
                    // Top-level file: no intermediate dirs needed — touch directly.
                    createProcess.command = ["touch", "--", fullPath];
                    createProcess.start();
                }
            }
        }

        // Existence check process
        ShellRunner {
            id: checkProcess
            onExited: (exitCode, exitStatus) => {
                if (exitCode === 0) {
                    // Already exists — show inline error and move the cursor to
                    // the conflicting entry in the background so the user sees
                    // what they're colliding with while the popup stays open.
                    const topLevelName = popupScope._currentInput.split("/")[0];
                    errorLabel.text = qsTr("'%1' already exists").arg(topLevelName);
                    root.windowState.createCompleted(topLevelName);
                } else {
                    popupScope._runCreate();
                }
            }
        }

        // Intermediate directory creation process (nested file paths only)
        ShellRunner {
            id: mkdirProcess

            property string pendingTouchPath: ""

            onExited: (exitCode, exitStatus) => {
                if (exitCode === 0) {
                    createProcess.command = ["touch", "--", pendingTouchPath];
                    createProcess.start();
                } else {
                    errorLabel.text = qsTr("Creation failed (exit code %1)").arg(exitCode);
                }
            }
        }

        // File/directory creation process
        ShellRunner {
            id: createProcess
            onExited: (exitCode, exitStatus) => {
                if (exitCode === 0) {
                    root.windowState.closeModal();
                } else {
                    errorLabel.text = qsTr("Creation failed (exit code %1)").arg(exitCode);
                }
            }
        }
    }

    Behavior on opacity {
        Anim {}
    }
}
