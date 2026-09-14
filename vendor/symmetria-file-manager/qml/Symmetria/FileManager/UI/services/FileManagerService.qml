pragma Singleton

import QtQuick

QtObject {
    id: root

    // === Clipboard (yank/cut) — shared across all windows ===
    property var clipboardPaths: []      // Array of absolute paths, [] when empty
    property string clipboardMode: ""    // "" | "yank" | "cut"

    // Materialized Set for O(1) delegate lookups — rebuilt whenever clipboardPaths changes.
    // Without this, each FileListItem delegate would call indexOf (O(n) per item per render).
    property var _clipboardSet: ({})

    onClipboardPathsChanged: {
        const s = {};
        clipboardPaths.forEach(p => s[p] = true);
        _clipboardSet = s;
    }

    function yank(paths: var): void {
        clipboardPaths = paths;
        clipboardMode = "yank";
    }

    function cut(paths: var): void {
        clipboardPaths = paths;
        clipboardMode = "cut";
    }

    function clearClipboard(): void {
        clipboardPaths = [];
        clipboardMode = "";
    }

    // GOTCHA: Wayland clipboards are served live by the copying client — the
    // compositor holds no copy; whoever ran wl-copy must stay alive to answer
    // paste requests. A plain wl-copy spawned from this daemon lands in the
    // symmetria-fm.service cgroup, and the daemon deliberately exits when the
    // last window closes (main.cpp), so systemd's KillMode=control-group
    // killed the clipboard holder — "cc copied but paste is empty" whenever a
    // copy was followed by closing the FM window (root cause of the 2026-06
    // clipboard bug). systemd-run detaches the holder into its own transient
    // user unit; --foreground stops wl-copy from forking (a forked child
    // would end the transient unit and get cgroup-killed all the same), and
    // --collect garbage-collects the unit once a later copy replaces the
    // selection and wl-copy exits.
    //   --user      run in the user bus (not system)
    //   --collect   auto-remove the transient unit after wl-copy exits
    //   --quiet     suppress the generated unit name from stderr
    //   --foreground  (wl-copy flag) keep wl-copy in the foreground so it
    //                 stays in the transient unit's cgroup; a forked child
    //                 would escape the unit and be killed the same old way
    //
    // Both copy commands below share this launcher prefix.
    readonly property var _clipboardLauncherPrefix: ["systemd-run", "--user", "--collect", "--quiet", "--"]

    function clipboardCopyCommand(text: string): var {
        return root._clipboardLauncherPrefix.concat(["wl-copy", "--foreground", "--", text]);
    }

    // Copy a file's raw BYTES onto the clipboard under the given MIME type
    // (e.g. image/png), so the picture itself can be pasted into an editor or
    // chat — not its path. wl-copy reads the bytes from stdin; ShellRunner is
    // argv-only (no shell `<` redirection), so route through `sh -c` with the
    // mime type and path passed as POSITIONAL args ($1/$2) instead of
    // interpolated into the script text — that keeps filenames containing
    // spaces, quotes or `$` injection-safe. `exec` replaces sh with wl-copy so
    // the transient unit's cgroup tracks wl-copy directly (same --foreground
    // rationale as above — no surviving sh parent to escape the unit).
    function clipboardCopyFileCommand(mimeType: string, filePath: string): var {
        return root._clipboardLauncherPrefix.concat([
            "sh", "-c", 'exec wl-copy --foreground --type "$1" < "$2"',
            "sh", mimeType, filePath
        ]);
    }

    // === Picker mode (portal file chooser) — one picker at a time globally ===
    property bool pickerMode: false
    property string pickerFifoPath: ""
    property string pickerTitle: ""
    property string pickerAcceptLabel: ""
    property bool pickerMultiple: false
    property bool pickerDirectory: false
    property bool pickerSaveMode: false
    property string pickerSuggestedName: ""
    property bool saveNameEditing: false
    // Opt-in escape hatch for embedding hosts (e.g. the Symmetria IDE) that
    // want a FULL file manager riding the picker's open/cancel routing rather
    // than a bare file chooser. When true, KeyRegistry's dispatch picker
    // pre-pass skips picker mode's default clipboard/multi-select/tab
    // suppression, so yank/cut/
    // paste/space-marking/tabs all work while Enter→pickerCompleted and
    // Esc→cancel stay intact. Defaults false → the XDG portal picker and any
    // other startPickerMode caller keep the suppress-clipboard-ops behavior.
    property bool pickerFileOps: false

    signal pickerCompleted(fifoPath: string, paths: var)
    signal pickerCancelled(fifoPath: string)

    function startPickerMode(options: var): void {
        pickerMode = true;
        pickerFifoPath = options.fifo || "";
        pickerTitle = options.title || "Select a File";
        pickerAcceptLabel = options.acceptLabel || "";
        pickerMultiple = options.multiple || false;
        // Protocol note: returning a single URI when multiple=true is conformant —
        // the FileChooser spec does not require returning the maximum requested count.
        pickerDirectory = options.directory || false;
        pickerSaveMode = options.saveMode || false;
        pickerSuggestedName = options.suggestedName || "";
        pickerFileOps = options.fileOps || false;
        // Navigation to currentFolder is handled by WindowFactory when creating
        // the picker window — it passes the path as initialPath to the window.
    }

    function completePickerMode(paths: var): void {
        // Capture fifo path before _resetPickerState() clears it.
        // Signal emission must happen after reset so pickerMode=false
        // is already observable by the time listeners react.
        const fifo = pickerFifoPath;
        _resetPickerState();
        pickerCompleted(fifo, paths);
    }

    function cancelPickerMode(): void {
        // Same capture-before-reset invariant as completePickerMode.
        const fifo = pickerFifoPath;
        _resetPickerState();
        pickerCancelled(fifo);
    }

    // Single source of truth for picker completion — called by both Enter key
    // (FileList) and Accept button (StatusBar) to ensure identical behavior.
    function confirmPickerSelection(currentEntry: var, windowState: var): void {
        // Multi-select: if items are marked, confirm all marked items.
        // pickerSaveMode and pickerMultiple are orthogonal — save mode ignores marks.
        if (pickerMultiple && windowState.selectedCount > 0) {
            const paths = windowState.getSelectedPathsArray();
            // Clear before completing so the selection count binding resets
            // before pickerMode becomes false — prevents a stale count flash.
            windowState.clearSelection();
            completePickerMode(paths);
            return;
        }
        if (pickerSaveMode) {
            // Save mode: return full save path (dir + filename) when a name is
            // available, otherwise just the directory for portal-side appending.
            let savePath = windowState.currentPath;
            if (pickerSuggestedName) {
                const sep = savePath.endsWith("/") ? "" : "/";
                savePath = savePath + sep + pickerSuggestedName;
            }
            completePickerMode([savePath]);
            return;
        }
        if (!currentEntry) return;
        if (pickerDirectory) {
            // Directory picker: only dirs are selectable.
            if (currentEntry.isDir)
                completePickerMode([currentEntry.path]);
        } else {
            // File picker: only files are selectable.
            if (!currentEntry.isDir)
                completePickerMode([currentEntry.path]);
        }
    }

    function _resetPickerState(): void {
        pickerMode = false;
        pickerFifoPath = "";
        pickerTitle = "";
        pickerAcceptLabel = "";
        pickerMultiple = false;
        pickerDirectory = false;
        pickerSaveMode = false;
        pickerSuggestedName = "";
        saveNameEditing = false;
        pickerFileOps = false;
    }

    // === Utilities (stateless, shared) ===

    readonly property var _archiveMimeTypes: ({
        "application/zip": true,
        "application/x-tar": true,
        "application/x-7z-compressed": true,
        "application/x-rar": true,
        "application/x-rar-compressed": true,
        "application/vnd.rar": true,
        "application/x-cpio": true,
        "application/vnd.ms-cab-compressed": true,
        "application/x-xar": true,
        "application/x-compressed-tar": true,
        "application/x-bzip-compressed-tar": true,
        "application/x-xz-compressed-tar": true,
        "application/x-zstd-compressed-tar": true,
        "application/x-lzma-compressed-tar": true,
        "application/gzip": true,
        "application/x-gzip": true,
        "application/x-bzip2": true,
        "application/x-xz": true,
        "application/zstd": true,
        "application/x-zstd": true,
        "application/x-iso9660-image": true,
        "application/x-debian-package": true,
        "application/java-archive": true,
        "application/epub+zip": true,
    })

    function isArchiveFile(mimeType: string): bool {
        return !!_archiveMimeTypes[mimeType];
    }

    // NOTE: text-file classification is NOT done here. It lives in C++ as
    // FileSystemEntry.isText (MIME inheritance from text/plain + a content sniff),
    // the single source of truth — a QML mime-string list here would drift from it
    // (it did: it predated the application/x-yaml → application/yaml rename, so YAML
    // stopped previewing). Use `entry.isText` in the preview router instead.

    function isAudioFile(mimeType: string): bool {
        return mimeType.startsWith("audio/") || mimeType === "application/ogg";
    }

    // HTML documents that the render preview (Ctrl+R) can display in WebEngine.
    // Kept narrow: only genuine web documents, not every text/* type. text/html
    // still classifies as isText (inherits text/plain) so it previews as source
    // by default; this gate only decides whether the render TOGGLE is offered.
    function isHtmlFile(mimeType: string): bool {
        return mimeType === "text/html" || mimeType === "application/xhtml+xml";
    }

    function isSpreadsheetFile(mimeType: string): bool {
        return [
            "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
            "application/vnd.ms-excel.sheet.macroEnabled.12",
            "application/vnd.ms-excel.template.macroEnabled.12",
            "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
        ].includes(mimeType);
    }

    function iconNameForMime(mimeType: string): string {
        if (mimeType.startsWith("text/")) return "article";
        if (mimeType.startsWith("video/")) return "movie";
        if (isAudioFile(mimeType)) return "music_note";
        if (mimeType.startsWith("application/pdf")) return "picture_as_pdf";
        return "description";
    }

    function formatSize(bytes: double): string {
        if (bytes < 1024)
            return bytes + " B";
        if (bytes < 1024 * 1024)
            return (bytes / 1024).toFixed(1) + " K";
        if (bytes < 1024 * 1024 * 1024)
            return (bytes / (1024 * 1024)).toFixed(1) + " M";
        return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " G";
    }

    function formatDate(date: date): string {
        if (!date || isNaN(date.getTime()))
            return "";

        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffSec = Math.floor(diffMs / 1000);
        const diffMin = Math.floor(diffSec / 60);
        const diffHour = Math.floor(diffMin / 60);
        const diffDay = Math.floor(diffHour / 24);

        if (diffSec < 60)
            return "just now";
        if (diffMin < 60)
            return diffMin + "m ago";
        if (diffHour < 24)
            return diffHour + "h ago";
        if (diffDay < 7)
            return diffDay + "d ago";

        return Qt.formatDateTime(date, "MMM d");
    }
}
