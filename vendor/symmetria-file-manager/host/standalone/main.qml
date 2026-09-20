pragma ComponentBehavior: Bound

// Headless root: instantiates no windows at startup. Windows are spawned
// dynamically when hostController emits openRequested / openOverlayRequested
// / createPickerRequested.
//
// QtObject has no default property, so all children (Components, Connections,
// ShellRunner, Timer) are declared as named properties. The `id: foo` form
// remains accessible from the rest of this scope.

import Symmetria.FileManager.UI
import Symmetria.FileManager.Models
import QtQuick

QtObject {
    id: root

    property var _pickerWindow: null

    // Sentinel written to a picker's FIFO to signal cancellation — single
    // source of truth shared by the cancel and busy-reject writers below
    // (mirrors the portal backend's CANCELLED_SENTINEL).
    readonly property string _cancelledSentinel: "__PICKER_CANCELLED__"

    // Busy-reject FIFOs awaiting the cancel-sentinel writer. Rejects drain one
    // at a time through the single fifoRejectProcess: enqueueing here and
    // calling _drainRejects() avoids clobbering an in-flight writer's fifoPath
    // when several dialogs arrive while a picker is already open (which would
    // strand a request on the portal's 300s timeout — the very hang this fixes).
    property var _pendingRejectFifos: []

    // True from the moment a reject writer is asked to start until it settles
    // (normal exit, failed start, or timeout-kill). _drainRejects gates on
    // THIS, not fifoRejectProcess.running, because ShellRunner.start() is a
    // no-op during its m_starting window — the interval between start() and
    // the started() signal where running is still false (shellrunner.cpp).
    // A running-only gate let a reject arriving in that window overwrite the
    // in-flight writer's fifoPath and silently no-op its own start(),
    // stranding a request on the portal's 300s timeout — the very hang the
    // queue exists to prevent, just relocated into the launch window.
    property bool _rejectBusy: false

    property Component _fileManagerWindowComponent: Component {
        id: fileManagerWindowComponent

        Window {
            id: win

            required property string initialPath

            width: 1100
            height: 720
            visible: true
            color: FmTheme.windowBackdrop
            title: qsTr("File Manager")

            onClosing: () => destroy()

            FileManager {
                anchors.fill: parent
                initialPath: win.initialPath
                onCloseRequested: win.close()
            }
        }
    }

    property Component _pickerWindowComponent: Component {
        id: pickerWindowComponent

        Window {
            id: win

            required property string initialPath

            width: 900
            height: 600
            visible: true
            modality: Qt.ApplicationModal
            // Stay-on-top + Dialog flags help the picker grab focus on Hyprland
            // even though we no longer use Wayland layer-shell exclusive focus.
            // If keyboard focus still lands on the wrong surface, Hyprland's
            // `windowrulev2 = float, class:^(symmetria-fm)$` is the documented
            // fallback (see plan stage D risk hotspot a).
            flags: Qt.Dialog | Qt.WindowStaysOnTopHint
            color: FmTheme.windowBackdrop
            title: qsTr("Pick a File")

            Component.onCompleted: requestActivate()

            onClosing: () => {
                root._pickerWindow = null;
                if (FileManagerService.pickerMode)
                    FileManagerService.cancelPickerMode();
                destroy();
            }

            FileManager {
                anchors.fill: parent
                initialPath: win.initialPath
                onCloseRequested: win.close()
            }
        }
    }

    function _spawnFileManager(initialPath: string): void {
        const path = initialPath || Paths.home;
        // createObject(root, …) gives the window a QObject parent, so its
        // lifetime is owned by the host — no JS-side tracking array needed.
        // The window self-destroys on `onClosing`.
        const win = fileManagerWindowComponent.createObject(root, {
            initialPath: path
        });
        if (!win)
            Logger.error("HostController", "failed to create FileManager window for path: " + path);
    }

    function _spawnPicker(options: var): void {
        if (root._pickerWindow) {
            // Reject immediately instead of silently dropping: without a FIFO
            // response the requesting app's dialog call hangs until the portal's
            // 300s timeout (Electron apps may crash outright), and the user gets
            // no feedback. Cancelling the new request and raising the existing
            // picker makes the conflict visible and recoverable.
            Logger.warn("HostController", "picker already active — cancelling new request, raising existing picker");
            if (options.fifo) {
                // options.fifo was already validated server-side by server.cpp's
                // validateFifoPath before createPickerRequested fired (same
                // guarantee the result-writer note below relies on), so it is
                // safe to hand straight to the writer.
                root._pendingRejectFifos.push(options.fifo);
                root._drainRejects();
            }
            root._pickerWindow.requestActivate();
            return;
        }
        // Diagnostic: confirm the portal-supplied parent_window handle reaches the
        // picker spawn site. Used to validate the xdg-foreign-v2 import plan
        // (stage 1 of the focus-return fix). Empty string is normal for
        // requesters that don't export a toplevel (some XWayland apps).
        Logger.info("HostController",
                    "picker parentWindow=" + (options.parentWindow || "<empty>"));
        FileManagerService.startPickerMode(options);
        root._pickerWindow = pickerWindowComponent.createObject(root, {
            initialPath: options.currentFolder || Paths.home
        });
        if (!root._pickerWindow) {
            Logger.error("HostController", "failed to create picker window — cancelling picker mode");
            FileManagerService.cancelPickerMode();
        }
    }

    property Connections _hostConn: Connections {
        // hostController is a C++ context property (main.cpp setContextProperty),
        // invisible to qmllint's static analysis.
        target: hostController // qmllint disable unqualified
        function onOpenRequested(initialPath: string): void {
            root._spawnFileManager(initialPath);
        }
        function onOpenOverlayRequested(initialPath: string): void {
            // No layer-shell overlay in the standalone host — fall back to a
            // normal floating window. The shell-overlay use case existed to
            // make the FM appear on top of every workspace under QuickShell;
            // in the standalone host the user's compositor handles that via
            // window rules.
            root._spawnFileManager(initialPath);
        }
        function onCreatePickerRequested(options: var): void {
            root._spawnPicker(options);
        }
        function onClosePickerRequested(fifoPath: string): void {
            // Portal relayed org.freedesktop.impl.portal.Request.Close — the
            // requesting app cancelled or died. Only honour it for the picker
            // that owns this fifo; closing routes through the window's
            // onClosing, which cancels picker mode and answers the FIFO.
            if (root._pickerWindow && FileManagerService.pickerFifoPath === fifoPath) {
                Logger.info("HostController", "closing picker on portal Request.Close");
                root._pickerWindow.close();
            }
        }
    }

    // FIFO writes for picker results — same structure as the QuickShell
    // WindowFactory.qml. The 4-layer FIFO validation ran server-side in
    // server.cpp before this signal fired, so by the time we reach here the
    // path is already trusted.
    property Connections _serviceConn: Connections {
        target: FileManagerService

        function onPickerCompleted(fifoPath: string, paths: var): void {
            if (!fifoPath) return;
            const rawPaths = paths.join("\n");
            fifoWriteProcess.fifoPath = fifoPath;
            fifoWriteProcess.payload = rawPaths;
            fifoWriteProcess.start();
        }

        function onPickerCancelled(fifoPath: string): void {
            if (!fifoPath) return;
            fifoCancelProcess.fifoPath = fifoPath;
            fifoCancelProcess.start();
        }
    }

    property ShellRunner _fifoWriteProcess: ShellRunner {
        id: fifoWriteProcess

        property string fifoPath: ""
        property string payload: ""

        command: ["python3", "-c",
                  "import sys; open(sys.argv[2], 'w').write(sys.argv[1])",
                  payload, fifoPath]

        onRunningChanged: {
            if (running) fifoWriteTimeout.start();
            else fifoWriteTimeout.stop();
        }

        onExited: (exitCode, exitStatus) => {
            fifoWriteTimeout.stop();
            if (exitCode !== 0)
                Logger.error("HostController", "FIFO write failed, exitCode: " + exitCode);
            else
                Logger.info("HostController", "Picker result sent to FIFO");
            root._closePickerWindow();
        }

        onErrorOccurred: (error) => {
            // FailedToStart emits errorOccurred with NO following exited
            // (shellrunner.cpp), so close the picker window here too —
            // otherwise a failed result writer leaves it open with the
            // requesting app hanging on the 300s timeout. _closePickerWindow
            // is idempotent, so a later exited (e.g. on Crashed) is harmless.
            fifoWriteTimeout.stop();
            Logger.error("HostController", "FIFO write writer error: " + error);
            root._closePickerWindow();
        }
    }

    property Timer _fifoWriteTimeout: Timer {
        id: fifoWriteTimeout
        interval: 5000
        onTriggered: {
            Logger.error("HostController", "FIFO write timeout — forcing close");
            fifoWriteProcess.kill();
            root._closePickerWindow();
        }
    }

    property ShellRunner _fifoCancelProcess: ShellRunner {
        id: fifoCancelProcess

        property string fifoPath: ""

        command: ["python3", "-c",
                  "import sys; open(sys.argv[2], 'w').write(sys.argv[1])",
                  root._cancelledSentinel, fifoPath]

        onRunningChanged: {
            if (running) fifoCancelTimeout.start();
            else fifoCancelTimeout.stop();
        }

        onExited: (exitCode, exitStatus) => {
            fifoCancelTimeout.stop();
            if (exitCode !== 0)
                Logger.error("HostController", "FIFO cancel write failed, exitCode: " + exitCode);
            else
                Logger.info("HostController", "Picker cancellation sent to FIFO");
            root._closePickerWindow();
        }

        onErrorOccurred: (error) => {
            // Same FailedToStart guard as the result writer: no exited
            // follows, so force the picker window closed here (idempotent).
            fifoCancelTimeout.stop();
            Logger.error("HostController", "FIFO cancel writer error: " + error);
            root._closePickerWindow();
        }
    }

    property Timer _fifoCancelTimeout: Timer {
        id: fifoCancelTimeout
        interval: 5000
        onTriggered: {
            Logger.error("HostController", "FIFO cancel timeout — forcing close");
            fifoCancelProcess.kill();
            root._closePickerWindow();
        }
    }

    // Cancels a busy-rejected request's FIFO. Deliberately separate from
    // fifoCancelProcess: that runner closes the ACTIVE picker window on exit,
    // which is exactly what a busy rejection must NOT do (the existing picker
    // stays open; only the new request is answered with a cancellation).
    property ShellRunner _fifoRejectProcess: ShellRunner {
        id: fifoRejectProcess

        property string fifoPath: ""

        command: ["python3", "-c",
                  "import sys; open(sys.argv[2], 'w').write(sys.argv[1])",
                  root._cancelledSentinel, fifoPath]

        onRunningChanged: {
            if (running) fifoRejectTimeout.start();
            else fifoRejectTimeout.stop();
        }

        onExited: (exitCode, exitStatus) => {
            if (exitCode !== 0)
                Logger.error("HostController", "FIFO reject write failed, exitCode: " + exitCode);
            else
                Logger.info("HostController", "Busy rejection sent to FIFO");
            root._settleReject();
        }

        onErrorOccurred: (error) => {
            // FailedToStart (python3 missing, fork failure) emits errorOccurred
            // with NO following exited (shellrunner.cpp), so without advancing
            // here the whole reject queue would stall — every pending request
            // stranded on the 300s timeout. Settle so the next reject drains.
            // Best-effort: this request's sentinel didn't land, but it falls
            // back to its own reader timeout rather than wedging the queue.
            Logger.error("HostController", "FIFO reject writer error: " + error);
            root._settleReject();
        }
    }

    property Timer _fifoRejectTimeout: Timer {
        id: fifoRejectTimeout
        interval: 5000
        onTriggered: {
            Logger.error("HostController", "FIFO reject write timeout — killing writer");
            // kill() makes the still-running writer emit exited, which settles
            // and drains the next reject. We deliberately do NOT settle/drain
            // here: this timer only runs while the writer is running (gated in
            // onRunningChanged), so the kill's exited always follows. Draining
            // here too could advance the queue before that exited arrives and
            // let the stale exit settle the NEXT writer.
            fifoRejectProcess.kill();
        }
    }

    function _closePickerWindow(): void {
        if (root._pickerWindow)
            root._pickerWindow.close();
    }

    // Starts the next queued busy-reject write if no writer is in flight.
    // Invoked when a reject is enqueued and again as each writer settles, so a
    // burst of rejected requests drains sequentially without two of them
    // racing on fifoRejectProcess.fifoPath.
    function _drainRejects(): void {
        if (root._rejectBusy || root._pendingRejectFifos.length === 0)
            return;
        root._rejectBusy = true;
        fifoRejectProcess.fifoPath = root._pendingRejectFifos.shift();
        fifoRejectProcess.start();
    }

    // Settles the current reject writer and advances the queue, exactly once
    // per writer whichever terminal signal arrives first: normal exit, a
    // failed start (errorOccurred with NO following exited — shellrunner.cpp),
    // or the timeout-kill's exit. The _rejectBusy gate makes it idempotent so
    // a single writer can't double-drain.
    function _settleReject(): void {
        if (!root._rejectBusy)
            return;
        root._rejectBusy = false;
        fifoRejectTimeout.stop();
        root._drainRejects();
    }

    Component.onCompleted: {
        Logger.info("symmetria-fm", "host ready, awaiting IPC");
    }
}
