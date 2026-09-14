import QtQuick
import "ImageChord.js" as ImageChord

QtObject {
    id: root

    // Set by the owning FileManager — determines starting directory
    property string initialPath: Paths.home

    // === Navigation ===
    property string currentPath: initialPath

    property var _history: [initialPath]
    property int _historyIndex: 0

    readonly property bool canGoBack: _historyIndex > 0
    readonly property bool canGoForward: _historyIndex < _history.length - 1

    // Per-directory cursor position cache: { path → index }
    property var _cursorCache: ({})

    function saveCursor(path: string, index: int): void {
        _cursorCache[path] = index;
    }

    function restoreCursor(path: string): int {
        return _cursorCache[path] ?? 0;
    }

    function navigate(path: string): void {
        if (path === currentPath)
            return;

        clearSearch();
        clearFlash();
        if (activeModal !== modalNone) closeModal();

        // Truncate forward history and append new path
        _history = _history.slice(0, _historyIndex + 1).concat([path]);
        _historyIndex = _history.length - 1;
        currentPath = path;
    }

    function back(): void {
        if (!canGoBack)
            return;

        clearSearch();
        clearFlash();
        if (activeModal !== modalNone) closeModal();
        _historyIndex--;
        currentPath = _history[_historyIndex];
    }

    function forward(): void {
        if (!canGoForward)
            return;

        clearSearch();
        clearFlash();
        if (activeModal !== modalNone) closeModal();
        _historyIndex++;
        currentPath = _history[_historyIndex];
    }

    function goUp(): void {
        if (currentPath === "/")
            return;

        clearSearch();
        clearFlash();
        navigate(Paths.parentDir(currentPath));
    }

    // === Search ===
    property bool searchActive: false
    property string searchQuery: ""
    property var matchIndices: []
    property int currentMatchIndex: -1
    // O(1) lookup for delegate isSearchMatch bindings (avoids O(n) indexOf per delegate)
    readonly property var _matchIndexSet: {
        const s = {};
        for (let i = 0; i < matchIndices.length; i++)
            s[matchIndices[i]] = true;
        return s;
    }

    signal searchConfirmed()
    signal searchCancelled()

    function clearSearch(): void {
        searchActive = false;
        searchQuery = "";
        matchIndices = [];
        currentMatchIndex = -1;
    }

    function startSearch(): void {
        clearSearch();
        clearFlash();
        searchActive = true;
    }

    function nextMatch(): void {
        if (matchIndices.length === 0)
            return;
        currentMatchIndex = (currentMatchIndex + 1) % matchIndices.length;
    }

    function previousMatch(): void {
        if (matchIndices.length === 0)
            return;
        currentMatchIndex = (currentMatchIndex - 1 + matchIndices.length) % matchIndices.length;
    }

    // === Flash navigation ===
    property bool flashActive: false
    property string flashQuery: ""
    property var flashMatches: []           // Match objects from FlashLogic.computeFlash()
    property var flashLabelChars: ({})      // { char: true } — chars assigned as labels
    property var flashContinuations: ({})   // { char: true } — chars that extend the query
    property string flashPendingLabel: ""   // First char of a 2-char label being resolved
    // Per-column match maps — set imperatively by FlashHandler.recompute()
    // so each ListView's delegates only re-evaluate when their own column
    // changes, not when any column's matches change.
    property var flashCurrentMatchMap: ({})
    property var flashParentMatchMap: ({})
    property var flashPreviewMatchMap: ({})

    signal flashJump(string column, int index, string path)

    function startFlash(): void {
        clearSearch();
        clearFlash();
        flashActive = true;
    }

    // NOTE: If you add a flashXxxMatchMap property above, reset it here too.
    function clearFlash(): void {
        flashActive = false;
        flashQuery = "";
        flashMatches = [];
        flashLabelChars = {};
        flashContinuations = {};
        flashPendingLabel = "";
        flashCurrentMatchMap = {};
        flashParentMatchMap = {};
        flashPreviewMatchMap = {};
    }

    // === Sort (per-window, ephemeral) ===
    // Default: FileSystemModel.Modified — stored as int because WindowState
    // intentionally does not depend on the C++ plugin's QML module.
    property int sortBy: 1
    property bool sortReverse: true

    readonly property var _sortLabels: ["Alphabetical", "Modified", "Size", "Extension", "Natural"]
    readonly property string sortLabel: _sortLabels[sortBy] ?? "?"

    // === Chord / which-key state ===
    property string activeChordPrefix: ""
    readonly property bool chordActive: activeChordPrefix !== ""

    // Whether the cursor's current entry is an image. Published by the active
    // view (FileList / FileTreeView) so the "c" chord can offer the
    // image-to-clipboard (ci) row only when the cursor sits on an image.
    property bool currentEntryIsImage: false

    // Called by the active view on cursor move / tab switch — single source of
    // the image-chord gate so the two views don't duplicate the predicate.
    function syncImageCursor(entry: var): void {
        currentEntryIsImage = ImageChord.entryIsImage(entry);
    }

    // === Bookmark sub-mode (entered via gn / gx) ===
    property string bookmarkSubMode: ""        // "" | "create" | "delete"
    readonly property bool bookmarkSubModeActive: bookmarkSubMode !== ""

    // === Transient status message (auto-clears after 2s) ===
    property string transientMessage: ""

    // var (not Timer) on purpose: Qt.createQmlObject is typed as returning
    // QObject, so a Timer-typed property trips qmllint's incompatible-type
    // check even though the created object IS a Timer.
    property var _transientTimer: Qt.createQmlObject(
        'import QtQuick; Timer { interval: 2000 }', root, "transientTimer")

    function showTransientMessage(msg: string): void {
        transientMessage = msg;
        _transientTimer.restart();
    }

    Component.onCompleted: {
        _transientTimer.triggered.connect(() => { root.transientMessage = ""; });
    }

    // Static chord configuration — the built-in binds that never change.
    readonly property var _staticChordBindings: ({
        "g": {
            label: "go to",
            binds: [
                { key: "g", label: "Top", icon: "vertical_align_top" }
            ]
        },
        "c": {
            label: "copy to clipboard",
            binds: [
                { key: "c", label: "File path", icon: "link" },
                { key: "f", label: "Filename", icon: "description" },
                { key: "n", label: "Name without extension", icon: "label" },
                { key: "d", label: "Directory path", icon: "folder" }
            ]
        },
        ",": {
            label: "sort by",
            binds: [
                { key: "a/A", label: "Alphabetical", icon: "sort_by_alpha" },
                { key: "m/M", label: "Modified date", icon: "schedule" },
                { key: "s/S", label: "Size", icon: "straighten" },
                { key: "e/E", label: "Extension", icon: "extension" },
                { key: "n/N", label: "Natural", icon: "format_list_numbered" }
            ]
        }
    })

    // Merged view: static binds + user bookmarks. Re-evaluated when bookmarks change.
    readonly property var chordBindings: {
        // Shallow-clone: copy top-level map + slice the "g" binds array so mutations
        // don't affect _staticChordBindings. Other chord groups are read-only here.
        const gBinds = _staticChordBindings["g"].binds.slice();
        const base = Object.assign({}, _staticChordBindings, {
            "g": Object.assign({}, _staticChordBindings["g"], { binds: gBinds })
        });
        const userBookmarks = BookmarkService.bookmarks;

        // Track which keys are reserved — seed from BookmarkService to avoid duplication
        const usedKeys = {};
        for (const k of BookmarkService._reservedKeys)
            usedKeys[k] = true;
        for (const b of gBinds)
            usedKeys[b.key] = true;

        for (const [key, bm] of Object.entries(userBookmarks)) {
            const icon = BookmarkService.iconForPath(bm.path);
            if (usedKeys[key]) {
                const idx = gBinds.findIndex(b => b.key === key);
                if (idx >= 0)
                    gBinds[idx] = { key: key, label: bm.label, icon: icon, isUser: true };
            } else {
                gBinds.push({ key: key, label: bm.label, icon: icon, isUser: true });
            }
        }

        // Separator + bookmark management actions — always last
        gBinds.push({ isSeparator: true });
        gBinds.push({ key: "n", label: "New bookmark", icon: "bookmark_add", isAction: true });
        gBinds.push({ key: "x", label: "Delete bookmark", icon: "bookmark_remove", isAction: true });

        // Image-to-clipboard (ci): offered only when the cursor sits on an
        // image, so the which-key HUD and ? help hide it otherwise. The helper
        // reassigns the "c" group without mutating _staticChordBindings (see
        // ImageChord.copyGroupWithImageRow); tested by tst_chordbindings.qml.
        base["c"] = ImageChord.copyGroupWithImageRow(_staticChordBindings["c"], currentEntryIsImage);

        return base;
    }

    // === Selection (Space-toggled marks) ===
    // Stores absolute paths as keys: { "/home/user/file.txt": true, ... }
    // Persists across directory changes — cleared explicitly by the user.
    property var selectedPaths: ({})
    // Explicit counter avoids allocating a temporary array via Object.keys()
    // on every read of selectedCount (StatusBar + FileList both bind to it).
    property int _selectionCount: 0
    readonly property int selectedCount: _selectionCount

    function toggleSelection(path: string): void {
        const copy = Object.assign({}, selectedPaths);
        if (copy[path]) {
            delete copy[path];
            _selectionCount--;
        } else {
            copy[path] = true;
            _selectionCount++;
        }
        selectedPaths = copy;
    }

    function clearSelection(): void {
        selectedPaths = {};
        _selectionCount = 0;
    }

    function getSelectedPathsArray(): var {
        return Object.keys(selectedPaths);
    }

    // === Modal state ===
    // Single gate property prevents multiple modals from opening simultaneously.
    // Data properties (deleteConfirmPaths, renameTargetPath, etc.) carry per-modal
    // payloads; activeModal determines which modal is visible.
    readonly property int modalNone: 0
    readonly property int modalDelete: 1
    readonly property int modalCreate: 2
    readonly property int modalRename: 3
    readonly property int modalContextMenu: 4
    readonly property int modalZoxide: 5
    readonly property int modalFuzzyFinder: 6
    readonly property int modalHelp: 7

    property int activeModal: modalNone

    // --- Modal data (read by popup components) ---
    property var deleteConfirmPaths: []
    // Directory the create popup writes into. Passed explicitly because the
    // views disagree on what "here" means: Miller creates in currentPath, the
    // tree in the hovered directory (or the hovered file's parent).
    property string createTargetDir: ""
    property string renameTargetPath: ""
    property bool renameIncludeExtension: false
    property string contextMenuTargetPath: ""
    property string contextMenuTargetMimeType: ""

    signal createCompleted(filename: string)
    signal renameCompleted(newName: string)
    signal fuzzyFinderNavigated(filename: string)

    function requestDelete(paths: var): void {
        deleteConfirmPaths = paths;
        activeModal = modalDelete;
    }

    function requestCreate(targetDir: string): void {
        createTargetDir = targetDir;
        activeModal = modalCreate;
    }

    function requestRename(path: string, includeExtension: bool): void {
        renameTargetPath = path;
        renameIncludeExtension = includeExtension;
        activeModal = modalRename;
    }

    function requestContextMenu(path: string, mimeType: string): void {
        // Set mimeType before activeModal — the Loader activates on activeModal,
        // so mimeType must already be available when Component.onCompleted fires.
        contextMenuTargetMimeType = mimeType;
        contextMenuTargetPath = path;
        activeModal = modalContextMenu;
    }

    function requestZoxide(): void {
        activeModal = modalZoxide;
    }

    function requestFuzzyFinder(): void {
        activeModal = modalFuzzyFinder;
    }

    // Keyboard cheat-sheet (HelpPopup). No payload — the popup reads the
    // KeyRegistry directly, so this just flips the modal gate.
    function openHelp(): void {
        activeModal = modalHelp;
    }

    function closeModal(): void {
        activeModal = modalNone;
        deleteConfirmPaths = [];
        createTargetDir = "";
        renameTargetPath = "";
        renameIncludeExtension = false;
        contextMenuTargetPath = "";
        contextMenuTargetMimeType = "";
    }

    // === Audio preview ===
    signal audioPlaybackToggle()

    // === HTML render preview (Ctrl+R) ===
    // When true AND the previewed file is HTML, PreviewContent renders it in
    // WebEngine instead of showing highlighted source. Reset whenever the
    // previewed entry changes (PreviewContent.onEntryChanged) so each HTML file
    // starts in cheap source view — spinning up Chromium only on explicit intent,
    // never per j/k. Meaningful only in the Miller preview pane.
    property bool htmlRenderActive: false

    function toggleHtmlRender(): void {
        htmlRenderActive = !htmlRenderActive;
    }

    function resetHtmlRender(): void {
        htmlRenderActive = false;
    }

    // === View mode (per-tab) ===
    // Standalone FM toggles between miller-columns and recursive tree via Ctrl-E.
    // Stored as int (mirrors the activeModal pattern) so WindowState stays
    // independent of the C++ plugin module.
    readonly property int viewMillerColumns: 0
    readonly property int viewTree: 1
    property int viewMode: viewMillerColumns

    function toggleViewMode(): void {
        // Clear transient search/flash state — indices reference the outgoing
        // view's row model (Miller's fsModel entries vs Tree's flattened _rows)
        // and would be meaningless against the incoming view. Both clear
        // functions are idempotent so no guard needed.
        clearSearch();
        clearFlash();
        viewMode = (viewMode === viewMillerColumns) ? viewTree : viewMillerColumns;
    }
}
