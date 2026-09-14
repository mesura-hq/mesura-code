<p align="center">
  <img src="assets/symmetria-fm.png" width="128" alt="Symmetria File Manager">
</p>

<h1 align="center">Symmetria File Manager</h1>

<p align="center">
  Keyboard-first file manager for <a href="https://quickshell.outfoxxed.me/">QuickShell</a> / Hyprland, inspired by <a href="https://yazi-rs.github.io/">Yazi</a>'s UX philosophy.
</p>

<p align="center">
  Pure native Qt/QML/C++ &mdash; no Yazi runtime dependency.
</p>

---

## Features

**Three-Column Miller Layout** &mdash; Parent directory, current file list, and live preview side by side.

**Vim-Style Keybindings** &mdash; `hjkl` navigation, chords (`g`, `c`, `,`), visual selection with `Space`, and a 500ms chord timeout system.

**Flash Navigation** &mdash; Press `s` to enter flash mode. Type to filter entries across all three columns, then jump to labeled targets with home-row keys.

**Rich Preview Panel** &mdash; Syntax-highlighted text (KF6), images with background compositing, archives (zip/tar/7z/rar), spreadsheets (.xlsx/.xls), audio with waveform visualization, and video playback.

**Bookmark System** &mdash; `gn` + letter to save, `g` + letter to jump, `gx` + letter to delete.

**XDG Desktop Portal** &mdash; Acts as a system-wide file chooser via D-Bus. Applications that use the portal (Firefox, Electron apps, GTK apps) get Symmetria's picker instead of the default dialog.

**File Operations** &mdash; Yank (`Y`), cut (`X`), paste (`P`), delete (`D`) with confirmation, rename (`R`), create (`A`), and path copying chords (`cc`, `cf`, `cn`, `cd`).

**Tabs** &mdash; `T` to create, `Ctrl+Q` to close, `[`/`]` or `Ctrl+Tab` to switch.

**Zoxide Integration** &mdash; Press `Z` to jump to frequently visited directories.

## Dependencies

### Arch Linux

```bash
paru -S qt6-base qt6-declarative qt6-multimedia syntax-highlighting libarchive qxlsx freexl quickshell-git
```

### Runtime

- [QuickShell](https://quickshell.outfoxxed.me/) &mdash; Qt6/QML shell framework
- [Hyprland](https://hyprland.org/) &mdash; Wayland compositor (for `WlrKeyboardFocus.Exclusive`)
- `wl-clipboard` &mdash; Wayland clipboard (`wl-copy` / `wl-paste`)
- `zoxide` &mdash; directory jumper (optional, for `Z` key)
- `python-dbus-fast` &mdash; portal backend (optional, for system file dialogs)

## Installation

### Standalone Mode (Recommended)

```bash
git clone https://github.com/CaceresCallieri/symmetria-file-manager.git
cd symmetria-file-manager

# Build and install the C++ plugin
./build-plugin.sh

# Install the host binaries, icon, desktop entry, and systemd unit
./install.sh

# Enable the systemd service
cp symmetria-fm.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now symmetria-fm
```

### Integrated Mode (Inside Symmetria Shell)

```bash
./install.sh --symmetria
```

This symlinks the file manager module into an existing Symmetria Shell installation. See the script output for manual integration steps.

### Portal (System File Dialogs)

```bash
cd portal
./install-portal.sh
```

This registers Symmetria as an XDG Desktop Portal file chooser backend.

## Building the C++ Plugin

The plugin provides the `Symmetria.FileManager.Models` QML module with native models for directory listing, archive inspection, syntax highlighting, spreadsheet parsing, and image preview.

```bash
cd plugin
cmake -B build
cmake --build build --parallel $(nproc)
sudo cmake --install build
```

Or use the convenience script:

```bash
./build-plugin.sh              # Build + install
./build-plugin.sh --restart    # Build + install + restart service
```

### Running Tests

```bash
cd plugin
cmake -B build
cmake --build build --parallel $(nproc)
QT_QPA_PLATFORM=offscreen ctest --test-dir build --output-on-failure
```

To skip tests: `cmake -B build -DBUILD_TESTING=OFF`

## Usage

### Opening the File Manager

```bash
symmetria-fm-cli open ~/Downloads
```

> Tip: bind this command to a key in your compositor config (e.g., `Super+E` in Hyprland's `keybinds.conf`).

### Keybindings

#### Navigation

| Key | Action |
|-----|--------|
| `j` / `k` | Move cursor down / up |
| `h` / `l` | Go to parent / enter directory |
| `gg` | Jump to first entry |
| `G` | Jump to last entry |
| `Ctrl+D` / `Ctrl+U` | Half-page down / up |
| `Tab` | Jump between dirs and files sections |
| `~` | Go to home directory |
| `-` / `=` | History back / forward |
| `Z` | Zoxide directory jump |

#### Search & Flash

| Key | Action |
|-----|--------|
| `/` | Start search |
| `n` / `N` | Next / previous match |
| `s` | Enter flash mode (type to filter, press label to jump) |
| `Escape` | Cancel search or flash |

#### File Operations

| Key | Action |
|-----|--------|
| `Y` | Yank (copy) |
| `X` | Cut |
| `P` / `Ctrl+V` | Paste |
| `D` | Delete (with confirmation) |
| `A` | Create new file |
| `R` | Rename |
| `Shift+R` | Rename (include extension) |
| `Space` | Toggle selection |
| `Ctrl+Enter` | Context menu |

#### Path Copying (`c` chord)

| Key | Action |
|-----|--------|
| `cc` | Copy full path |
| `cf` | Copy filename |
| `cn` | Copy filename without extension |
| `cd` | Copy directory path |

#### Bookmarks (`g` chord)

| Key | Action |
|-----|--------|
| `g` + letter | Jump to bookmark |
| `gn` + letter | Create bookmark |
| `gx` + letter | Delete bookmark |

#### Sorting (`,` chord)

| Key | Action |
|-----|--------|
| `,a` / `,A` | Alphabetical (asc / desc) |
| `,m` / `,M` | Modified time (asc / desc) |
| `,s` / `,S` | Size (asc / desc) |
| `,e` / `,E` | Extension (asc / desc) |
| `,n` / `,N` | Natural order (asc / desc) |

#### Tabs & Window

| Key | Action |
|-----|--------|
| `T` | New tab |
| `[` / `]` | Previous / next tab |
| `Ctrl+Tab` | Next tab |
| `Ctrl+Q` | Close tab (or window if last) |
| `.` | Toggle hidden files |

## Architecture

```
symmetria-file-manager/
├── plugin/                    # C++ Qt6 QML plugin (CMake)
│   ├── src/.../Models/        #   FileSystemModel, ArchivePreviewModel,
│   │                          #   SyntaxHighlightHelper, SpreadsheetPreviewModel,
│   │                          #   PreviewImageHelper, AudioWaveformModel
│   └── tests/                 #   QTest suite (38 tests)
├── modules/filemanager/       # QML UI components (30 files)
│   ├── handlers/              #   Keyboard handler JS modules
│   ├── MillerColumns.qml      #   Three-column layout
│   ├── FileList.qml           #   Main file list with vim keybindings
│   └── PreviewPanel.qml       #   Preview dispatcher
├── services/                  # QML singletons
│   ├── WindowState.qml        #   Per-window state (nav, search, modals)
│   ├── FileManagerService.qml #   Shared state (clipboard, picker)
│   └── WindowFactory.qml      #   Window lifecycle + IPC
├── portal/                    # XDG Desktop Portal backend (Python)
└── components/                # Shared QML components
```

The C++ plugin runs all heavy I/O (directory scans, file reads, image decoding) off the GUI thread via `QtConcurrent::run()`. Generation counters discard stale results when the user navigates faster than I/O completes.
