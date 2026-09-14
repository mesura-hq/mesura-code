pragma Singleton

import Symmetria.FileManager.Models
import QtQuick

QtObject {
    id: root

    // Log file location — rotated on each service restart
    readonly property string logFile: Paths.home + "/.local/share/symmetria/logs/filemanager.log"

    // Buffered log entries awaiting flush
    property var _buffer: []
    property bool _flushScheduled: false

    // Log levels — QML property names must be lowercase
    readonly property int levelDebug: 0
    readonly property int levelInfo:  1
    readonly property int levelWarn:  2
    readonly property int levelError: 3

    readonly property var _levelNames: ["DEBUG", "INFO", "WARN", "ERROR"]

    // Minimum level to record (levelDebug logs everything)
    property int minLevel: levelDebug

    // --- Public API ---

    function debug(component: string, message: string): void {
        root._log(root.levelDebug, component, message);
    }

    function info(component: string, message: string): void {
        root._log(root.levelInfo, component, message);
    }

    function warn(component: string, message: string): void {
        root._log(root.levelWarn, component, message);
    }

    function error(component: string, message: string): void {
        root._log(root.levelError, component, message);
    }

    // Immediate flush — call before shutdown or on critical errors
    function flush(): void {
        root._flushNow();
    }

    // --- Internal ---

    function _log(level: int, component: string, message: string): void {
        if (level < root.minLevel)
            return;

        const timestamp = new Date().toISOString();
        const levelName = root._levelNames[level] ?? "?";
        const line = "[" + timestamp + "] [" + levelName + "] [" + component + "] " + message;

        // Always mirror to console for journalctl
        if (level >= root.levelWarn)
            console.warn(line);
        else
            console.log(line);

        root._buffer.push(line);
        root._scheduleFlush();
    }

    function _scheduleFlush(): void {
        if (!root._flushScheduled) {
            root._flushScheduled = true;
            flushTimer.restart();
        }
    }

    function _flushNow(): void {
        flushTimer.stop();
        root._flushScheduled = false;

        if (root._buffer.length === 0)
            return;

        // Grab buffer and reset immediately (in case new logs arrive during write)
        const lines = root._buffer;
        root._buffer = [];

        if (writeProcess.running) {
            // A write is in progress — push lines back to front of buffer so
            // they are not lost. onExited will re-trigger a flush.
            root._buffer = lines.concat(root._buffer);
            root._scheduleFlush();
            return;
        }

        writeProcess.payload = lines.join("\n") + "\n";
        writeProcess.start();
    }

    // QtObject has no default property — children declared as named properties.
    property Timer _flushTimer: Timer {
        id: flushTimer
        interval: 500
        repeat: false
        onTriggered: root._flushNow()
    }

    // Ensure log directory exists + write buffered content
    property ShellRunner _writeProcess: ShellRunner {
        id: writeProcess
        property string payload: ""

        command: [
            "sh", "-c",
            "mkdir -p \"$(dirname \"$1\")\" && printf '%s' \"$2\" >> \"$1\"",
            "--",   // end of sh options
            root.logFile,
            payload
        ]

        onExited: (exitCode, exitStatus) => {
            if (exitCode !== 0)
                console.error("[Logger] Write failed, exitCode:", exitCode);
            // Drain any content that arrived while this write was in progress
            if (root._buffer.length > 0)
                root._scheduleFlush();
        }
    }

    // Write startup marker on initialization
    Component.onCompleted: {
        const sep = "═".repeat(60);
        root._buffer.push(sep);
        root._buffer.push("[" + new Date().toISOString() + "] [INFO] [Logger] Session started");
        root._buffer.push(sep);
        root._scheduleFlush();
    }
}
