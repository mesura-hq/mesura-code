# Symmetria File Manager — Product Requirements Document

> **Status**: Draft v1.0
> **Project**: `~/projects/symmetria-file-manager/`
> **Target**: Symmetria QuickShell Desktop Shell
> **See also**: [RESEARCH.md](./RESEARCH.md) — feasibility analysis and Yazi IPC research

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [UI Design](#3-ui-design)
4. [Keyboard Architecture](#4-keyboard-architecture)
5. [File Operations](#5-file-operations)
6. [Configuration](#6-configuration)
7. [Project Structure & Install](#7-project-structure--install)
8. [Phased Roadmap](#8-phased-roadmap)
9. [Integration Points](#9-integration-points)
10. [C++ Model Extensions](#10-c-model-extensions)

---

## 1. Project Overview

### Vision

A keyboard-first, Yazi-inspired graphical file manager rendered as a FloatingWindow
inside the Symmetria QuickShell desktop shell. The file manager takes cues from Yazi's
UX philosophy — Vim-style modal keybindings, minimal chrome, fast navigation — but is
implemented entirely in native Qt/QML/C++ with **no Yazi runtime dependency**.

### Design Principles

- **Keyboard-first, mouse-supported**: Every action reachable via keyboard; mouse is a
  convenience layer, not the primary input
- **Instant feedback**: Directory listings via C++ `FileSystemModel` (async, zero IPC
  latency); no waiting on external processes
- **Yazi-inspired, not Yazi-bound**: Borrows UX patterns (modal keys, yank/paste model,
  list-centric view) without coupling to Yazi's runtime or config format
- **Symmetria-native**: Uses existing shell infrastructure — theming (`Colours`),
  components (`StyledRect`, `StyledText`, `MaterialIcon`), IPC (`IpcHandler`), and
  animation system (`Appearance`)
- **Composable**: Separate repository with install script; does not pollute Symmetria's
  upstream git history

### Technology Stack

| Layer | Technology |
|-------|-----------|
| Window | QuickShell `FloatingWindow` (Wayland, compositor-managed) |
| UI | QML (Qt Quick) with Symmetria's component library |
| File listing | C++ `FileSystemModel` (`QAbstractListModel` + `QtConcurrent`) |
| File operations | `gio` (trash), coreutils (`cp`/`mv`/`rm`) via QML `Process` |
| State management | QML Singleton (`FileManagerService`) |
| Configuration | `JsonObject` serialized to `shell.json` |
| External control | `qs ipc call filemanager <command>` |

### Architecture Decision: Why Not Yazi Backend?

The [RESEARCH.md](./RESEARCH.md) feasibility study explored a hybrid architecture where
Yazi runs headless in a PTY and handles file operations via DDS IPC. This was rejected
for the MVP in favor of a pure native approach because:

1. **Query gap**: Yazi's DDS is push-only — no way to ask "list directory X". The C++
   `FileSystemModel` already solves this with zero latency.
2. **Complexity budget**: A bridge process (Python/Rust) speaking DDS adds a significant
   moving part for relatively few MVP benefits.
3. **Startup cost**: Spawning Yazi in a hidden PTY adds ~200ms cold start vs. instant
   native model.
4. **Maintenance surface**: Pinning to Yazi's DDS protocol version creates a fragile
   coupling.

Yazi integration remains a **Phase 3** option for advanced operations (bulk rename,
archive browsing, remote FS) if the native approach proves insufficient.

---

## 2. Architecture

### System Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  Symmetria Shell (QuickShell)                                       │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  FileManager FloatingWindow                                   │  │
│  │                                                               │  │
│  │  ┌──────────┐ ┌──────────────────────────┐ ┌──────────────┐  │  │
│  │  │ Sidebar  │ │      FileList            │ │  (Phase 2)   │  │  │
│  │  │          │ │  ListView + FileListItem  │ │  Preview     │  │  │
│  │  │ Bookmarks│ │  ┌─────────────────────┐ │ │  Panel       │  │  │
│  │  │ Devices  │ │  │  KeyHandler (QML)   │ │ │              │  │  │
│  │  │ Pinned   │ │  │  Modal: N/V/C modes │ │ │              │  │  │
│  │  └──────────┘ │  └─────────────────────┘ │ └──────────────┘  │  │
│  │               └──────────────────────────┘                    │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │ PathBar (breadcrumb ↔ editable input)                   │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │ StatusBar (mode · selection · file info · free space)   │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────┐  ┌──────────────────────────────────┐    │
│  │ FileManagerService   │  │ FileManagerConfig                │    │
│  │ (QML Singleton)      │  │ (JsonObject → shell.json)        │    │
│  │                      │  │                                  │    │
│  │ • currentPath        │  │ • enabled, showHidden            │    │
│  │ • yankClipboard      │  │ • sortBy, sortReverse, dirFirst  │    │
│  │ • selectionModel     │  │ • bookmarks, sizes               │    │
│  │ • operationQueue     │  └──────────────────────────────────┘    │
│  └──────────┬───────────┘                                          │
│             │                                                      │
│  ┌──────────▼───────────┐                                          │
│  │ FileSystemModel (C++)│                                          │
│  │ • async scanning     │                                          │
│  │ • QFileSystemWatcher │                                          │
│  │ • MIME detection     │                                          │
│  │ • sort/filter        │                                          │
│  └──────────────────────┘                                          │
└─────────────────────────────────────────────────────────────────────┘
         │
         │ File operations via QML Process
         ▼
    ┌──────────────┐
    │ System tools  │
    │ gio, cp, mv   │
    │ rm, xdg-open  │
    └──────────────┘
```

### Component Responsibilities

#### WindowFactory (Singleton)

Manages FloatingWindow lifecycle. Follows the same pattern as Symmetria's control center
`WindowFactory`:

- `create()` — instantiates a new FloatingWindow via `Component.createObject()`
- `onVisibleChanged: if (!visible) destroy()` — self-destructs on close
- Only one instance at a time (guard against duplicate creation)

```
WindowFactory.create()
  └→ FloatingWindow { FileManager { ... } }
       └→ onVisibleChanged: !visible → destroy()
```

#### FileManager.qml (Main Content)

The root content component inside the FloatingWindow. Owns the layout:

```
RowLayout {
    Sidebar { }           // Left: bookmarks, devices
    ColumnLayout {
        PathBar { }       // Top: breadcrumb navigation
        FileList { }      // Center: main file listing (fills space)
        StatusBar { }     // Bottom: mode, selection, info
    }
}
```

#### FileManagerService (QML Singleton)

Persistent state that outlives the window:

| Property | Type | Purpose |
|----------|------|---------|
| `currentPath` | `string` | Active directory path |
| `history` | `list<string>` | Navigation history for back/forward |
| `historyIndex` | `int` | Current position in history |
| `yankClipboard` | `var` | `{paths: [...], mode: "copy"|"cut"}` |
| `selections` | `var` | Map of `path → bool` for multi-select |
| `bookmarks` | `list<var>` | User-pinned directories |
| `marks` | `var` | Vim-style marks (`'a` → `/home/user/docs`) |

Methods:

| Method | Description |
|--------|-------------|
| `navigate(path)` | Push path to history, update currentPath |
| `back()` / `forward()` | History navigation |
| `yank(paths, mode)` | Set yank clipboard (copy or cut) |
| `paste(destination)` | Execute copy/move from yank clipboard |
| `trash(paths)` | Send to trash via `gio trash` |
| `deletePermanent(paths)` | `rm -rf` with confirmation |
| `rename(oldPath, newName)` | `mv` to same directory with new name |

#### KeyHandler.qml

Captures keyboard input and dispatches actions based on current mode. Lives inside
FileList's `FocusScope`. Details in [Section 4](#4-keyboard-architecture).

---

## 3. UI Design

### Layout: List View

The file manager uses a **list view** (not grid), matching Yazi's information-dense,
keyboard-navigable style.

```
┌─────────────────────────────────────────────────────────────────┐
│  PathBar: 🏠 / home / jc / projects / symmetria-file-manager   [:]      │
├────────────┬────────────────────────────────────────────────────┤
│            │  Name              Size      Modified     Perms    │
│  Bookmarks │  ─────────────────────────────────────────────────  │
│            │  📁 .git/           —        2024-03-15   drwxr-x  │
│  🏠 Home    │  📁 modules/        —        2024-03-16   drwxr-x  │
│  📄 Documents│ 📁 config/         —        2024-03-14   drwxr-x  │
│  🖼 Pictures │ 📁 services/       —        2024-03-14   drwxr-x  │
│  🎵 Music   │  📄 PRD.md         12.4K    2024-03-16   -rw-r--  │
│  📦 Downloads│ 📄 RESEARCH.md     8.2K    2024-03-15   -rw-r--  │
│            │  📄 install.sh       1.1K    2024-03-14   -rwxr-x  │
│  ──────────│  ▓ (cursor)                                        │
│  Devices   │                                                    │
│  💾 /       │                                                    │
│  💾 /data   │                                                    │
│            │                                                    │
├────────────┴────────────────────────────────────────────────────┤
│  NORMAL │ 3 selected │ PRD.md · 12.4K · markdown │ 42.1G free  │
└─────────────────────────────────────────────────────────────────┘
```

### PathBar

- **Default**: Breadcrumb mode — clickable segments (`home` / `jc` / `projects`)
- **Edit mode**: Press `:` to toggle into a text input for direct path entry
- **Behavior**: Typing in edit mode filters/autocompletes; Enter navigates; Escape
  reverts to breadcrumb
- **Components**: Row of clickable `StyledText` segments with `/` separators; a
  `TextInput` overlay for edit mode

### Sidebar

| Section | Contents |
|---------|----------|
| **Bookmarks** | XDG standard dirs (Home, Documents, Pictures, etc.) + user-defined |
| **Devices** | Mounted volumes from `/proc/mounts` or `gio mount -l` |
| **Pinned** | User-pinned directories (drag or `b` to bookmark) |

- Fixed width (~200px), collapsible with `Ctrl+B`
- Single-click navigates to directory
- Current path highlighted in sidebar

### FileList

- `ListView` backed by `FileSystemModel`
- Each item (`FileListItem.qml`) shows:
  - **Icon**: `MaterialIcon` based on MIME type / `isDir`
  - **Name**: File/directory name with truncation
  - **Size**: Human-readable (directories show `—`)
  - **Modified**: Relative or absolute date (requires C++ extension)
  - **Permissions**: Unix-style string (requires C++ extension)
- **Symlinks**: Shown with a link overlay icon + target path in tooltip
- **Hidden files**: Toggled with `.` key (reads `Config.fileManager.showHidden`)
- **Selection**: Multi-select via Space (toggle) or Visual mode (v/V)
  - Selected items shown with accent background (`Colours.tPalette.m3primary` at low opacity)
  - Cursor item has a distinct highlight (`StateLayer` or border)

### FileListItem Layout

```
┌─ Icon ─┬─── Name ──────────────────┬── Size ──┬── Modified ──┬── Perms ──┐
│  📄     │  RESEARCH.md              │   8.2K   │  Mar 15      │  -rw-r--  │
└─────────┴───────────────────────────┴──────────┴──────────────┴───────────┘
```

- Row height: ~36px (configurable in `Config.fileManager.sizes.itemHeight`)
- Column widths: Icon fixed (24px) · Name flex-fill · Size fixed (80px) · Modified
  fixed (100px) · Permissions fixed (80px)
- Alternating row backgrounds for readability (subtle, theme-aware)

### StatusBar

Four sections, left to right:

1. **Mode indicator**: `NORMAL`, `VISUAL`, `VISUAL LINE`, or `COMMAND`
2. **Selection info**: `3 selected` or empty
3. **Current file info**: `filename · size · mimetype`
4. **Disk usage**: Free space on current filesystem

### Theming

Full integration with Symmetria's theming system:

- **Colors**: All from `Colours.tPalette.*` (m3surface, m3primary, m3onSurface, etc.)
- **Text**: `StyledText` components with Appearance-driven font sizes
- **Animations**: `CAnim` / `Anim` with `Appearance.anim.durations.*` timing
- **Backgrounds**: `StyledRect` with radius from `Appearance.rounding.*`
- **State layers**: `StateLayer` for hover/focus/press feedback on interactive elements

---

## 4. Keyboard Architecture

### Modal System

Three modes, inspired by Vim:

| Mode | Indicator | Entry | Exit |
|------|-----------|-------|------|
| **Normal** | `NORMAL` | Default; Escape from any mode | — |
| **Visual** | `VISUAL` / `VISUAL LINE` | `v` (toggle) / `V` (line) | Escape, or action |
| **Command** | `COMMAND` | `:` | Enter (execute) / Escape (cancel) |

### Normal Mode Keybindings

#### Navigation

| Key | Action | Notes |
|-----|--------|-------|
| `j` / `↓` | Move cursor down | Wraps at bottom (optional) |
| `k` / `↑` | Move cursor up | Wraps at top (optional) |
| `h` / `←` | Navigate to parent directory | Equivalent to `cd ..` |
| `l` / `→` / `Enter` | Enter directory / open file | `xdg-open` for files |
| `gg` | Jump to first item | Multi-key sequence |
| `G` | Jump to last item | |
| `Ctrl+d` | Half-page down | |
| `Ctrl+u` | Half-page up | |
| `H` | Jump to top of visible area | |
| `M` | Jump to middle of visible area | |
| `L` | Jump to bottom of visible area | |

#### Operations

| Key | Action | Notes |
|-----|--------|-------|
| `yy` | Yank (copy) current/selected | Stores paths in yank clipboard |
| `dd` | Cut current/selected | Marks for move |
| `pp` | Paste from yank clipboard | Executes copy or move |
| `D` | Trash current/selected | Via `gio trash` |
| `Shift+D` | Permanent delete | With confirmation dialog |
| `r` | Rename current file | Inline rename (TextInput overlay) |
| `a` | Create new file | Command mode with prompt |
| `A` | Create new directory | Command mode with prompt |
| `o` | Open with... | Uses `xdg-open --chooser` or custom picker |
| `Space` | Toggle selection on current | Move cursor down after toggle |
| `.` | Toggle hidden files | Persists to config |
| `/` | Enter search/filter mode | Fuzzy-filters current directory |
| `Escape` | Clear filter / cancel | Context-dependent |
| `q` | Close file manager | |
| `-` | Navigate back in history | |
| `=` | Navigate forward in history | |

#### Bookmarks & Marks

| Key | Action |
|-----|--------|
| `b` | Bookmark current directory |
| `'` + `char` | Jump to mark |
| `m` + `char` | Set mark at current directory |
| `~` | Navigate to home directory |

### Visual Mode

Entered with `v` (character-select) or `V` (line-select):

- `j`/`k` extends selection range
- `Space` toggles individual items within range
- Any operation key (`yy`, `dd`, `D`) acts on the visual selection, then exits Visual
- `Escape` cancels visual mode (preserves existing selection from before entering)

### Command Mode

Entered with `:`:

- PathBar switches to text input mode
- Typing filters/autocompletes directory paths
- Special commands:
  - `:q` — close file manager
  - `:cd <path>` — navigate to path
  - `:mkdir <name>` — create directory
  - `:touch <name>` — create file
  - `:sort name|size|date|ext` — change sort
  - `:set hidden` / `:set nohidden` — toggle hidden files

### Multi-Key Sequence Detection

Multi-key combos (`gg`, `yy`, `dd`, `pp`) use a **timer-based chord system**:

```
KeyHandler {
    property string pendingKey: ""
    property Timer chordTimer: Timer { interval: 500; onTriggered: flush() }

    Keys.onPressed: event => {
        if (pendingKey !== "") {
            // Complete the chord
            handleChord(pendingKey + event.text)
            pendingKey = ""
            chordTimer.stop()
        } else if (isChordStarter(event.text)) {
            // Start a chord
            pendingKey = event.text
            chordTimer.restart()
        } else {
            // Single key
            handleSingle(event.text)
        }
    }

    function flush() {
        // Timer expired — treat pending key as single press
        handleSingle(pendingKey)
        pendingKey = ""
    }
}
```

This approach is preferred over Symmetria's `KeyChords` module because file manager
keybindings are internal to the window (not global shell shortcuts).

### Focus Management

- The FloatingWindow requests `WlrKeyboardFocus.Exclusive` when active to prevent
  Hyprland from intercepting keys (particularly `h/j/k/l` which conflict with window
  management)
- `FocusScope` wraps the FileList to properly scope keyboard input
- Tab switches focus between Sidebar, FileList, and PathBar
- Sidebar and PathBar have their own key handling (Enter to navigate, Escape to return
  focus to FileList)

---

## 5. File Operations

### Yank / Paste Model

The file manager uses Yazi's yank/paste paradigm instead of traditional clipboard:

```
State:
  yankClipboard: { paths: ["/home/jc/file.txt", ...], mode: "copy" | "cut" }

Flow:
  yy → store selected paths with mode="copy"
  dd → store selected paths with mode="cut"
  pp → execute:
    if mode == "copy": cp -r <paths> <currentDir>/
    if mode == "cut":  mv <paths> <currentDir>/
    then clear yankClipboard
```

- Yanked files are visually indicated (dimmed for cut, badge for copy)
- Yank clipboard persists in `FileManagerService` across window open/close cycles
- Paste into the same directory auto-renames (appends ` (copy)`)

### Trash

| Action | Key | Implementation |
|--------|-----|----------------|
| Trash | `D` | `gio trash <path>` — respects FreeDesktop trash spec |
| Permanent delete | `Shift+D` | `rm -rf <path>` — requires confirmation dialog |

The confirmation dialog for permanent delete shows:
- File/directory name and size
- "This action cannot be undone" warning
- Confirm / Cancel buttons (Enter / Escape)

### Rename

`r` enters inline rename mode:
- FileListItem's name column becomes a `TextInput`
- Pre-filled with current name, base name selected (extension excluded)
- Enter commits rename (`mv oldpath newpath`)
- Escape cancels
- Validation: disallow empty names, `/` in names, names starting with `-`

### Create

| Action | Key | Notes |
|--------|-----|-------|
| New file | `a` | Opens command input, creates with `touch` |
| New directory | `A` | Opens command input, creates with `mkdir -p` |

### Open

| Action | Key | Implementation |
|--------|-----|----------------|
| Open default | `l` / `Enter` | `xdg-open <path>` for files, navigate for dirs |
| Open with... | `o` | Future: picker dialog; MVP: `xdg-open` only |

### Progress & Feedback

- **Short operations** (rename, trash single file): Instant, no feedback needed
- **Long operations** (copy large files, delete many): Toast notification via
  `Toaster.toast()` with:
  - Operation type and file count
  - Completion notification on finish
  - Error notification on failure with reason
- **Phase 2**: Inline progress bar in StatusBar for active operations

### Error Handling

All file operations catch errors and display via `Toaster`:

| Error | Message |
|-------|---------|
| Permission denied | "Cannot {op} {filename}: Permission denied" |
| File exists (paste) | "File already exists. Rename, overwrite, or skip?" |
| Disk full | "Cannot {op}: No space left on device" |
| File not found | "{filename} no longer exists" (race with watcher) |

---

## 6. Configuration

### FileManagerConfig.qml

```qml
import Quickshell.Io

JsonObject {
    // Feature toggles
    property bool enabled: true
    property bool showHidden: false

    // Sorting
    property string sortBy: "name"        // "name" | "size" | "date" | "extension"
    property bool sortReverse: false
    property bool dirFirst: true

    // UI sizing
    property Sizes sizes: Sizes {}

    component Sizes: JsonObject {
        property int windowWidth: 1000
        property int windowHeight: 600
        property int sidebarWidth: 200
        property int itemHeight: 36
    }

    // Bookmarks (beyond XDG defaults)
    property list<var> bookmarks: []
    // Format: [{ name: "Projects", path: "/home/jc/projects", icon: "folder_special" }]

    // Behavior
    property bool confirmDelete: true      // Show confirmation for permanent delete
    property bool wrapNavigation: false    // j/k wrap at list boundaries
    property int chordTimeout: 500         // Multi-key sequence timeout (ms)
}
```

### Registration in Config.qml

Add to `JsonAdapter`:

```qml
property FileManagerConfig fileManager: FileManagerConfig {}
```

And the corresponding alias:

```qml
property alias fileManager: adapter.fileManager
```

### Persistence

All config values serialize to `~/.config/quickshell/shell.json` under the
`"fileManager"` key. Changes via `:set` commands or UI toggles call `Config.save()`
to persist.

---

## 7. Project Structure & Install

### Repository Layout

```
~/projects/symmetria-file-manager/
├── PRD.md                            # This document
├── RESEARCH.md                       # Feasibility research
├── install.sh                        # Symlink into Symmetria
│
├── modules/filemanager/              # → symlinked to symmetria/modules/filemanager/
│   ├── FileManagerModule.qml         # Root component (instantiated in shell.qml)
│   ├── WindowFactory.qml             # Singleton — creates FloatingWindow instances
│   ├── FileManager.qml               # Main content layout inside FloatingWindow
│   ├── FileList.qml                  # ListView + model binding
│   ├── FileListItem.qml              # Single row delegate
│   ├── PathBar.qml                   # Breadcrumb ↔ editable path input
│   ├── Sidebar.qml                   # Bookmarks, devices, pinned
│   ├── StatusBar.qml                 # Mode, selection, info, disk space
│   ├── KeyHandler.qml                # Modal keyboard input dispatcher
│   └── Background.qml                # Window background (StyledRect + theme)
│
├── config/                           # Config file(s) to integrate
│   └── FileManagerConfig.qml         # → copied/linked into symmetria/config/
│
└── services/                         # Service singleton(s)
    └── FileManagerService.qml        # → copied/linked into symmetria/services/
```

### install.sh Strategy

The install script creates symlinks from the Symmetria directory tree into this repo,
allowing development in isolation while the shell picks up changes live.

```bash
#!/usr/bin/env bash
set -euo pipefail

SYMMETRIA="$HOME/.config/quickshell/symmetria"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Symlink the module directory
ln -sfn "$PROJECT_DIR/modules/filemanager" "$SYMMETRIA/modules/filemanager"

# Symlink the config
ln -sf "$PROJECT_DIR/config/FileManagerConfig.qml" "$SYMMETRIA/config/FileManagerConfig.qml"

# Symlink the service
ln -sf "$PROJECT_DIR/services/FileManagerService.qml" "$SYMMETRIA/services/FileManagerService.qml"

echo "Installed. You must manually:"
echo "  1. Add 'import \"modules/filemanager\"' to shell.qml"
echo "  2. Add 'FileManagerModule {}' to ShellRoot in shell.qml"
echo "  3. Add 'property FileManagerConfig fileManager: FileManagerConfig {}' to Config.qml JsonAdapter"
echo "  4. Clear QML cache: rm -rf ~/.cache/quickshell/qmlcache"
```

### Why Symlinks?

- **Live reload**: Edit files in `~/projects/symmetria-file-manager/`, changes are immediately
  visible after clearing QML cache
- **Clean separation**: `git log` in Symmetria stays clean; this project has its own
  history
- **Easy uninstall**: Remove symlinks and the three manual additions to restore Symmetria
  to stock

### Manual Integration Steps

These cannot be automated safely (they modify Symmetria's source files):

1. **shell.qml**: Add `import "modules/filemanager"` and `FileManagerModule {}` in
   `ShellRoot`
2. **Config.qml**: Add `property FileManagerConfig fileManager: FileManagerConfig {}`
   to the `JsonAdapter` block, and `property alias fileManager: adapter.fileManager`
   to the `Singleton` block
3. **Shortcuts.qml** (optional): Add `CustomShortcut` and `IpcHandler` for the file
   manager (see [Section 9](#9-integration-points))

---

## 8. Phased Roadmap

### Phase 1 — MVP: Browse, Navigate, Operate

**Goal**: A usable keyboard-driven file browser with core operations.

| Feature | Details |
|---------|---------|
| **Window** | FloatingWindow via WindowFactory singleton |
| **File listing** | ListView backed by FileSystemModel with sort/filter |
| **Navigation** | j/k/h/l, gg/G, Ctrl+d/u, directory enter/parent |
| **Path bar** | Breadcrumb display + editable input (`:` toggle) |
| **Sidebar** | XDG bookmarks + mounted devices |
| **Status bar** | Mode indicator, selection count, file info |
| **Operations** | yy/dd/pp (yank/cut/paste), D (trash), r (rename), a/A (create) |
| **Open files** | l/Enter with xdg-open |
| **Visual mode** | v/V for multi-selection |
| **Search** | `/` to fuzzy-filter current directory |
| **Config** | showHidden, sortBy, sortReverse, dirFirst, sizes, bookmarks |
| **Theming** | Full Colours/Appearance integration |
| **IPC** | `qs ipc call filemanager open` |

**C++ work required** (see [Section 10](#10-c-model-extensions)):
- Add `modifiedDate`, `permissions`, `isSymlink`, `symlinkTarget` to FileSystemEntry
- Add `sortBy` enum and `dirFirst` property to FileSystemModel

### Phase 2 — Enhanced Experience

| Feature | Details |
|---------|---------|
| **Preview panel** | Right-side panel: text preview, image thumbnails, file metadata |
| **Multi-tab** | Tab bar above FileList; `t` to open new tab, `gt`/`gT` to switch |
| **Bulk rename** | Visual-select files, `R` enters bulk rename buffer |
| **Archive browsing** | Enter `.zip`/`.tar.gz` as virtual directories (read-only) |
| **Progress tracking** | Inline progress bar in StatusBar for long operations |
| **Column resize** | Draggable column headers in FileList |
| **File size calc** | `Ctrl+Space` to calculate directory sizes (async, cancellable) |

### Phase 3 — Advanced Features

| Feature | Details |
|---------|---------|
| **Remote FS** | SSH/SFTP browsing via `gio` or `sshfs` |
| **Custom actions** | User-defined operations (config-driven shell commands) |
| **Plugin system** | QML-based plugins for custom previewers and actions |
| **Yazi integration** | Optional bridge for Yazi's task queue, plugins, bulk ops |
| **Drag and drop** | Wayland DnD for files to/from other applications |
| **Split panes** | Horizontal/vertical split views within single window |

---

## 9. Integration Points

### IPC: External Control

Add to `Shortcuts.qml`:

```qml
IpcHandler {
    target: "filemanager"

    function open(path: string): void {
        WindowFactory.create(path || "")
    }

    function close(): void {
        // WindowFactory handles cleanup
    }

    function navigate(path: string): void {
        FileManagerService.navigate(path)
    }
}
```

**Shell commands**:

```bash
# Open file manager (at home directory)
qs -c symmetria ipc call filemanager open

# Open at specific path
qs -c symmetria ipc call filemanager open /home/jc/projects

# Navigate existing instance to new path
qs -c symmetria ipc call filemanager navigate /tmp
```

### Hyprland Keybind

Add to `~/.config/hypr/keybinds.conf`:

```ini
bind = $mainMod, E, exec, qs -c symmetria ipc call filemanager open
```

### CustomShortcut

Add to `Shortcuts.qml` for Symmetria's internal shortcut system:

```qml
CustomShortcut {
    name: "fileManager"
    description: "Open file manager"
    onPressed: WindowFactory.create()
}
```

This allows users to bind the file manager to any key via `shell.json` config.

### Toaster Integration

File operations use the existing `Toaster` service for feedback:

```qml
Toaster.toast("File copied", `${count} files copied to ${dest}`, "file_copy", Toast.Info)
Toaster.toast("Delete failed", error.message, "error", Toast.Error)
```

---

## 10. C++ Model Extensions

The existing `FileSystemModel` and `FileSystemEntry` need extensions to support the file
manager's column display and sorting requirements.

### FileSystemEntry Additions

Current properties: `path`, `relativePath`, `name`, `baseName`, `parentDir`, `suffix`,
`size`, `isDir`, `isImage`, `mimeType`.

**New properties**:

| Property | Type | Source | Notes |
|----------|------|--------|-------|
| `modifiedDate` | `QDateTime` | `QFileInfo::lastModified()` | For "Modified" column |
| `permissions` | `QString` | `QFileInfo::permissions()` | Unix-style string (e.g., `-rwxr-xr--`) |
| `isSymlink` | `bool` | `QFileInfo::isSymLink()` | For symlink icon overlay |
| `symlinkTarget` | `QString` | `QFileInfo::symLinkTarget()` | For tooltip/status display |
| `isExecutable` | `bool` | `QFileInfo::isExecutable()` | For icon/color differentiation |
| `owner` | `QString` | `QFileInfo::owner()` | Phase 2: for detailed view |

**Implementation approach**: These all derive from `QFileInfo` which is already stored as
`m_fileInfo`. The properties should be CONSTANT (like existing ones) since entries are
recreated on directory refresh.

### FileSystemModel Additions

**New properties**:

| Property | Type | Default | Notes |
|----------|------|---------|-------|
| `sortBy` | `SortBy` enum | `Name` | Enum: `Name`, `Size`, `Date`, `Extension` |
| `dirFirst` | `bool` | `true` | Directories sorted before files |

**New enum**:

```cpp
enum SortBy {
    Name,
    Size,
    Date,
    Extension
};
Q_ENUM(SortBy)
```

**Impact on `compareEntries()`**: The existing compare function sorts by name only (with
`sortReverse` support). It needs to branch on `sortBy`:

```cpp
bool FileSystemModel::compareEntries(const FileSystemEntry* a, const FileSystemEntry* b) const {
    // Directories first (if enabled)
    if (m_dirFirst && a->isDir() != b->isDir())
        return a->isDir();  // dirs before files

    // Sort by selected column
    int cmp = 0;
    switch (m_sortBy) {
        case Name:      cmp = QString::compare(a->name(), b->name(), Qt::CaseInsensitive); break;
        case Size:      cmp = (a->size() < b->size()) ? -1 : (a->size() > b->size()) ? 1 : 0; break;
        case Date:      cmp = (a->modifiedDate() < b->modifiedDate()) ? -1 : 1; break;
        case Extension: cmp = QString::compare(a->suffix(), b->suffix(), Qt::CaseInsensitive); break;
    }

    return m_sortReverse ? (cmp > 0) : (cmp < 0);
}
```

### Optional: FileOpsService (C++)

For the MVP, file operations run via QML `Process` (calling `gio`, `cp`, `mv`, `rm`).
If performance or progress granularity becomes an issue, a C++ `FileOpsService` could
provide:

- Progress callbacks via `QFileSystemWatcher` or byte-counting
- Atomic operations with rollback
- Parallel I/O queue

This is explicitly **deferred to Phase 2+** unless QML Process proves too limiting.

---

## Appendix A: Reference Commands

### File Operations (System Tools)

```bash
# Trash (FreeDesktop spec)
gio trash /path/to/file

# Copy with progress (for future C++ integration)
cp -r --preserve=all /source /destination

# Move
mv /source /destination

# Delete permanently
rm -rf /path/to/file

# Open with default application
xdg-open /path/to/file

# Get filesystem free space
df -B1 --output=avail /path | tail -1

# List mounted volumes
gio mount -l
```

### QML Cache Management

```bash
# Must clear after any QML file changes while shell is running
rm -rf ~/.cache/quickshell/qmlcache

# Do NOT restart the shell process — it IS the active desktop
```

---

## Appendix B: Symmetria Pattern Reference

### Import Conventions

```qml
// Standard Symmetria imports for a module
import qs.components           // StyledRect, StyledText, MaterialIcon, CAnim
import qs.components.controls  // Buttons, sliders, toggles
import qs.services             // Colours, Appearance, Toaster, FocusManager
import qs.config               // Config singleton
import Quickshell              // FloatingWindow, Scope, Singleton, IpcHandler
import Quickshell.Io           // Process, SplitParser, JsonObject, JsonAdapter
import QtQuick                 // Item, Rectangle, ListView, etc.
import QtQuick.Layouts         // RowLayout, ColumnLayout
```

### Component Style Guide

```qml
// Use StyledRect for themed backgrounds
StyledRect {
    color: Colours.tPalette.m3surfaceContainer
    radius: Appearance.rounding.medium
}

// Use StyledText for themed text
StyledText {
    text: "filename.txt"
    font.pixelSize: Appearance.font.pixelSize.body
    color: Colours.tPalette.m3onSurface
}

// Use MaterialIcon for icons
MaterialIcon {
    icon: "folder"
    size: 20
    color: Colours.tPalette.m3primary
}

// Use StateLayer for interactive elements
StateLayer {
    hovered: mouseArea.containsMouse
    pressed: mouseArea.pressed
}

// Use Anim for theme-aware animations
Behavior on opacity {
    Anim { duration: Appearance.anim.durations.normal }
}
```

---

## Appendix C: Open Questions

These should be resolved during Phase 1 implementation:

1. **Column header**: Should FileList have a clickable header row for sort-by-column,
   or keep sorting exclusively via keyboard (`:sort`) and config?
2. **Drag-to-select**: Should mouse drag in FileList select a range of files (lasso),
   or should it initiate a Wayland DnD operation?
3. **Window size memory**: Should the window remember its last size/position, or always
   open at config defaults?
4. **Symlink resolution**: When entering a symlinked directory, should PathBar show the
   symlink path or the resolved real path?
5. **Clipboard integration**: Should `yy` also copy paths to the system clipboard
   (Wayland `wl-copy`), or keep yank internal-only?
