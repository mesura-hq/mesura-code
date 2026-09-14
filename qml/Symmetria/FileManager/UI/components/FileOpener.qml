pragma ComponentBehavior: Bound

import Symmetria.FileManager.UI
import Symmetria.FileManager.Models
import QtQuick

Item {
    id: root

    visible: false
    width: 0
    height: 0

    // Single-slot pending path — open() is called at most once per user keypress
    // (keyboard-first UI prevents rapid concurrent calls), so no queue is needed.
    property string _pendingPath: ""

    function open(path: string, mimeType: string): void {
        const resolved = _previewHelper.resolvePathForOpen(path);
        root._pendingPath = resolved;
        // _handlerCheck output contract (three cases):
        //   1. Terminal=true handler found  → prints the Exec line (non-empty stdout)
        //   2. Terminal=false handler found → prints nothing, exits 0
        //   3. No handler found             → prints nothing, exits 0
        // onExited routes to _terminalOpen (case 1) or _xdgOpen (cases 2 & 3).
        _handlerCheck.command = ["sh", "-c",
            'handler=$(xdg-mime query default "$1"); ' +
            '[ -z "$handler" ] && case "$1" in text/*) handler=$(xdg-mime query default text/plain);; esac; ' +
            '[ -z "$handler" ] && exit 0; ' +
            'for dir in "$HOME/.local/share/applications" /usr/share/applications /usr/local/share/applications; do ' +
            'f="$dir/$handler"; if [ -f "$f" ]; then ' +
            'if grep -q "^Terminal=true" "$f"; then ' +
            'grep "^Exec=" "$f" | head -1 | sed "s/^Exec=//; s/%[fFuUnNdDick]//g; s/  */ /g; s/^ //; s/ $//"; fi; ' +
            'exit 0; fi; done; exit 0',
            "sh", mimeType
        ];
        _handlerCheck.start();
    }

    function execute(path: string): void {
        _terminalExec.command = ["xdg-terminal-exec", path];
        _terminalExec.start();
    }

    PreviewImageHelper {
        id: _previewHelper
    }

    // Step 1: check if the default handler needs a terminal
    ShellRunner {
        id: _handlerCheck

        onExited: (exitCode, exitStatus) => {
            if (exitCode !== 0) {
                Logger.warn("FileOpener", "handler check failed with code " + exitCode);
                return;
            }
            const execLine = stdoutText.trim();
            if (execLine) {
                // Terminal=true handler — launch via xdg-terminal-exec.
                // Wrap the Exec line in `sh -c` and pass the path as $1, so the
                // shell handles any quoting in the Exec line correctly (e.g.,
                // arguments with embedded spaces like --profile="My Profile").
                _terminalOpen.command = ["xdg-terminal-exec", "sh", "-c", execLine + ' "$@"', "sh", root._pendingPath];
                _terminalOpen.start();
            } else {
                // GUI handler — use xdg-open
                _xdgOpen.command = ["xdg-open", root._pendingPath];
                _xdgOpen.start();
            }
        }
    }

    // Step 2a: launch GUI app via xdg-open
    ShellRunner {
        id: _xdgOpen

        onExited: (exitCode, exitStatus) => {
            if (exitCode !== 0 || exitStatus !== ShellRunner.NormalExit)
                Logger.warn("FileOpener", "xdg-open exited with code " + exitCode + " for: " + command[1]);
        }
    }

    // Step 2b: launch terminal app via xdg-terminal-exec
    ShellRunner {
        id: _terminalOpen

        onExited: (exitCode, exitStatus) => {
            if (exitCode !== 0 || exitStatus !== ShellRunner.NormalExit)
                Logger.warn("FileOpener", "terminal open exited with code " + exitCode + " for: " + command.slice(1).join(" "));
        }
    }

    // Direct script execution (e.g. .sh files)
    ShellRunner {
        id: _terminalExec

        onExited: (exitCode, exitStatus) => {
            if (exitCode !== 0 || exitStatus !== ShellRunner.NormalExit)
                Logger.warn("FileOpener", "xdg-terminal-exec exited with code " + exitCode + " for: " + command[1]);
        }
    }
}
