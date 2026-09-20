// Paste process runner shared by the Miller-columns and tree views. Driven by
// KeyRegistry's paste binding (_pasteAction), which sets `command` (cp -r for
// yank, mv for cut) and calls start(). On success the global clipboard is
// cleared; on failure the `pasteFailed` signal lets the owning view undo any
// optimistic state (e.g. FileList's pending focus name).

import Symmetria.FileManager.UI
import Symmetria.FileManager.Models

ShellRunner {
    id: root

    signal pasteFailed()

    onExited: (exitCode, exitStatus) => {
        if (exitCode === 0 && exitStatus === ShellRunner.NormalExit) {
            FileManagerService.clearClipboard();
        } else {
            Logger.warn("PasteRunner", "paste failed — exitCode: " + exitCode + " exitStatus: " + exitStatus);
            root.pasteFailed();
        }
    }
}
