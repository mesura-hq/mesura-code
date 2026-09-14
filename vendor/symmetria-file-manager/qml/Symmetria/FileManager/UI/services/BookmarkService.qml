pragma Singleton

import Symmetria.FileManager.Models
import QtQuick

QtObject {
    id: root

    // Live bookmark map: { "p": { path: "/home/.../projects", label: "projects" }, ... }
    property var bookmarks: ({})

    readonly property string _configPath: Paths.home + "/.config/symmetria-fm/bookmarks.json"
    property bool _loaded: false

    // Reserved keys that can never be assigned to bookmarks (g = Top, n = New, x = Delete)
    readonly property var _reservedKeys: ["g", "n", "x"]

    // Default bookmarks seeded on first run — deletable by the user
    readonly property var _defaultBookmarks: ({
        "h": { path: Paths.home, label: "Home" },
        "d": { path: Paths.home + "/Downloads", label: "Downloads" }
    })

    // ── Public API ──────────────────────────────────────────────

    function addBookmark(key: string, path: string): void {
        const label = Paths.basename(path) || path;
        const updated = Object.assign({}, bookmarks);
        updated[key] = { path: path, label: label };
        bookmarks = updated;
        _save();
    }

    function removeBookmark(key: string): void {
        const updated = Object.assign({}, bookmarks);
        delete updated[key];
        bookmarks = updated;
        _save();
    }

    function hasBookmark(key: string): bool {
        return bookmarks.hasOwnProperty(key);
    }

    function getBookmarkPath(key: string): string {
        return bookmarks.hasOwnProperty(key) ? bookmarks[key].path : "";
    }

    function isReservedKey(key: string): bool {
        return _reservedKeys.indexOf(key) >= 0;
    }

    // Well-known directory → icon mapping (matched by trailing path segment)
    readonly property var _knownDirectoryIcons: ({
        "": "home",                       // exact home directory
        "Downloads": "download",
        "Documents": "description",
        "Pictures": "image",
        "Pictures/Screenshots": "screenshot_monitor",
        "Videos": "video_library",
        "Music": "library_music",
        "Desktop": "desktop_windows",
        ".config": "settings"
    })

    function iconForPath(path: string): string {
        // Strip trailing slash and compute path relative to home
        const clean = path.endsWith("/") ? path.slice(0, -1) : path;
        const home = Paths.home;
        if (clean === home)
            return _knownDirectoryIcons[""];
        if (clean.startsWith(home + "/")) {
            const relative = clean.substring(home.length + 1);
            if (_knownDirectoryIcons.hasOwnProperty(relative))
                return _knownDirectoryIcons[relative];
        }
        return "bookmark";
    }

    // ── Persistence ─────────────────────────────────────────────

    function _save(): void {
        const json = JSON.stringify(bookmarks, null, 2);
        if (writeProcess.running) {
            writeProcess._pendingPayload = json;
            return;
        }
        writeProcess.payload = json;
        writeProcess.start();
    }

    function _applyBookmarks(json: string): void {
        try {
            const parsed = JSON.parse(json);
            bookmarks = parsed && typeof parsed === "object" ? parsed : {};
        } catch (e) {
            Logger.warn("BookmarkService", "Failed to parse bookmarks: " + e);
            bookmarks = {};
        }
        _loaded = true;
    }

    // FileWatcher reads the file directly into `text` on construction, so we
    // skip the cat-via-ShellRunner roundtrip the QuickShell port needed.
    // First-run seeding still goes through ShellRunner because we need
    // mkdir -p && write semantics.
    //
    // QtObject has no default property — children declared as named properties.
    property FileWatcher _readWatcher: FileWatcher {
        id: readWatcher
        path: root._configPath
        watchChanges: true
        onLoadedChanged: if (loaded) root._applyBookmarks(text)
        onFileChanged: root._applyBookmarks(text)
        onLoadFailed: {
            // File doesn't exist on first run — seed defaults and persist.
            if (!_loaded) {
                bookmarks = Object.assign({}, _defaultBookmarks);
                _loaded = true;
                _save();
            }
        }
    }

    // Write full JSON to disk (mkdir -p for first run)
    property ShellRunner _writeProcess: ShellRunner {
        id: writeProcess
        property string payload: ""
        property string _pendingPayload: ""

        command: [
            "sh", "-c",
            "mkdir -p \"$(dirname \"$1\")\" && printf '%s' \"$2\" > \"$1\"",
            "--",
            root._configPath,
            payload
        ]

        onExited: (exitCode, exitStatus) => {
            if (exitCode !== 0)
                Logger.error("BookmarkService", "Write failed, exitCode: " + exitCode);
            if (_pendingPayload !== "") {
                payload = _pendingPayload;
                _pendingPayload = "";
                start();
            }
        }
    }
}
