# Symmetria File Manager — Feasibility Research

## Executive Summary

**Verdict: Highly feasible.** Building a QuickShell/QML frontend for Yazi is not only
possible but well-supported by the existing infrastructure on both sides:

- **Yazi** exposes a robust IPC system (DDS) over Unix sockets with pub/sub messaging,
  plus a CLI companion (`ya`) for emitting commands and subscribing to events.
- **Symmetria** already has a file dialog component with a C++ `FileSystemModel`, a
  mature drawer/module system, and a proven pattern for bridging external processes
  (see `AgentService`).

The recommended approach is a **hybrid architecture**: use Yazi as a headless backend
running in a hidden PTY, communicating bidirectionally via DDS, while the QML frontend
handles all rendering, keyboard input, and mouse interactions.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  Symmetria Shell (QuickShell / QML)                     │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ FileManager   │  │ KeyHandler   │  │ Preview      │  │
│  │ Module (QML)  │  │ (QML/Keys)   │  │ Panel (QML)  │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
│         │                 │                  │          │
│         └────────┬────────┘──────────────────┘          │
│                  │                                      │
│         ┌────────▼────────┐                             │
│         │  YaziService     │  (QML Singleton)           │
│         │  - state cache   │                            │
│         │  - event router  │                            │
│         └────────┬────────┘                             │
│                  │                                      │
│         ┌────────▼────────┐                             │
│         │  Bridge Process  │  (Python/Rust)             │
│         │  - DDS client    │                            │
│         │  - JSON stdio    │                            │
│         └────────┬────────┘                             │
└──────────────────│──────────────────────────────────────┘
                   │ Unix Socket: /tmp/.yazi_dds-{uid}.sock
         ┌─────────▼─────────┐
         │  Yazi Instance     │
         │  (hidden PTY)      │
         │  --local-events    │
         │  --client-id gui   │
         └───────────────────┘
```

---

## Yazi IPC Capabilities

### DDS (Data Distribution Service)

Yazi's built-in pub/sub system over Unix domain sockets.

- **Socket**: `/tmp/.yazi_dds-{uid}.sock`
- **Protocol**: Line-delimited text — `kind,receiver,sender,body`
- **Events emitted**: `cd`, `hover`, `rename`, `bulk`, `@yank`, `move`, `trash`,
  `delete`, `tab`, `load`, `download`, `mount`, `custom`
- **Persistent events**: `@`-prefixed kinds survive restarts
- **Stdout events**: `yazi --local-events=cd,hover,load --remote-events=...`
  outputs events to stdout (TUI renders to stderr)

### CLI Companion (`ya`)

```bash
ya emit cd /tmp                    # Navigate to directory
ya emit-to $ID reveal /tmp/foo     # Reveal specific file
ya pub custom-event --json '{}'    # Publish custom event
ya sub cd,hover,load               # Subscribe (blocking stdout stream)
```

### Key Limitation: No Query Mechanism

DDS is push-only. You cannot ask "what files are in /home?" — you only get notified
when things change. Two solutions:

1. **Lua bridge plugin**: A Yazi plugin that listens for custom DDS events and
   responds by serializing state via `ps.pub_to`.
2. **Hybrid model**: Use Symmetria's existing `FileSystemModel` (C++) for directory
   listings, and Yazi only for operations and state synchronization.

**Recommendation**: Option 2 (hybrid) for the MVP — it's faster and avoids the
query gap entirely.

---

## Symmetria Assets Available

### Existing File Dialog (`components/filedialog/`)

| File              | Lines | What it does                           |
|-------------------|-------|----------------------------------------|
| FileDialog.qml    | 103   | FloatingWindow wrapper with lazy-load  |
| FolderContents.qml| 230   | GridView with thumbnails + animations  |
| Sidebar.qml       | 150   | Quick-access folder shortcuts          |
| HeaderBar.qml     | 150   | Breadcrumb path navigation             |
| CurrentItem.qml   | 100   | Selected file preview info             |
| DialogButtons.qml | 80    | Accept/Cancel actions                  |

### C++ FileSystemModel (`plugin/src/Symmetria/Models/`)

- `QAbstractListModel` subclass with async scanning (`QtConcurrent`)
- Properties: `path`, `recursive`, `watchChanges`, `showHidden`, `sortReverse`,
  `filter`, `nameFilters`
- `FileSystemEntry`: `path`, `name`, `baseName`, `suffix`, `size`, `isDir`,
  `isImage`, `mimeType`
- Real-time `QFileSystemWatcher` integration
- MIME type detection with caching

### Proven IPC Pattern (AgentService)

The `AgentService` singleton demonstrates exactly the pattern we need:
- Spawn a bridge process (`Process` + `SplitParser`)
- Read JSON lines from stdout
- Maintain reactive state arrays in QML
- Expose via `IpcHandler` for external control

### Infrastructure

- Drawer system for slide-out panels
- Material Design 3 theming (`Colours` singleton)
- `StyledRect`, `StyledText`, `StateLayer`, `MaterialIcon` components
- Focus management (`FocusManager`)
- Keyboard chord system (`modules/keychords/`)
- `IpcHandler` for `qs ipc call` control

---

## Proposed MVP Architecture

### Phase 1: Core File Browser (Standalone)

Use **only** Symmetria's `FileSystemModel` — no Yazi dependency yet.

**New module**: `modules/filemanager/`

```
modules/filemanager/
├── Wrapper.qml          # Drawer wrapper (visibility, animation)
├── Content.qml          # Main layout (sidebar + file list + preview)
├── FileList.qml         # ListView with Vim-style navigation
├── PreviewPanel.qml     # File preview (text, images, code)
├── PathBar.qml          # Breadcrumb + location input
├── Sidebar.qml          # Bookmarks, devices, tree view
└── StatusBar.qml        # Selection count, file info, mode indicator
```

**Key features**:
- ListView (not GridView) — matches Yazi's list-centric UX
- `j`/`k` navigation, `h` parent, `l` enter/open
- Visual mode (`v` to toggle, `V` for line select)
- Search with `/` (fuzzy filter)
- Status bar showing current path, selection count, file permissions

### Phase 2: Yazi Backend Integration

Add `YaziService.qml` singleton + bridge process.

**Bridge responsibilities**:
1. Start Yazi in a hidden PTY with `--local-events=cd,hover,load,rename`
   and `--client-id=symmetria-gui`
2. Parse stdout event stream → JSON lines to QML
3. Forward commands from QML → `ya emit-to symmetria-gui <command>`
4. Sync state: selections, yanked files, tabs, current directory

**What Yazi handles** (that the C++ model doesn't):
- File operations (copy, move, delete, rename, trash) with progress
- Bulk rename
- Archive extraction/compression
- Remote filesystem (SSH/SFTP)
- Plugin ecosystem (custom previewers, fetchers)
- Persistent yank clipboard across instances
- Task queue with parallel I/O

### Phase 3: Full Yazi Feature Parity

- Tab management (Yazi supports multiple tabs)
- Plugin previews forwarded to QML
- Task manager panel
- Custom Lua plugin for full state serialization
- Configurable keybindings loaded from `keymap.toml`

---

## Keyboard Architecture

### Approach: Dual-Layer Keybinding

```
┌────────────────────────────────────┐
│  QML FocusScope                    │
│  ┌──────────────────────────────┐  │
│  │ Layer 1: Navigation (QML)    │  │
│  │ j/k/h/l, gg, G, /, :        │  │
│  │ Visual mode: v, V            │  │
│  │ Marks: m, ', `               │  │
│  └──────────┬───────────────────┘  │
│             │ Unhandled keys       │
│  ┌──────────▼───────────────────┐  │
│  │ Layer 2: Operations (→ Yazi) │  │
│  │ dd (delete), yy (yank),      │  │
│  │ pp (paste), rn (rename)      │  │
│  │ Space (select), Tab (tab)    │  │
│  └──────────────────────────────┘  │
└────────────────────────────────────┘
```

- Navigation keys handled purely in QML (instant, no IPC latency)
- Operation keys forwarded to Yazi via `ya emit`
- Yazi's keymap.toml parsed at startup to build the key dispatch table

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Yazi DDS API instability | Medium | Pin to a Yazi version; abstract behind bridge |
| No query mechanism in DDS | High | Use hybrid model (C++ FileSystemModel + Yazi ops) |
| Keyboard focus conflicts with Hyprland | Medium | Use `WlrKeyboardFocus.Exclusive` when active |
| Performance with large directories | Low | C++ model already async; virtualized ListView |
| Yazi headless mode missing | Medium | Run in hidden PTY (proven pattern) |
| Plugin preview forwarding | High | Defer to Phase 3; use native QML previews initially |

---

## Comparison: Build from Scratch vs. Yazi Backend

| Aspect | Pure QML/C++ | Yazi Backend |
|--------|-------------|-------------|
| File listing | FileSystemModel (have it) | Overkill for listing |
| File operations | Must implement | Battle-tested |
| Bulk rename | Must implement | Built-in |
| Archive support | Must implement | Plugin ecosystem |
| Remote FS (SSH) | Must implement | yazi-sftp crate |
| Task queue | Must implement | Built-in scheduler |
| Plugin ecosystem | None | 100+ community plugins |
| Latency | Zero (native) | ~1-5ms (IPC) |
| Complexity | Lower initially | Lower long-term |

**Verdict**: The hybrid approach gives us the best of both worlds — native-speed
browsing with Yazi's powerful operation engine.

---

## Architecture Decision: Pure Native (No Yazi Runtime)

> **Decision date**: 2025-03-16
> **Status**: Accepted
> **See**: [PRD.md](./PRD.md) for full product requirements

### Context

The hybrid architecture above (C++ FileSystemModel for browsing + Yazi for operations)
was the initial recommendation. After further analysis, the project will instead use a
**pure native Qt/QML/C++ approach with no Yazi runtime dependency**.

### Rationale

1. **Query gap is the dominant problem**: Yazi's DDS is push-only. The C++ FileSystemModel
   already provides instant directory listings with async scanning — the hybrid approach
   would only use Yazi for operations, not browsing.
2. **Operations are simpler than they appear**: `gio trash`, `cp`, `mv`, `rm`, and
   `xdg-open` cover 95% of MVP file operations. A QML `Process` component calling these
   tools is far simpler than a DDS bridge.
3. **Startup cost**: Spawning Yazi in a hidden PTY adds ~200ms cold start. A native
   FloatingWindow opens instantly.
4. **Maintenance surface**: Pinning to Yazi's DDS protocol version is fragile. Yazi's
   IPC is designed for Yazi-to-Yazi communication, not as a stable external API.
5. **Complexity budget**: A Python/Rust bridge process is a significant moving part that
   could break independently of either Yazi or Symmetria updates.

### What We Keep from Yazi

The file manager is **inspired by** Yazi's UX philosophy:

- Vim-style modal keybindings (Normal / Visual / Command modes)
- Yank/paste model (`yy` → copy paths, `dd` → cut, `pp` → execute)
- List-centric layout (not grid)
- Keyboard-first with mouse as convenience
- Minimal chrome, dense information display

### What We Don't Use

- Yazi runtime / binary
- DDS IPC protocol
- Bridge process (Python/Rust)
- Yazi's plugin ecosystem (initially)
- `ya` CLI companion

### Future Yazi Integration (Phase 3)

If advanced features prove too complex to implement natively (bulk rename with regex,
archive browsing, SSH/SFTP), a Yazi bridge can be added as an **optional backend** in
Phase 3. The architecture accommodates this: `FileManagerService` abstracts operations
behind methods that could delegate to either native tools or a Yazi bridge.

---

## Next Steps

> Development is guided by [PRD.md](./PRD.md). The phases below are a summary.

1. **Phase 1 (MVP)**: Browse + navigate + open + basic operations (yy/dd/pp/r/D)
2. **Phase 2**: Preview panel, multi-tab, bulk rename, archive browsing
3. **Phase 3**: Remote FS (SSH), custom actions, plugin system, optional Yazi backend
