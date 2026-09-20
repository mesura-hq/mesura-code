# Future Path: Rust Migration

This document outlines the long-term vision for migrating the Symmetria File Manager
file manager from QML/QuickShell to a native Rust implementation. The current
QML codebase serves as a working prototype and living specification — every
behaviour, edge case, and architectural decision documented here has been
validated through real usage.

Target timeframe: ~3-6 months from March 2026, potentially accelerated by
improvements in LLM-assisted Rust development (Opus 5 or equivalent).

## Why Rust

- **Single binary**: No Python, no QML runtime, no QuickShell, no FIFO, no IPC
  bridge. One process handles D-Bus portal, file scanning, and UI rendering.
- **Performance**: Instant startup, ~10MB memory, GPU-accelerated rendering.
- **Portability**: Distributable as a standalone binary to any Wayland system.
- **Ecosystem**: `walkdir`, `ignore`, `zbus`, `notify` are battle-tested crates
  that map directly to our requirements.

## Migration Strategy: Incremental, Not Big-Bang

The QML codebase is a working product. The migration should be progressive,
with each phase delivering standalone value.

### Phase 1: Rust Portal Backend (Replace Python Bridge)

Replace `symmetria_portal.py` with a Rust binary using `zbus`.

**Current architecture (3 processes, 2 IPC hops):**
```
App → xdg-desktop-portal → Python (dbus-fast) → qs ipc → QuickShell
                                               ← FIFO ←
```

**Target architecture (2 processes, 1 IPC hop):**
```
App → xdg-desktop-portal → Rust daemon (zbus) → qs ipc → QuickShell
                                               ← FIFO ←
```

Eliminates Python dependency, reduces latency, provides a Rust foundation.

Key crates: `zbus` (D-Bus), `tokio` (async runtime), `uuid` (FIFO naming).

### Phase 2: Rust File Backend (Replace C++ FileSystemModel)

Rewrite the file scanning, sorting, and watching layer in Rust. Expose to QML
via `cxx-qt` or a C FFI that replaces the QuickShell C++ plugin.

**What to rewrite:**
- `FileSystemModel` → Rust struct with `walkdir` + `ignore` for scanning
- `FileSystemEntry` → Rust struct exposed as QObject properties
- `QFileSystemWatcher` → `notify` crate for file system events
- Sorting (by name, size, date, extension) → Rust `sort_by` with `natord`

**What stays in QML:** All UI components (FileList, MillerColumns, StatusBar,
PreviewPanel, etc.). They consume the Rust model via the same QAbstractListModel
interface.

This phase is where the biggest performance gain happens — large directories
(10k+ files) will scan in single-digit milliseconds.

### Phase 3: Rust UI Framework (Replace QML)

Replace the QML rendering layer with a Rust-native UI framework.

**Framework candidates (evaluate at migration time):**
- `iced` — Elm architecture, pure Rust, Wayland-native via `smithay-client-toolkit`
- `gpui` — Zed's framework, GPU-accelerated, high performance
- `slint` — Declarative UI (similar feel to QML), compiles to native
- `xilem` — Linebender project, data-driven, reactive
- Whatever emerges as the Rust GUI standard by then

**What to translate:**
- `FileList.qml` → List widget with vim-style key handling
- `MillerColumns.qml` → 3-panel layout with proportional sizing
- `StatusBar.qml` → Context-aware bottom bar (normal/search/picker modes)
- `PreviewPanel.qml` → Typed preview (image, text, video, archive, etc.)
- `PathBar.qml` → Breadcrumb navigation with clickable segments
- `WhichKeyPopup.qml` → Chord hint overlay
- `DeleteConfirmPopup.qml` → Y/N modal confirmation
- `CreateFilePopup.qml` → Inline text input with validation
- Theme system → Symmetria M3 palette integration (or standalone theming)

### Phase 4: Unified Binary

Merge the portal backend (Phase 1) and UI (Phase 3) into a single binary.

**Final architecture (1 process, 0 IPC hops):**
```
App → xdg-desktop-portal → symmetria-fm (Rust)
                                │
                                ├── zbus: D-Bus portal FileChooser
                                ├── walkdir + ignore: async file scanning
                                ├── notify: file system watching
                                ├── iced/gpui: GPU-accelerated UI
                                │     ├── Miller columns
                                │     ├── Vim-style modal keyboard system
                                │     └── File preview engine
                                └── Wayland: xdg-shell window
```

No Python. No QML. No QuickShell. No FIFO. No IPC.

## What the QML Codebase Provides as Reference

The current implementation is a **living specification** that captures hundreds
of solved micro-decisions:

### Keyboard Model (FileList.qml)
- Vim-style modal system: Normal → chord prefix → chord resolution
- Key suppression matrix for picker mode (D, Y, X, P, A blocked; Ctrl+D allowed)
- Escape priority: chord cancel → search cancel → picker cancel → close
- Focus management: restore after search, delete popup, create popup

### Navigation (FileManagerService.qml)
- History stack with truncation on new navigation
- Per-directory cursor position cache (restored on back-navigation)
- Search with match cycling (next/previous via n/N)

### Portal Integration (WindowFactory.qml, symmetria_portal.py)
- FIFO-based bidirectional IPC with 4-layer path validation
- Process + timeout pattern for reliable FIFO writes
- Picker mode state machine: start → navigate → complete/cancel → reset
- Signal-based communication with captured-before-reset invariant
- D-Bus option parsing: filters (a(sa(us))), current_folder (ay), choices

### File Operations
- Yank/cut clipboard with visual indicators
- Delete confirmation with Y/N keyboard handling
- Create file/folder with inline validation and name conflict detection
- Paste with cursor tracking (focus newly pasted file)

### UI Components
- Miller columns with proportional 2:5:3 layout
- Preview debouncing (150ms) to prevent flicker during fast scrolling
- 7 preview types: image, video, text (syntax highlighted), archive,
  spreadsheet, directory listing, fallback metadata
- Matte pill aesthetic with M3 colour system integration
- Animated transitions (colour, opacity, position)

## Crate Dependencies (Estimated)

```toml
[dependencies]
# D-Bus portal
zbus = "5"
# Async runtime
tokio = { version = "1", features = ["full"] }
# File system
walkdir = "2"
ignore = "0.4"          # .gitignore-aware traversal
notify = "7"            # File system watching
# UI (choose one)
iced = "0.13"           # or gpui, slint, xilem
# Utilities
uuid = "1"
natord = "1.0"          # Natural sort ordering
mime_guess = "2"        # MIME type detection
chrono = "0.4"          # Date formatting
bytesize = "1"          # Human-readable file sizes
syntect = "5"           # Syntax highlighting for text preview
image = "0.25"          # Image decoding for preview
```

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-16 | Pure native, no Yazi backend | DDS is push-only, bridge adds complexity, native is instant |
| 2026-03-20 | Python + FIFO portal bridge | Fastest path to working portal; Rust rewrite deferred to Phase 1 |
| 2026-03-20 | Headless systemd service | Decouples FM from Symmetria lifecycle; survives shell restarts |
| 2026-03-20 | Incremental Rust migration | Working QML = living spec; translate, don't redesign |
