pragma ComponentBehavior: Bound

import Symmetria.FileManager.UI
import Symmetria.FileManager.Models
import QtQuick
import QtQuick.Layouts

Loader {
    id: root

    property WindowState windowState

    anchors.fill: parent

    opacity: windowState && windowState.activeModal === windowState.modalContextMenu ? 1 : 0
    active: windowState && !FileManagerService.pickerMode
        && windowState.activeModal === windowState.modalContextMenu
    sourceComponent: FocusScope {
        id: popupScope

        // --- Snapshotted data ---
        property string targetPath: ""
        property string targetName: ""
        property string targetMimeType: ""
        property bool isArchive: false
        property bool isAudio: false

        // --- Internal state machine: "actions" | "openWith" | "extracting" ---
        property string viewMode: "actions"

        // --- Action list ---
        // Force unconditional reads so the QML binding engine registers
        // both properties as dependencies even when their initial value is false.
        readonly property var actionItems: {
            const _audio = isAudio;
            const _archive = isArchive;
            let items = [
                { actionId: "openWith", icon: "open_in_new", label: "Open with\u2026", key: "o" }
            ];
            if (_audio)
                items.push({ actionId: "playToggle", icon: "play_arrow", label: "Play / Pause", key: "p" });
            if (_archive)
                items.push({ actionId: "extract", icon: "unarchive", label: "Extract here", key: "e" });
            return items;
        }
        property int actionIndex: 0

        // --- Open With data ---
        property var appList: []
        property string appFilterQuery: ""
        property var filteredApps: []
        property int appIndex: 0

        // --- Extraction progress ---
        property int extractedCount: 0
        property int extractTotalCount: 0
        property bool extractionDone: false
        property string extractionError: ""

        Component.onCompleted: {
            targetPath = root.windowState.contextMenuTargetPath;
            targetMimeType = root.windowState.contextMenuTargetMimeType;
            targetName = Paths.basename(targetPath);
            isArchive = FileManagerService.isArchiveFile(targetMimeType);
            isAudio = FileManagerService.isAudioFile(targetMimeType);
        }

        function _executeAction(actionId: string): void {
            if (actionId === "openWith") {
                viewMode = "openWith";
                if (targetMimeType !== "") {
                    mimeQueryProcess.command = ["gio", "mime", targetMimeType];
                    mimeQueryProcess.start();
                } else {
                    appList = [];
                    _updateFilteredApps();
                }
            } else if (actionId === "playToggle") {
                root.windowState.audioPlaybackToggle();
                root.windowState.closeModal();
            } else if (actionId === "extract") {
                viewMode = "extracting";
                extractionError = "";
                archiveCounter.filePath = targetPath;
            }
        }

        // --- Open With: application discovery ---
        function _parseMimeOutput(output: string): void {
            const lines = output.split("\n");
            const seen = {};
            const apps = [];
            for (const line of lines) {
                const trimmed = line.trim();
                // Reject header lines like "Registered associations:" which contain spaces
                if (trimmed.endsWith(".desktop") && !trimmed.includes(" ") && !seen[trimmed]) {
                    seen[trimmed] = true;
                    // Resolve the real themed app icon once, here, rather than in the
                    // delegate binding (the list is small and AppIconProvider caches).
                    apps.push({
                        desktopId: trimmed,
                        name: _desktopIdToName(trimmed),
                        iconPath: AppIconProvider.iconForDesktopId(trimmed)
                    });
                }
            }
            appList = apps;
            _updateFilteredApps();
        }

        function _desktopIdToName(desktopId: string): string {
            let name = desktopId.replace(/\.desktop$/, "");
            const parts = name.split(".");
            name = parts[parts.length - 1];
            // Capitalize and replace hyphens/underscores with spaces
            name = name.replace(/[-_]/g, " ");
            return name.charAt(0).toUpperCase() + name.substring(1);
        }

        function _updateFilteredApps(): void {
            if (appFilterQuery === "") {
                filteredApps = appList.slice();
                return;
            }
            const q = appFilterQuery.toLowerCase();
            filteredApps = appList.filter(app =>
                app.name.toLowerCase().includes(q)
                || app.desktopId.toLowerCase().includes(q)
            );
            // Clamp index
            if (appIndex >= filteredApps.length)
                appIndex = Math.max(0, filteredApps.length - 1);
        }

        // --- Extraction ---
        function _startExtraction(): void {
            const dotIndex = targetName.lastIndexOf(".");
            // Handle double extensions like .tar.gz, .tar.bz2, etc.
            const tarMatch = /\.tar\.[^.]+$/.exec(targetName);
            const stripIndex = tarMatch ? tarMatch.index : (dotIndex > 0 ? dotIndex : -1);
            const baseName = stripIndex >= 0 ? targetName.substring(0, stripIndex) : "";
            const folderName = baseName !== "" ? baseName : targetName;
            const parentDir = Paths.parentDir(targetPath);
            const destDir = parentDir + "/" + folderName;

            mkdirProcess.destDir = destDir;
            mkdirProcess.command = ["mkdir", "-p", "--", destDir];
            mkdirProcess.start();
        }

        function _handleActionsKeys(event): void {
            switch (event.key) {
            case Qt.Key_Escape:
                root.windowState.closeModal();
                event.accepted = true;
                break;
            case Qt.Key_J:
            case Qt.Key_Down:
                if (actionIndex < actionItems.length - 1)
                    actionIndex++;
                event.accepted = true;
                break;
            case Qt.Key_K:
            case Qt.Key_Up:
                if (actionIndex > 0)
                    actionIndex--;
                event.accepted = true;
                break;
            case Qt.Key_Return:
            case Qt.Key_Enter:
                _executeAction(actionItems[actionIndex].actionId);
                event.accepted = true;
                break;
            case Qt.Key_O:
                _executeAction("openWith");
                event.accepted = true;
                break;
            case Qt.Key_P:
                if (isAudio)
                    _executeAction("playToggle");
                event.accepted = true;
                break;
            case Qt.Key_E:
                if (isArchive)
                    _executeAction("extract");
                event.accepted = true;
                break;
            default:
                // Only consume bare letter keys to prevent them reaching the file list;
                // let modifier+key combinations (e.g. Ctrl+W) bubble through.
                if (!event.modifiers || event.modifiers === Qt.ShiftModifier)
                    event.accepted = true;
                break;
            }
        }

        function _handleOpenWithKeys(event): void {
            switch (event.key) {
            case Qt.Key_Escape:
                // Go back to actions list
                viewMode = "actions";
                appFilterQuery = "";
                appIndex = 0;
                dialog.forceActiveFocus();
                event.accepted = true;
                break;
            case Qt.Key_Down:
                if (appIndex < filteredApps.length - 1)
                    appIndex++;
                event.accepted = true;
                break;
            case Qt.Key_Up:
                if (appIndex > 0)
                    appIndex--;
                event.accepted = true;
                break;
            case Qt.Key_Return:
            case Qt.Key_Enter:
                if (filteredApps.length > 0) {
                    const app = filteredApps[appIndex];
                    openWithProcess.command = ["gio", "launch", app.desktopId, targetPath];
                    openWithProcess.start();
                    root.windowState.closeModal();
                }
                event.accepted = true;
                break;
            default:
                // J/K intentionally absent — alphabetic keys feed the search filter.
                // Only arrow keys navigate the list; all other keys pass to TextInput.
                break;
            }
        }

        function _handleExtractingKeys(event): void {
            if ((event.key === Qt.Key_Escape || event.key === Qt.Key_Return || event.key === Qt.Key_Enter)
                && (extractionDone || extractionError !== "")) {
                root.windowState.closeModal();
            }
            event.accepted = true;
        }

        // Scrim backdrop — click to cancel (only when not extracting)
        MouseArea {
            anchors.fill: parent
            hoverEnabled: true
            onClicked: {
                if (popupScope.viewMode !== "extracting" || popupScope.extractionDone || popupScope.extractionError !== "")
                    root.windowState.closeModal();
            }
        }

        StyledRect {
            anchors.fill: parent
            color: Qt.alpha(FmTheme.palette.shadow, 0.5)
        }

        // Dialog card — claymorphism (shared PillCard)
        PillCard {
            id: dialog

            anchors.centerIn: parent

            width: Math.min(parent.width - FmTheme.padding.lg * 4, 400)
            implicitHeight: dialogContent.implicitHeight + FmTheme.padding.lg * 3

            scale: 0.1
            Component.onCompleted: scale = 1

            Behavior on scale {
                NumberAnimation {
                    duration: FmTheme.animDuration
                    easing.type: Easing.OutBack
                    easing.overshoot: 1.5
                }
            }

            // Prevent clicks on card from reaching scrim
            MouseArea {
                anchors.fill: parent
            }

            Keys.onPressed: function(event) {
                if (popupScope.viewMode === "actions")
                    popupScope._handleActionsKeys(event);
                else if (popupScope.viewMode === "openWith")
                    popupScope._handleOpenWithKeys(event);
                else if (popupScope.viewMode === "extracting")
                    popupScope._handleExtractingKeys(event);
            }

            ColumnLayout {
                id: dialogContent

                anchors.fill: parent
                anchors.margins: FmTheme.padding.lg * 1.5
                spacing: FmTheme.spacing.md

                // Header: filename
                RowLayout {
                    spacing: FmTheme.spacing.sm

                    MaterialIcon {
                        text: "more_horiz"
                        color: FmTheme.palette.primary
                        font.pointSize: FmTheme.font.size.lg
                        font.weight: Font.Medium
                    }

                    StyledText {
                        text: popupScope.targetName
                        color: FmTheme.palette.onSurface
                        font.pointSize: FmTheme.font.size.md
                        font.weight: Font.DemiBold
                        elide: Text.ElideMiddle
                        Layout.fillWidth: true
                    }
                }

                // Separator
                Rectangle {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 1
                    color: FmTheme.overlay.subtle
                }

                // === View: Actions list ===
                Loader {
                    Layout.fillWidth: true
                    active: popupScope.viewMode === "actions"
                    visible: active
                    onLoaded: dialog.forceActiveFocus()

                    sourceComponent: ContextMenuActionsView {
                        actionItems: popupScope.actionItems
                        actionIndex: popupScope.actionIndex
                        onActionTriggered: actionId => popupScope._executeAction(actionId)
                    }
                }

                // === View: Open With ===
                Loader {
                    Layout.fillWidth: true
                    active: popupScope.viewMode === "openWith"
                    visible: active

                    sourceComponent: OpenWithView {
                        filteredApps: popupScope.filteredApps
                        appFilterQuery: popupScope.appFilterQuery
                        appIndex: popupScope.appIndex
                        loading: mimeQueryProcess.running
                        onFilterEdited: text => {
                            popupScope.appFilterQuery = text;
                            popupScope._updateFilteredApps();
                        }
                        onAppActivated: desktopId => {
                            openWithProcess.command = ["gio", "launch", desktopId, popupScope.targetPath];
                            openWithProcess.start();
                            root.windowState.closeModal();
                        }
                    }
                }

                // === View: Extraction progress ===
                Loader {
                    Layout.fillWidth: true
                    active: popupScope.viewMode === "extracting"
                    visible: active
                    onLoaded: dialog.forceActiveFocus()

                    sourceComponent: ArchiveExtractionView {
                        extractionDone: popupScope.extractionDone
                        extractionError: popupScope.extractionError
                        extractedCount: popupScope.extractedCount
                        extractTotalCount: popupScope.extractTotalCount
                    }
                }
            }
        }

        // === Processes ===

        // Query registered applications for the MIME type
        ShellRunner {
            id: mimeQueryProcess
            onExited: (exitCode, exitStatus) => {
                if (exitCode !== 0) {
                    Logger.warn("ContextMenuPopup", "gio mime failed, exit code " + exitCode);
                    return;
                }
                popupScope._parseMimeOutput(stdoutText);
            }
        }

        // Launch selected application
        ShellRunner {
            id: openWithProcess
            onExited: (exitCode, exitStatus) => {
                if (exitCode !== 0)
                    Logger.warn("ContextMenuPopup", "gio launch failed, exit code " + exitCode);
            }
        }

        // Count archive entries for progress denominator
        ArchivePreviewModel {
            id: archiveCounter
            onDataReady: {
                popupScope.extractTotalCount = archiveCounter.totalEntries;
                popupScope._startExtraction();
            }
            onErrorChanged: {
                if (archiveCounter.error !== "") {
                    popupScope.extractionError = "Failed to read archive";
                }
            }
        }

        // Create destination subfolder
        ShellRunner {
            id: mkdirProcess
            property string destDir: ""
            onExited: (exitCode, exitStatus) => {
                if (exitCode === 0) {
                    extractProcess.command = ["bsdtar", "-xvf", popupScope.targetPath, "-C", destDir];
                    extractProcess.start();
                } else {
                    popupScope.extractionError = "Failed to create directory";
                }
            }
        }

        // Extraction process with line-by-line progress (one stderr line per entry).
        ShellRunner {
            id: extractProcess
            onStderrLine: popupScope.extractedCount++
            onExited: (exitCode, exitStatus) => {
                if (exitCode === 0) {
                    popupScope.extractionDone = true;
                } else {
                    popupScope.extractionError = "Extraction failed (exit code " + exitCode + ")";
                }
            }
        }
    }

    Behavior on opacity {
        Anim {}
    }
}
