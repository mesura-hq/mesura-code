# 03 — File operations, daemon lifecycle, IPC, picker mode, XDG portal

Scope of this document: file operations, the daemon and window lifecycle, the IPC
wire protocol, picker mode, the XDG portal backend, and the app-id contract.
Previews and keybinding architecture are covered by other documents.

All paths are relative to the repository root
`/home/jc/projects/symmetria-file-manager` (read here from the worktree
`/home/jc/.t3/worktrees/symmetria-file-manager/t3code-a2a6aa9b`).

---

## 0. The execution primitive: `ShellRunner`

Every file operation in this application is an external process. There is no
in-process filesystem-mutation code. The single primitive is `ShellRunner`, a
C++ `QProcess` wrapper registered into `Symmetria.FileManager.Models`.

- Header: `plugin/src/Symmetria/FileManager/Models/shellrunner.hpp:39`
- API: `command` is a `QStringList` (argv, **no shell**), plus `workingDirectory`,
  `environment` (merged over the inherited environment), `running`, `stdoutText`,
  `stderrText`, `exitCode`.
- Signals: `started()`, `exited(int exitCode, int exitStatus)`,
  `errorOccurred(QString)`, `stdoutLine(QString)`, `stderrLine(QString)`
  (`shellrunner.hpp:83-96`).
- `ExitStatus` enum mirrors `QProcess::ExitStatus`: `NormalExit = 0`,
  `CrashExit = 1` (`shellrunner.hpp:55-59`).
- `start()` is a no-op while already running, guarded by both `m_running` and
  `m_starting` (`shellrunner.hpp:122-126`). The `m_starting` window is
  load-bearing: `host/standalone/main.qml:34-41` documents a hang caused by a
  caller that gated only on `running`.
- `errorOccurred` with `FailedToStart` emits **no following `exited`**. Every
  caller that must advance a state machine handles both signals
  (`host/standalone/main.qml:228-237`, `:273-279`, `:318-327`).

**Port to Electron.** `ShellRunner` maps to `child_process.execFile` /
`spawn` with an argv array (never `shell: true`). Most operations should instead
become direct Node calls (`fs.promises.*`, `shell.trashItem`, `shell.openPath`),
which removes the argv-quoting surface entirely. Risk: the current code depends on
process **exit codes** as its only error channel; Node exceptions carry richer
information, so the error-reporting UI has to be rewritten, not ported.

---

## 1. File operation inventory

### 1.1 Summary table

| Operation | Entry point | Implementing file | External command | Refresh mechanism |
|---|---|---|---|---|
| Yank (copy-mark) | `y` | `KeyRegistry.js:96-104` | none (in-memory) | indicator strip binding |
| Cut (move-mark) | `x` | `KeyRegistry.js:106-114` | none (in-memory) | indicator strip binding |
| Paste | `p`, `Ctrl+V` | `KeyRegistry.js:116-130` | `cp -r -- <src…> <dst>` or `mv -- <src…> <dst>` | `QFileSystemWatcher` → `onEntriesChanged` |
| Trash | `d` → confirm | `DeleteConfirmPopup.qml:247-259` | `gio trash -- <path…>` | watcher |
| Rename | `r`, `Shift+R` | `RenamePopup.qml:166-221` | `test -e <new>` then `mv -- <old> <new>` | watcher + `renameCompleted` focus |
| Create file | `a` (no trailing `/`) | `CreateFilePopup.qml:174-203` | `touch -- <path>`, optionally preceded by `mkdir -p -- <parent>` | watcher + `createCompleted` focus |
| Create directory | `a` (trailing `/`) | `CreateFilePopup.qml:184-187` | `mkdir -p -- <path>` | watcher + `createCompleted` focus |
| Open (default handler) | `Enter` | `FileOpener.qml:18-38`, `:74-82` | `sh -c <handler probe>` then `xdg-open <path>` | none |
| Open (terminal handler) | `Enter` | `FileOpener.qml:59-65` | `xdg-terminal-exec sh -c '<Exec> "$@"' sh <path>` | none |
| Execute script | `Enter` on shellscript MIME | `FileOpener.qml:40-43` | `xdg-terminal-exec <path>` | none |
| Open with… | `Ctrl+Enter` → `o` | `ContextMenuPopup.qml:68-77`, `:221` | `gio mime <mimetype>` then `gio launch <desktopId> <path>` | none |
| Extract archive | `Ctrl+Enter` → `e` | `ContextMenuPopup.qml:136-149`, `:418-442` | `mkdir -p -- <dest>` then `bsdtar -xvf <archive> -C <dest>` | watcher |
| Copy path / name to clipboard | `cc`, `cf`, `cn`, `cd` | `ChordHandler.js:91-165` | `systemd-run … wl-copy --foreground -- <text>` | none |
| Copy image bytes to clipboard | `ci` | `ChordHandler.js:103-124` | `systemd-run … sh -c 'exec wl-copy --foreground --type "$1" < "$2"' sh <mime> <path>` | none |
| Record directory visit | automatic on navigate | `FileManager.qml:179-208` | `zoxide add -- <path>` | none |
| Query directory history | `z` | `ZoxidePopup.qml:240-255` | `zoxide query --list --score [kw…]` | none |
| Persist bookmarks | `gn` / `gx` | `BookmarkService.qml:126-149` | `sh -c 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1"' -- <path> <json>` | `FileWatcher` |
| Append log | every `Logger` call | `Logger.qml:109-128` | `sh -c 'mkdir -p … && printf … >> "$1"' -- <logfile> <payload>` | none |
| Write picker result | picker confirm | `host/standalone/main.qml:204-238` | `python3 -c "import sys; open(sys.argv[2],'w').write(sys.argv[1])" <payload> <fifo>` | n/a |

There is **no properties dialog**, **no undo**, **no move-to-trash-restore**, and
**no copy-progress UI** for `cp`/`mv`. The only progress bar in the whole
application is the archive-extraction bar
(`ArchiveExtractionView.qml:50-66`).

### 1.2 Yank, cut and paste

State lives in the `FileManagerService` singleton, shared by every window and tab
(`qml/Symmetria/FileManager/UI/services/FileManagerService.qml:9-35`):

- `clipboardPaths` — array of absolute paths, `[]` when empty.
- `clipboardMode` — `""`, `"yank"` or `"cut"`.
- `_clipboardSet` — a materialised `{path: true}` map rebuilt in
  `onClipboardPathsChanged` so each row delegate does an O(1) lookup instead of
  `indexOf` (`FileManagerService.qml:12-20`).

`yank(paths)`, `cut(paths)` and `clearClipboard()` are the only mutators
(`FileManagerService.qml:22-35`).

Key bindings are registry rows:
- `clip.yank` → `y` → `_yankAction` (`KeyRegistry.js:210-212`, `:96-104`).
- `clip.cut` → `x` → `_cutAction` (`KeyRegistry.js:213-215`, `:106-114`).
- `clip.paste` → `p` and `clip.pasteCtrl` → `Ctrl+V` → `_pasteAction`
  (`KeyRegistry.js:216-221`).

`_yankAction` / `_cutAction` prefer the marked selection over the cursor entry,
and clear the selection after marking (`KeyRegistry.js:98-103`).

`_pasteAction` (`KeyRegistry.js:116-130`):
1. Returns early when the clipboard is empty or the runner is already running.
2. Resolves the destination via the view adapter `ctx.root.fileOpsTargetDir()`.
   Miller returns `windowState.currentPath` (`FileList.qml:124-126`); the tree
   returns the hovered directory, or the hovered file's parent, or the tree root
   (`FileTreeView.qml:266-271`).
3. Sets an optimistic focus name through `ctx.root.setPendingPasteFocus(basename)`
   (`FileList.qml:129-131`). The tree deliberately no-ops that call, because a
   pasted item can land at any depth (`FileTreeView.qml:273-276`).
4. Builds argv: `["cp","-r","--", …paths, destDir]` for yank,
   `["mv","--", …paths, destDir]` for cut.
5. Starts `PasteRunner`.

`PasteRunner` (`qml/Symmetria/FileManager/UI/components/PasteRunner.qml:10-22`)
clears the global clipboard on exit code 0, and emits `pasteFailed()` otherwise so
the Miller view can drop its optimistic focus name (`FileList.qml:418-421`).

**Conflict handling: none.** `cp -r` and `mv` overwrite silently. There is no
existence probe, no "replace / skip / rename" prompt, and no merge dialog. This
is the single largest behavioural gap versus a conventional file manager.

**Progress: none.** A large copy blocks nothing in the UI, but reports nothing
either. The user only learns the result when the watcher repopulates the list.

**Undo: none.** A cut-paste is a `mv`; the source is gone.

**Port to Electron.** Use `fs.promises.cp(src, dst, {recursive: true})` and
`fs.promises.rename` with a `fs.promises.cp` + `rm` fallback for cross-device
moves (`rename` fails with `EXDEV` across filesystems — `mv(1)` hides this
today, Node does not). Conflict prompts and per-file progress become
straightforward once the copy is in-process; both are new features, not ports.

### 1.3 Trash

- Binding: `op.delete` → `d` → `_deleteAction` (`KeyRegistry.js:195-197`, `:86-94`).
- `_deleteAction` prefers the marked selection, clears it, and calls
  `windowState.requestDelete(paths)`, which stores `deleteConfirmPaths` and sets
  `activeModal = modalDelete` (`WindowState.qml:328-331`).
- `DeleteConfirmPopup.qml` is a `Loader` gated on that enum
  (`DeleteConfirmPopup.qml:13-17`). It snapshots `targetPaths` in
  `Component.onCompleted` because the Loader destroys and recreates the component
  on every activation (`DeleteConfirmPopup.qml:22-28`).
- Confirmation keys: `Y` always confirms; `Return`/`Enter` is focus-aware (confirms
  on Yes, cancels on No); `N` and `Escape` cancel; `Tab`/`Left`/`Right`/`H`/`L`
  move focus between the two buttons; every other key is swallowed
  (`DeleteConfirmPopup.qml:72-109`).
- Command: `["gio","trash","--"].concat(targetPaths)`
  (`DeleteConfirmPopup.qml:249`) — one process for the whole batch.
- Error handling: the popup closes on **both** success and failure; the failure
  path only writes a `Logger.warn` (`DeleteConfirmPopup.qml:250-258`). The user
  gets no visible error.
- Refresh: `QFileSystemWatcher` inside `FileSystemModel` fires, `onEntriesChanged`
  clamps the cursor when it now points past the end (`FileList.qml:328-330`).

**Port to Electron.** `shell.trashItem(path)` is the direct equivalent and
respects the FreeDesktop trash spec on Linux. It takes one path per call, so the
batch becomes `Promise.allSettled(paths.map(shell.trashItem))` — which finally
gives per-item error reporting that `gio trash --` cannot provide.

### 1.4 Rename

- Bindings: `op.rename` → `r` (extension excluded from the initial selection) and
  `miller.renameExt` → `Shift+R` (whole name selected)
  (`KeyRegistry.js:198-200`, `:338-340`).
- `windowState.requestRename(path, includeExtension)` sets the payload and the
  modal enum (`WindowState.qml:338-342`).
- `RenamePopup.qml` positions its card below the cursor row, using
  `targetItemY` / `targetColumnX` / `targetColumnWidth` fed from `FileManager.qml:150-156`.
- `Tab` inside the input toggles between name-only and full-name selection
  (`RenamePopup.qml:141-146`).
- Validation before any process runs (`RenamePopup.qml:167-176`): rejects empty,
  `.`, `..`, and any name containing `/`; closes silently when the name is
  unchanged; refuses to start while a process is in flight.
- Conflict check: `["test","-e",newPath]` (`RenamePopup.qml:185`). Exit code 0
  means the target exists, and the popup shows the inline error
  `'<name>' already exists` (`RenamePopup.qml:196-202`). **This is a TOCTOU
  check** — nothing prevents the path appearing between the probe and the `mv`.
- Rename: `["mv","--",originalPath,pendingNewPath]` (`RenamePopup.qml:206`).
- On success: `windowState.renameCompleted(newName)` then `closeModal()`
  (`RenamePopup.qml:213-216`). `FileList` stores `_pendingFocusName` from that
  signal (`FileList.qml:191-193`) and moves the cursor to the renamed entry when
  the watcher-driven `onEntriesChanged` arrives (`FileList.qml:332-343`).
- On failure: inline error `Rename failed (exit code N)`; the popup stays open.

**Port to Electron.** `fs.promises.rename`. Replace the `test -e` probe with
`fs.promises.access` — or better, accept the race and map `EEXIST` / `ENOTEMPTY`
from the rename itself, which removes the TOCTOU window instead of relocating it.

### 1.5 Create file and directory

One modal handles both. The trailing `/` decides
(`CreateFilePopup.qml:162`).

- Binding: `op.create` → `a` → `windowState.requestCreate(ctx.root.fileOpsTargetDir())`
  (`KeyRegistry.js:201-203`). The target directory is passed explicitly because
  Miller and the tree disagree on what "here" means (`WindowState.qml:315-318`).
- Input validation (`CreateFilePopup.qml:152-158`): rejects empty input and
  slash-only input such as `/` or `///`; refuses to start while any of the three
  runners is busy.
- Existence probe: `["test","-e", basePath + "/" + topLevelName]`
  (`CreateFilePopup.qml:170`). Note the deliberate absence of `--`: `test(1)` does
  not support it, and `basePath` is always absolute (`CreateFilePopup.qml:168-169`).
- On conflict the popup shows `'<name>' already exists` **and** moves the
  background cursor onto the colliding entry via `createCompleted`
  (`CreateFilePopup.qml:208-215`).
- Directory branch: `["mkdir","-p","--",fullPath]` (`CreateFilePopup.qml:186`).
  Nested input such as `a/b/c/` therefore works in one call.
- File branch: when the input is nested, `["mkdir","-p","--",parentDir]` runs
  first and `["touch","--",fullPath]` runs from its `onExited`
  (`CreateFilePopup.qml:194-196`, `:228-235`). Two runners avoid an `sh -c`.
  Top-level input goes straight to `touch` (`CreateFilePopup.qml:199`).
- Ordering rule stated in the source: `createCompleted(topLevelName)` is emitted
  **before** the process starts, because `mkdir -p` triggers the watcher
  immediately and the pending focus name must already be set
  (`CreateFilePopup.qml:179-182`).

**Port to Electron.** `fs.promises.mkdir(path, {recursive: true})` and
`fs.promises.writeFile(path, "", {flag: "wx"})`. The `wx` flag makes the
existence check atomic, replacing the `test -e` probe.

### 1.6 Open, open-with and execute

`FileOpener.qml` is a headless `Item` instantiated once per `FileList`
(`FileList.qml:414-416`) and once per `FileManager` for the tree
(`FileManager.qml:135-137`).

`open(path, mimeType)` (`FileOpener.qml:18-38`) is a two-step probe:

1. Step 1 runs `sh -c` with an inline script whose contract is documented at
   `FileOpener.qml:21-25`:
   - `xdg-mime query default "$1"` finds the handler `.desktop` id;
   - when empty and the MIME starts with `text/`, it retries with `text/plain`;
   - it then searches `$HOME/.local/share/applications`,
     `/usr/share/applications` and `/usr/local/share/applications`;
   - when the found entry has `Terminal=true`, it prints the `Exec=` line with the
     `%f %F %u %U %n %N %d %D %i %c %k` field codes stripped;
   - otherwise it prints nothing and exits 0.
   The MIME type is passed as the positional `$1`, not interpolated.
2. Step 2a — non-empty stdout means a terminal handler:
   `["xdg-terminal-exec","sh","-c", execLine + ' "$@"', "sh", path]`
   (`FileOpener.qml:64`). The path travels as `$1` so quoting inside the `Exec`
   line survives.
   Step 2b — empty stdout: `["xdg-open", path]` (`FileOpener.qml:68`).

`execute(path)` runs `["xdg-terminal-exec", path]` directly
(`FileOpener.qml:40-43`). `FileList._activateCurrentItem` routes to it when the
MIME is `application/x-shellscript` or `text/x-shellscript`
(`FileList.qml:155-156`).

Path resolution before opening goes through
`PreviewImageHelper.resolvePathForOpen(path)` (`FileOpener.qml:19`) — the C++
helper that resolves symlinks and cached decodes.

All four runners only log a warning on non-zero exit; no user-visible error.

**Open with…** lives in `ContextMenuPopup.qml`, reached with `Ctrl+Enter` on a
non-directory (`KeyRegistry.js:297-302`):
- `gio mime <mimeType>` lists registered associations (`ContextMenuPopup.qml:72`).
- `_parseMimeOutput` keeps only lines ending in `.desktop` that contain no space,
  which rejects the `Registered associations:` headers
  (`ContextMenuPopup.qml:89-109`).
- Each entry is decorated with `AppIconProvider.iconForDesktopId(id)` once, at
  parse time, not in the delegate binding (`ContextMenuPopup.qml:98-104`).
- Launch: `["gio","launch", desktopId, targetPath]`
  (`ContextMenuPopup.qml:221` for the key path, `:356` for the mouse path).
- The modal closes immediately after `start()`, so a launch failure only reaches
  the log (`ContextMenuPopup.qml:395-401`).

**Port to Electron.** `shell.openPath(path)` covers the `xdg-open` branch and
returns an error string instead of an exit code. The terminal-handler probe has
**no Electron equivalent** — `shell.openPath` delegates to `xdg-open`, which
hands a `Terminal=true` entry to the desktop's own terminal policy, and that is
exactly what the current probe exists to bypass. Keep the probe as a
`child_process` call, or parse `.desktop` files in Node (`ini` parsing plus the
XDG data-dir search order). "Open with" requires the same `.desktop` enumeration;
`gio mime` / `gio launch` stay as spawned commands unless the whole XDG
association layer is reimplemented.

### 1.7 Archive extraction

Reached from the context menu with `e` on an archive MIME
(`ContextMenuPopup.qml:81-85`, gate at `:64` via
`FileManagerService.isArchiveFile`).

1. `ArchivePreviewModel` counts entries to give the progress bar a denominator
   (`ContextMenuPopup.qml:404-415`).
2. `_startExtraction` derives the destination folder name by stripping the
   extension, with an explicit `\.tar\.[^.]+$` case for double extensions
   (`ContextMenuPopup.qml:136-149`).
3. `["mkdir","-p","--",destDir]` (`ContextMenuPopup.qml:147`).
4. `["bsdtar","-xvf", archivePath, "-C", destDir]` (`ContextMenuPopup.qml:423`).
5. Progress: `onStderrLine: extractedCount++` — `bsdtar -v` writes one line per
   entry to stderr (`ContextMenuPopup.qml:434`).
6. Terminal state renders "Extraction complete" or
   `Extraction failed (exit code N)`; `Enter` or `Escape` then closes
   (`ContextMenuPopup.qml:234-240`). The scrim refuses to close mid-extraction
   (`ContextMenuPopup.qml:246-249`).

**Port to Electron.** Keep spawning `bsdtar` and keep counting stderr lines —
`node-tar` handles tar only, and the archive set here includes zip, 7z and rar
(`FileManagerService.qml:185-210`). The stderr-line progress idiom ports exactly
onto `spawn` + `readline`.

### 1.8 Zoxide, bookmarks and logging

Not user-facing "file operations", but they are process spawns on the same
primitive and they must be accounted for in a port.

- Every navigation trains zoxide: `["zoxide","add","--",path]`, with a
  single-slot `_pendingPath` queue so rapid navigation drops no visit
  (`FileManager.qml:179-208`).
- `z` opens `ZoxidePopup`, which runs
  `["zoxide","query","--list","--score", …keywords]` debounced by 100 ms
  (`ZoxidePopup.qml:240-255`, `:286-290`).
- `BookmarkService` writes `bookmarks.json` through
  `sh -c 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1"'` with the path
  and payload as positional arguments (`BookmarkService.qml:126-149`), and reads
  it back through the C++ `FileWatcher` (`BookmarkService.qml:109-124`).
- `Logger` appends to `~/.local/share/symmetria/logs/filemanager.log` through the
  same `sh -c` idiom, buffered and flushed on a 500 ms timer
  (`Logger.qml:100-128`).

**Port to Electron.** All three become `fs.promises` calls. Zoxide stays an
external binary. The `sh -c 'mkdir -p … && printf …'` write idiom exists only
because `ShellRunner` is argv-only; in Node it is
`fs.promises.mkdir` + `fs.promises.writeFile`.

---

## 2. The clipboard model

### 2.1 Two independent clipboards

The application holds **two** unrelated clipboards.

1. The **internal yank/cut clipboard** — `FileManagerService.clipboardPaths` +
   `clipboardMode`, described in §1.2. It never touches the Wayland selection.
   Paste reads it and runs `cp`/`mv`. It survives window close because
   `FileManagerService` is a singleton in the daemon process.
2. The **Wayland system clipboard** — written through `wl-copy` by the `c` chord
   family and by picker `Shift+Enter`. Nothing ever reads it back; the
   application has no `wl-paste` call site.

### 2.2 Indicator colours

Marked rows carry a 5-pixel left strip (`components/IndicatorStrip.qml:17-39`),
rendered at `opacity 0.85` when active, with a `Behavior on opacity { Anim {} }`.

Colours are fixed, not palette-derived, because the palette follows the wallpaper
(`services/FmTheme.qml:189-197`):

| Token | Value | Meaning |
|---|---|---|
| `FmTheme.indicator.cut` | `#e57373` | row is on the clipboard in `cut` mode |
| `FmTheme.indicator.yank` | `#4caf7d` | row is on the clipboard in `yank` mode |
| `FmTheme.indicator.selection` | `#f0c674` | row is Space-marked |

Both list views paint both strips, selection on top
(`FileListItem.qml:135-148`, `FileTreeRow.qml:205-218`). The status bar reuses
`indicator.selection` for the "N selected" counter (`StatusBar.qml:131-135`).

### 2.3 The `c` chord family

Handled outside the registry, in `ChordHandler.js:91-165`:

| Chord | Copies |
|---|---|
| `cc` | absolute path(s), newline-joined when a selection exists |
| `cf` | filename(s) |
| `cn` | filename(s) with the extension stripped (`_stripExtension`, `ChordHandler.js:187-190`) |
| `cd` | the current directory path, ignoring any selection (`ChordHandler.js:126-130`) |
| `ci` | the hovered image's raw **bytes**, not its path (`ChordHandler.js:103-124`) |

`ci` has two guards. The first rejects a non-image cursor entry. The second
rejects an entry whose MIME does not start with `image/`, because
`FileSystemEntry.isImage` is a content sniff that also accepts `.rpgmvp`,
`.png_` and `.icns`, whose raw bytes are not a valid image the clipboard can
advertise (`ChordHandler.js:110-119`). The chord row is hidden from the which-key
HUD for non-images through `WindowState.currentEntryIsImage` and
`ImageChord.copyGroupWithImageRow` (`services/ImageChord.js:25-33`).

### 2.4 The `wl-copy` launcher and the "copies but paste fails" bug

**Symptom.** Copy a path with `cc`, close the file-manager window, then paste
elsewhere: the clipboard is empty.

**Root cause** (`.claude/memory/project_clipboard_bug_root_cause.md:10-14`,
restated in `FileManagerService.qml:37-56`), in four steps:

1. Wayland has no central clipboard store. The selection is **served live** by the
   client that owns it. `wl-copy` forks a child that must stay alive to answer
   every paste request.
2. A plain `wl-copy` spawned from the daemon lands in the
   `symmetria-fm.service` cgroup.
3. The daemon **deliberately exits** when the last window closes —
   `quitOnLastWindowClosed` is left at its default `true`, and systemd's
   `Restart=always` brings up a fresh instance
   (`host/standalone/main.cpp:60-64`).
4. systemd's default `KillMode=control-group` then kills everything in that
   cgroup, including the `wl-copy` holder.

The confirmed instance in the memory note: at 20:27:15 `cd` copied a path; at
20:27:16 the service exited because the window closed; the restart killed the
holder.

**Why the workaround worked.** Symmetria Shell's clipboard manager captures
content immediately over the `wlr-data-control` watch. Re-selecting the entry
there re-serves it from the shell's own process.

**Candidate fixes recorded** (`project_clipboard_bug_root_cause.md:16`):
- **A — `systemd-run --user --collect` (preferred, surgical).** Detach the holder
  into its own transient unit.
- **B — `KillMode=process` on the unit (one line, less surgical).** Stops systemd
  killing the whole cgroup, but also stops it reaping any other child.

**Fix A shipped.** `FileManagerService._clipboardLauncherPrefix` is
`["systemd-run","--user","--collect","--quiet","--"]`
(`FileManagerService.qml:57`), and every copy command concatenates onto it:

- `clipboardCopyCommand(text)` →
  `systemd-run --user --collect --quiet -- wl-copy --foreground -- <text>`
  (`FileManagerService.qml:59-61`).
- `clipboardCopyFileCommand(mime, path)` →
  `systemd-run … -- sh -c 'exec wl-copy --foreground --type "$1" < "$2"' sh <mime> <path>`
  (`FileManagerService.qml:72-77`). The `sh -c` exists only because `wl-copy`
  reads bytes from stdin and `ShellRunner` is argv-only with no redirection. The
  MIME and path are **positional** `$1`/`$2`, never interpolated, so filenames
  with spaces, quotes or `$` stay injection-safe. `exec` replaces `sh` with
  `wl-copy` so the transient unit's cgroup tracks `wl-copy` directly.

Flag semantics, each load-bearing:
- `--user` — the user bus, not the system bus.
- `--collect` — garbage-collect the transient unit once `wl-copy` exits, which it
  does when a later copy takes the selection.
- `--quiet` — suppress the generated unit name on stderr.
- `--foreground` (a `wl-copy` flag) — keep `wl-copy` in the foreground. A forked
  child would leave the transient unit and be cgroup-killed the old way.

`ClipboardCopyRunner` monitors the **launcher's** exit, not `wl-copy`'s: exit
code 0 means the transient unit was created and `wl-copy` was started
(`components/ClipboardCopyRunner.qml:14-23`). It also carries an optional
`_pendingCallback` so callers can sequence work after the clipboard write — the
picker `Shift+Enter` path uses it to hold the picker window open until the
copy lands (`KeyRegistry.js:303-315`, `NormalModeHandler.js:58-72`).

**Port to Electron.** Electron's `clipboard.writeText` /
`clipboard.writeImage` run inside the main process, so the *same class of bug
returns in a new shape*: on Wayland the Chromium process is now the selection
owner, and closing the app drops the selection. Electron does not solve this;
`app.quit()` after a copy loses the clipboard exactly as the Qt daemon did.
Two mitigations, both explicit choices:
- Keep the process resident (which the daemon design already implies), so the
  Electron main process is the long-lived holder.
- Or keep shelling out to `systemd-run … wl-copy --foreground`, preserving the
  current detachment and accepting the `wl-clipboard` dependency.

Copying **image bytes** through `clipboard.writeImage(nativeImage.createFromPath(p))`
loses the explicit MIME advertisement the `--type` flag provides, and
`nativeImage` decodes only the formats Chromium knows. The `ci` MIME guard has to
be re-derived on the Node side.

---

## 3. Daemon architecture

### 3.1 The unit

`symmetria-fm.service` (repo root, installed to
`~/.config/systemd/user/symmetria-fm.service` by `install.sh:66-69`):

```
[Service]
ExecStart=/usr/bin/symmetria-fm
UnsetEnvironment=HL_INITIAL_WORKSPACE_TOKEN
Restart=always
RestartSec=2
[Install]
WantedBy=default.target
```

`UnsetEnvironment=HL_INITIAL_WORKSPACE_TOKEN` is load-bearing and non-obvious.
The daemon starts once at login and inherits the session's stale Hyprland
initial-workspace token. Hyprland reads that token from `/proc/<pid>/environ`
and, with `misc:initial_workspace_tracking=1` (its default), routes the daemon's
**first** spawned window to the workspace recorded in the token — so the first
file-manager window after login always landed on workspace 1. The unset must
happen before `exec`, because `/proc/<pid>/environ` is the exec-time environment
block; an in-process `unsetenv()` in `main.cpp` would be too late. See Hyprland
issue #5919 and `.claude/memory/project_first_window_workspace_bug.md`.

There are **two unsynchronised copies** of this unit: the repo copy and a copy in
the user's dotfiles (recorded in `.claude/memory/MEMORY.md`).

### 3.2 Startup sequence — `host/standalone/main.cpp`

Order is deliberate and documented in the file:

1. `QtWebEngineQuick::initialize()` **before** `QGuiApplication`, because it sets
   `Qt::AA_ShareOpenGLContexts` (`main.cpp:30`).
2. Four statics set before the application object exists (`main.cpp:40-57`):
   `setApplicationName("symmetria-fm")`,
   `setApplicationDisplayName("File Manager")`,
   `setOrganizationName("Symmetria")`,
   `setDesktopFileName("symmetria-fm")`.
   Qt's unix platform integration reads `desktopFileName()` in its constructor.
   Setting it first registers with the XDG portal immediately; setting it later
   works only through Qt's deferred retry path, which is an implementation
   detail the code refuses to depend on.
3. `QGuiApplication app(argc, argv)` (`main.cpp:59`). `quitOnLastWindowClosed`
   is left at its default `true` **on purpose** — the daemon exits when the last
   window closes and systemd restarts it, so each session starts clean. The
   comment explicitly forbids "fixing" this (`main.cpp:60-64`).
4. `HostController controller; controller.startServer()`. A failure is fatal and
   returns 1, with the message "another instance may already be running"
   (`main.cpp:66-71`).
5. `QQmlApplicationEngine`, plus a `warnings` connection that prints QML errors
   to stderr — without it the engine swallows compile and runtime errors in
   release builds (`main.cpp:78-81`).
6. `engine.addImportPath(SYMMETRIA_FM_PANEL_PATH)` (`main.cpp:87`) and
   `rootContext()->setContextProperty("hostController", &controller)`
   (`main.cpp:92-93`). The context property is used instead of the
   `QML_SINGLETON` registration, which only works inside a module.
7. `engine.load(SYMMETRIA_FM_QML_PATH)`, then `qInfo("symmetria-fm: ready")`.

Both path macros are compile-time definitions from
`host/standalone/CMakeLists.txt:20-23`, `:38-41`, and `main.cpp:16-22` turns a
missing definition into a `#error`.

### 3.3 What `HostController` owns

`host/standalone/server.hpp:21-51`. It is a `QObject` with `QML_ELEMENT` and
`QML_SINGLETON`, but in practice it is injected as a context property.

Owns: one `QLocalServer m_server`.

Provides: `startServer()`, the static `socketPath()`, and four signals
(`server.hpp:37-41`):
- `openRequested(QString initialPath)`
- `openOverlayRequested(QString initialPath)`
- `createPickerRequested(QVariantMap options)`
- `closePickerRequested(QString fifoPath)`

It performs **all** FIFO-path validation server-side, before any QML signal
fires (`server.hpp:10-13`). It replaces the retired QuickShell
`WindowFactory.qml`, which folded windowing and IPC into one QML singleton.

Destructor detail worth keeping: it captures `fullServerName()` **before**
`close()`, because `close()` clears the name and `QFile::remove("")` logs
`QFile::remove: Empty or null file name` on every shutdown
(`server.cpp:35-44`).

### 3.4 The wire protocol

**Transport.** `QLocalServer` (a Unix domain socket) at
`$XDG_RUNTIME_DIR/symmetria-fm.sock`, falling back to
`QDir::tempPath() + "/symmetria-fm.sock"` when `XDG_RUNTIME_DIR` is unset — for CI
and minimal setups (`server.cpp:46-53`). The CLI's own fallback is the literal
`/tmp/symmetria-fm.sock` (`cli.cpp:25-31`); the two fallbacks agree in practice
but are not the same expression.

**Stale-socket cleanup.** `startServer()` calls
`QLocalServer::removeServer(path)` before `listen()`, which is safe because only
one process holds the daemon role and a second instance is rejected by `listen()`
right after (`server.cpp:55-69`).

**Framing.** One JSON object per line. The reader loops on `canReadLine()`,
trims, and skips empty lines (`server.cpp:83-87`). Malformed JSON or a non-object
top level gets `{"ok":false,"error":"invalid_json"}` and the connection stays open
(`server.cpp:88-95`).

**Envelope.**

```json
{"method": "<name>", "args": { … }}
```

**Response.** `{"ok":true}` on success, `{"ok":false,"error":"<code>"}` on
failure, always followed by `\n` and flushed (`server.cpp:106-112`).

**The complete command set — four methods.**

| `method` | `args` | Validation | Reply | Signal emitted |
|---|---|---|---|---|
| `open` | `{"initialPath": string}` | none | `{"ok":true}` | `openRequested` |
| `openOverlay` | `{"initialPath": string}` | none | `{"ok":true}` | `openOverlayRequested` |
| `createPicker` | see below | `validateFifoPath(args.fifo)` | `{"ok":true}` or `{"ok":false,"error":"invalid_fifo_path"}` | `createPickerRequested(QVariantMap)` |
| `closePicker` | `{"fifo": string}` | `validateFifoPath(args.fifo)` | same as above | `closePickerRequested(fifo)` |

Any other value gets `{"ok":false,"error":"unknown_method"}` plus a
`qWarning` (`server.cpp:150-153`).

**`createPicker` argument schema** (`server.cpp:121-128`), forwarded to QML as a
`QVariantMap` **as-is**:

| Key | Type | Meaning |
|---|---|---|
| `fifo` | string, **required** | response FIFO path, validated |
| `title` | string | window title / picker heading |
| `multiple` | bool | allow multi-select |
| `directory` | bool | select directories instead of files |
| `saveMode` | bool | save dialog semantics |
| `suggestedName` | string | pre-filled save filename |
| `acceptLabel` | string | accept-button label |
| `currentFolder` | string | starting directory |
| `parentWindow` | string | XDG portal handle, `"wayland:HANDLE"` or `"x11:XID"` |
| `fileOps` | bool | the `pickerFileOps` escape hatch (see §5.5) |

`parentWindow` is currently only logged at the spawn site
(`host/standalone/main.qml:140-141`); it is diagnostic groundwork for an
xdg-foreign-v2 transient-parent import that is not yet implemented.

**`validateFifoPath` — four layers** (`server.cpp:156-172`), which mirror the
rules that used to live in `WindowFactory.qml:79-100`:

1. Prefix: the path must start with `/tmp/symmetria-picker-`
   (`kValidFifoPrefix`, `server.cpp:15`).
2. Traversal: reject any path containing `..` or a NUL character.
3. Length: reject longer than 128 characters (`kMaxFifoPathLength`,
   `server.cpp:16`).
4. Charset: the suffix after the prefix must match `^[a-zA-Z0-9._-]+$` — a uuid4
   hex string plus dots, dashes and underscores.

Because validation happens before the signal fires, `main.qml` treats every FIFO
path it receives as already trusted (`host/standalone/main.qml:126-129`,
`:182-185`).

### 3.5 Window spawning from a signal

`host/standalone/main.qml` is a **headless** `QtObject` root. It instantiates no
window at startup (`main.qml:3-5`). Because `QtObject` has no default property,
every child — `Component`, `Connections`, `ShellRunner`, `Timer` — is declared as
a named property (`main.qml:6-9`).

- `_hostConn` binds to the `hostController` context property
  (`main.qml:152-180`).
- `onOpenRequested` → `_spawnFileManager(initialPath)` (`main.qml:156-158`).
- `onOpenOverlayRequested` → the **same** `_spawnFileManager`. There is no
  layer-shell overlay in the standalone host; the comment explains that the
  overlay case existed under QuickShell and is now the compositor's job
  (`main.qml:159-166`).
- `_spawnFileManager` (`main.qml:105-115`) falls back to `Paths.home` on an empty
  path, and creates the window with `createObject(root, {initialPath})` so the
  window's lifetime is owned by the host QObject tree — no JS tracking array.

The file-manager window (`main.qml:43-65`): 1100 × 720, `visible: true`,
`color: FmTheme.windowBackdrop`, title "File Manager", `onClosing: destroy()`, and
a single `FileManager` child whose `onCloseRequested` calls `win.close()`.

The picker window (`main.qml:67-103`): 900 × 600,
`modality: Qt.ApplicationModal`, `flags: Qt.Dialog | Qt.WindowStaysOnTopHint`,
`Component.onCompleted: requestActivate()`. Its `onClosing` clears
`root._pickerWindow`, calls `FileManagerService.cancelPickerMode()` when picker
mode is still active, then destroys itself (`main.qml:90-95`).

### 3.6 Last-window-closes behaviour

`quitOnLastWindowClosed` stays `true`, so the process exits, and `Restart=always`
plus `RestartSec=2` brings up a fresh daemon (`main.cpp:60-64` and the unit).
Consequences, all deliberate:

- No window state survives a session. Tabs, history and cursor caches are gone.
- The in-memory yank/cut clipboard is gone.
- Anything in the service cgroup is killed — this is the `wl-copy` bug of §2.4.

### 3.7 The startup cost that motivates a resident daemon

`PRD.md:70` records the original measurement in the Yazi-backend evaluation:
spawning the backend on demand adds roughly **200 ms cold start** versus instant
native listing. The resident daemon exists so that `symmetria-fm-cli open <path>`
costs one socket write plus window construction, not a Qt + QML + WebEngine
process start. Note the daemon still pays that cost on every restart-after-last-
window-close; the win is that the restart happens **while the user is not
waiting**, in the two seconds after the last window closed.

**Port to Electron.** The direct mapping is a resident Electron **main process**
that creates `BrowserWindow`s on demand. Two transport options:

1. **`net.createServer` on a Unix domain socket** at
   `$XDG_RUNTIME_DIR/symmetria-fm.sock`, with newline-delimited JSON. This is a
   one-to-one port: `QLocalServer` → `net.Server`, `canReadLine()` → a
   `readline.createInterface` over the socket. The stale-socket cleanup
   (`fs.unlink` before `listen`) has to be reimplemented; Node does not do it.
2. **`app.requestSingleInstanceLock()` plus the `second-instance` event.** The
   CLI becomes `symmetria-fm <path>`, which starts a second Electron process that
   immediately loses the lock and forwards `argv` to the first. Simpler, but it
   pays a full Electron start per CLI invocation (~100–300 ms and ~80 MB), and it
   cannot deliver a **reply** — the portal backend needs `{"ok":false,"error":…}`
   for `invalid_fifo_path`, so option 1 is required for the portal path.

Risks specific to Electron:
- `app.quit()` on last window is `window-all-closed`'s default on Linux. To keep
  the current semantics you keep that default and rely on the systemd restart; to
  keep the clipboard alive you suppress it. **Pick one deliberately** — the two
  requirements conflict, exactly as they do today.
- Electron's resident memory is far higher than the Qt daemon's, and the daemon
  starts at login. Measure before shipping `WantedBy=default.target`.
- `QtWebEngineQuick::initialize()` has no analogue and disappears; Chromium is
  the runtime.

---

## 4. The CLI — `symmetria-fm-cli`

Source: `host/standalone/cli.cpp`. It links only `Qt::Core` and `Qt::Network`
(`host/standalone/CMakeLists.txt:64-72`), so it is a small binary with no GUI
dependency. It replaces
`qs ipc --any-display -c symmetria-fm call filemanager <method> <args>`.

**Usage** (`cli.cpp:33-40`):

```
symmetria-fm-cli open <path>
symmetria-fm-cli openOverlay <path>
symmetria-fm-cli createPicker '<json>'
```

**Subcommands.**

| Subcommand | Argument | Envelope built |
|---|---|---|
| `open` | optional path; absent → empty string | `{"method":"open","args":{"initialPath":"<path>"}}` |
| `openOverlay` | optional path | `{"method":"openOverlay","args":{"initialPath":"<path>"}}` |
| `createPicker` | required JSON object string | `{"method":"createPicker","args":<parsed object>}` |

`closePicker` is **not** in the CLI's usage text, but it reaches the daemon
through the same generic path — the portal backend calls
`launch_fm_ipc("closePicker", json)` (`portal/symmetria_portal.py:153`), and the
CLI's `else` branch rejects unknown methods before the socket is opened
(`cli.cpp:72-76`). This is a real inconsistency: `closePicker` works today only
because… it does not. Reading `cli.cpp:57-76`, a `closePicker` invocation exits 2
with `unknown method: closePicker`. The portal's `Request.Close` path therefore
never reaches the daemon, and the picker is dismissed by its own FIFO timeout
instead. **Flag this to the port: either add `closePicker` to the CLI, or have
the portal write the socket directly.**

**Exit behaviour** (`cli.cpp:44-116`):

| Code | Condition |
|---|---|
| 2 | fewer than 2 arguments; `createPicker` without a JSON argument; unparsable JSON; unknown method |
| 1 | cannot connect within `kConnectTimeoutMs` = 2000 ms; no reply within `kReadTimeoutMs` = 2000 ms; malformed reply; reply with `ok:false` |
| 0 | reply with `ok:true` |

Failure messages go to stderr, including the socket path and
`Is symmetria-fm running?` (`cli.cpp:85-91`).

**Port to Electron.** A ~40-line Node script with `net.connect`, one
`socket.write(JSON.stringify(envelope) + "\n")`, and a reply read with the same
two timeouts. It must **not** be an Electron binary; the whole point is a fast,
GUI-free client that the portal backend can spawn per dialog. Ship it as a plain
Node script or a small compiled helper, and keep the exit-code contract because
`install-portal.sh` and the `.desktop` entry both depend on it.

---

## 5. Picker mode

### 5.1 Becoming a file dialog

Picker mode is global state on the `FileManagerService` singleton — exactly one
picker at a time, process-wide (`FileManagerService.qml:79-97`):

`pickerMode`, `pickerFifoPath`, `pickerTitle`, `pickerAcceptLabel`,
`pickerMultiple`, `pickerDirectory`, `pickerSaveMode`, `pickerSuggestedName`,
`saveNameEditing`, `pickerFileOps`.

`startPickerMode(options)` copies the IPC args onto those properties with
defaults (`FileManagerService.qml:102-116`). Navigation to `currentFolder` is
**not** done here — the host passes it as the window's `initialPath`
(`main.qml:143-145`).

Two signals close the loop (`FileManagerService.qml:99-100`):
`pickerCompleted(fifoPath, paths)` and `pickerCancelled(fifoPath)`. Both capture
the FIFO path **before** `_resetPickerState()` clears it, and emit **after** the
reset so listeners already observe `pickerMode === false`
(`FileManagerService.qml:118-132`).

### 5.2 Single, multi and save modes

`confirmPickerSelection(currentEntry, windowState)` is the single source of truth,
called by both the `Enter` key path (`FileList.qml:145-147`) and the Accept button
(`StatusBar.qml:110-117`). Its precedence
(`FileManagerService.qml:136-168`):

1. **Multi-select** — when `pickerMultiple` and `windowState.selectedCount > 0`,
   return every marked path. The selection is cleared **before** completing, so
   the count binding resets before `pickerMode` flips and no stale count flashes.
2. **Save mode** — `pickerSaveMode` and `pickerMultiple` are orthogonal; save mode
   ignores marks. Return `currentPath + "/" + pickerSuggestedName` when a name
   exists, otherwise just the directory for the portal to append to.
3. **Directory picker** — `pickerDirectory` returns the cursor entry only when it
   is a directory.
4. **File picker** — otherwise return the cursor entry only when it is **not** a
   directory.

Returning a single URI when `multiple: true` is conformant; the FileChooser spec
does not require returning the maximum requested count
(`FileManagerService.qml:108-109`).

The status bar renders the picker chrome (`StatusBar.qml:64-121`, `:273-296`):
an Accept button whose enabled state mirrors the same type rules, a Cancel button
wired to `cancelPickerMode()`, and, in save mode, an inline-editable filename
field (`StatusBar.qml:167-248`). `Ctrl+R` enters the edit
(`op.pickerSaveEdit`, `KeyRegistry.js:204-207`), `Enter` confirms and saves,
`Escape` reverts, `Tab` toggles basename / full-name selection. An empty name is
rejected and reverts (`StatusBar.qml:192-203`).

### 5.3 Key suppression

The picker pre-pass runs inside `KeyRegistry.dispatch`, before the binding scan
(`KeyRegistry.js:516-541`, called at `:578-579`).

- `Escape`: clears the selection when `pickerMultiple` and marks exist, otherwise
  cancels picker mode. Always consumed (`KeyRegistry.js:520-527`).
- The suppressed key list is `_PICKER_SUPPRESSED_KEYS =
  [Y, X, P, Space, T, BracketLeft, BracketRight]` (`KeyRegistry.js:81-82`):
  yank, cut, paste, mark, new tab, previous tab, next tab. `C` is deliberately
  absent because it starts the harmless copy-path chord.
- Two exemptions: `Space` stays live when `pickerMultiple` (marking is how
  multi-select works), and `Ctrl+P` stays live because it is the audio toggle —
  only bare `p` is suppressed (`KeyRegistry.js:529-531`).
- `Ctrl+V` is suppressed separately (`KeyRegistry.js:535-538`).
- `isSuppressedInPicker(binding, fileManager)` mirrors those exemptions exactly so
  the `?` cheat-sheet never advertises a key that the picker eats
  (`KeyRegistry.js:547-568`).
- Marking is additionally type-filtered: a file picker marks only files, a
  directory picker only directories; `pickerFileOps` and save mode opt out
  (`KeyRegistry.js:139-142`).
- `ContextMenuPopup` is disabled outright in picker mode through its `active`
  binding (`ContextMenuPopup.qml:16-17`).

`Shift+Enter` in a picker copies the chosen path to the Wayland clipboard and
confirms **inside the `wl-copy` exit callback**, so the picker window stays open
until the clipboard write completes (`KeyRegistry.js:303-315`,
`NormalModeHandler.js:58-72`). `_resolvePickerPath` reproduces the same
save/directory/file precedence as `confirmPickerSelection`
(`NormalModeHandler.js:39-55`) — **a duplicated rule that a port should unify**.

### 5.4 The FIFO handshake, end to end

1. The portal creates the FIFO: `os.mkfifo("/tmp/symmetria-picker-" + uuid4().hex,
   mode=0o600)`. `uuid4` plus `mkfifo` avoids the TOCTOU race of
   `tempfile.mktemp` (`portal/symmetria_portal.py:97-105`).
2. The portal spawns `symmetria-fm-cli createPicker '<json>'` in a daemon thread
   with `Popen` + `communicate()` so the child is reaped and no zombie remains
   (`symmetria_portal.py:108-128`).
3. The daemon validates the FIFO path and emits `createPickerRequested`
   (`server.cpp:129-136`).
4. `main.qml._spawnPicker` calls `FileManagerService.startPickerMode(options)` and
   creates the picker window at `options.currentFolder || Paths.home`
   (`main.qml:142-149`).
5. The portal blocks on `read_fifo(fifo_path, 300)`. The read runs in an executor
   thread under an `asyncio.wait_for`, so the event loop stays responsive
   (`symmetria_portal.py:64-94`). It opens with `os.open` and verifies
   `stat.S_ISFIFO(os.fstat(fd).st_mode)` **on the opened descriptor**, which
   defeats symlink substitution (an attacker replacing the FIFO with a symlink to
   `/etc/shadow`).
6. The user confirms → `pickerCompleted(fifo, paths)` → `main.qml`'s
   `_fifoWriteProcess` runs
   `python3 -c "import sys; open(sys.argv[2],'w').write(sys.argv[1])"` with the
   newline-joined paths as `argv[1]` and the FIFO as `argv[2]`
   (`main.qml:189-195`, `:210-212`).
   The user cancels → `pickerCancelled(fifo)` → `_fifoCancelProcess` writes the
   sentinel `__PICKER_CANCELLED__` (`main.qml:23`, `:250-257`), which matches the
   portal's `CANCELLED_SENTINEL` (`symmetria_portal.py:40`).
7. Both writers arm a 5000 ms `Timer`; on timeout the writer is killed and the
   picker window is force-closed (`main.qml:240-248`, `:282-290`). Both also close
   the window from `onErrorOccurred`, because a `FailedToStart` emits no `exited`
   and would otherwise leave the requesting app hanging on the portal's 300 s
   timeout (`main.qml:228-237`, `:273-279`). `_closePickerWindow` is idempotent
   (`main.qml:345-348`).
8. The portal reads the payload, unexports the `Request` object and unlinks the
   FIFO in a `finally` block (`symmetria_portal.py:194-205`).

**Second-picker rejection.** `_spawnPicker` refuses to open a second picker
(`main.qml:118-135`). Instead of dropping the request silently — which would hang
the requesting app for the portal's full 300 s and can crash Electron apps
outright — it pushes the new FIFO onto `_pendingRejectFifos` and calls
`_drainRejects()`, then raises the existing picker.

The reject queue is a small state machine worth porting carefully:
- `_fifoRejectProcess` is a **separate** runner from `_fifoCancelProcess`,
  because the cancel runner closes the active picker on exit and a busy rejection
  must **not** (`main.qml:292-296`).
- `_rejectBusy` gates the drain, not `running`, because `ShellRunner.start()` is a
  no-op during its `m_starting` window; a `running`-only gate let a second reject
  overwrite the in-flight writer's `fifoPath` and silently no-op, relocating the
  very hang the queue prevents (`main.qml:32-41`).
- `_settleReject()` advances the queue exactly once per writer, whichever terminal
  signal arrives first — normal exit, failed start, or the timeout kill
  (`main.qml:362-373`).
- The reject timeout only kills; it does **not** drain, because the kill's
  `exited` always follows and draining twice could settle the next writer with a
  stale exit (`main.qml:330-343`).

### 5.5 The `pickerFileOps` escape hatch

`FileManagerService.pickerFileOps` (`FileManagerService.qml:89-97`) is an opt-in
flag for embedding hosts — the Symmetria IDE — that want a **full file manager**
riding the picker's open/cancel routing rather than a bare file chooser.

When true, the dispatch pre-pass skips the whole suppression block
(`KeyRegistry.js:528`), so yank, cut, paste, Space-marking and tabs all work,
while `Enter → pickerCompleted` and `Escape → cancel` stay intact. It also
disables the type filter on marking (`KeyRegistry.js:140`) and makes
`isSuppressedInPicker` return false so the cheat-sheet shows everything
(`KeyRegistry.js:548-549`).

It defaults to `false`, and the XDG portal never sets it, so the system file
dialog keeps the suppression.

**Port to Electron.** Picker mode is pure renderer state plus one IPC round-trip;
it ports cleanly to a Zustand/Redux slice plus `ipcMain.handle`. The FIFO,
however, exists only because a Qt QML process could not easily write to a named
pipe — it shelled out to `python3`. In Node the whole FIFO layer collapses:
`fs.createWriteStream(fifoPath)` writes a named pipe directly, and the three
`ShellRunner` + `Timer` + queue state machines
(`main.qml:204-373`) disappear along with their five documented failure modes.
Keep the **sentinel** (`__PICKER_CANCELLED__`) and the **300 s / 5 s timeouts**;
they are protocol, not implementation. Risk: the busy-reject queue exists because
only one picker may be open; that rule must be reasserted in the Electron main
process or concurrent dialogs will race.

---

## 6. The XDG portal backend

### 6.1 What it implements

`portal/symmetria_portal.py` implements exactly one D-Bus interface:
**`org.freedesktop.impl.portal.FileChooser`**, with the three standard methods
(`symmetria_portal.py:156-370`):

| Method | Signature | Returns |
|---|---|---|
| `OpenFile` | `(o handle, s app_id, s parent_window, s title, a{sv} options) → ua{sv}` | `[0, {"uris": as}]` on success |
| `SaveFile` | same signature | `[0, {"uris": as}]` with a single URI |
| `SaveFiles` | same signature | `[0, {"uris": as}]` with the chosen directory URI |

Response codes: `0` = success, `1` = cancelled or timed out, `2` = error
(`symmetria_portal.py:240`, `:249-254`).

It also exports **`org.freedesktop.impl.portal.Request`** at the router-supplied
`handle` object path, with a single `Close` method
(`symmetria_portal.py:131-153`). Backends **must** export this; without it the
router gets a D-Bus error and the picker window leaks open, blocking every
subsequent dialog because of the single-picker lock in the daemon.
`Close` is intentionally fire-and-forget: `read_fifo()` runs on the same event
loop, so awaiting the dismissal would deadlock against the response it waits for
(`symmetria_portal.py:148-152`).

The bus name is `org.freedesktop.impl.portal.desktop.symmetria`, and the backend
object is exported at `/org/freedesktop/portal/desktop`
(`symmetria_portal.py:373-380`).

### 6.2 Option handling per method

`OpenFile` (`symmetria_portal.py:207-254`) reads `multiple`, `directory`,
`accept_label` and `current_folder`. It deliberately does **not** default to
`~/Downloads`: the calling app's folder hint is meaningful for an open dialog.

`SaveFile` (`symmetria_portal.py:256-322`) reads `current_name`,
`accept_label`, `current_folder` and `current_file`. When `current_file` is set it
derives the missing folder and name from it. When the folder is empty **or equals
`$HOME`**, it substitutes `DOWNLOADS_DIR`. After the picker returns, if the chosen
path is a directory and a name is known, it joins them
(`symmetria_portal.py:309-310`).

`SaveFiles` (`symmetria_portal.py:324-370`) sends `directory: True` and
`saveMode: True` with the accept label "Save Here", and returns the chosen
directory.

`DOWNLOADS_DIR` is `~/Downloads` only when that directory actually exists,
otherwise `$HOME` (`symmetria_portal.py:35-37`).

`current_folder` and `current_file` arrive as D-Bus `ay` (null-terminated byte
arrays); `decode_byte_array_path` strips trailing NULs and decodes UTF-8 with
`errors="replace"` (`symmetria_portal.py:45-54`).

### 6.3 End-to-end request flow

```
App (Firefox / Electron / GTK)
  → xdg-desktop-portal (router, reads portals.conf)
  → org.freedesktop.impl.portal.desktop.symmetria  [this backend]
      → os.mkfifo("/tmp/symmetria-picker-<uuid4hex>", 0o600)
      → bus.export(handle, PortalRequest(fifo))
      → symmetria-fm-cli createPicker '<json incl. fifo>'
          → QLocalSocket → $XDG_RUNTIME_DIR/symmetria-fm.sock
          → HostController::handleCommand → validateFifoPath → createPickerRequested
          → main.qml._spawnPicker → FileManagerService.startPickerMode → picker Window
      → await read_fifo(fifo, 300 s)      [executor thread]
  ← picker confirm → pickerCompleted → python3 one-liner writes paths to the FIFO
  ← or cancel      → pickerCancelled → writes "__PICKER_CANCELLED__"
      → bus.unexport(handle); os.unlink(fifo)
  ← [0, {"uris": ["file:///…", …]}]  or  [1, {}]  or  [2, {}]
  → router → App
```

The `handle` is a per-request object path the router allocates uniquely
(`…/request/<sender>/<token>`), so concurrent requests never collide on the export
path (`symmetria_portal.py:174-176`). A failed export is non-fatal: the dialog
still works, only app-initiated `Close` is lost
(`symmetria_portal.py:178-183`).

### 6.4 Install layout

`portal/install-portal.sh` performs six steps:

| Step | Destination | Source |
|---|---|---|
| 1 | `~/.local/share/symmetria/portal-venv/` | `python3 -m venv` + `pip install dbus-fast` |
| 2 | `/usr/lib/symmetria/symmetria_portal.py` (mode 755) | `portal/symmetria_portal.py` |
| 3 | `/usr/share/xdg-desktop-portal/portals/symmetria.portal` | `portal/symmetria.portal` |
| 3b | verify only — warns when `/usr/share/applications/symmetria-fm.desktop` is missing | installed by the **host** build |
| 4 | `/usr/share/dbus-1/services/org.freedesktop.impl.portal.desktop.symmetria.service` | `portal/org.freedesktop…service` |
| 5 | `~/.config/systemd/user/xdg-desktop-portal-symmetria.service` and `~/.config/systemd/user/symmetria-fm.service` | `portal/` and the repo root |
| 6 | `~/.config/xdg-desktop-portal/portals.conf` (backed up to `.bak` first) | generated inline |

The generated `portals.conf` is:

```
[preferred]
default=hyprland;gtk
org.freedesktop.impl.portal.FileChooser=symmetria
org.freedesktop.impl.portal.Settings=gtk
```

`portal/symmetria.portal` declares
`DBusName=org.freedesktop.impl.portal.desktop.symmetria`,
`Interfaces=org.freedesktop.impl.portal.FileChooser`, `UseIn=Hyprland`.

A venv is used because `dbus-fast` is not packaged and the alternative would be
`pip --break-system-packages` on an Arch system Python.

**A drift to note.** The D-Bus activation file declares
`Exec=/usr/bin/python3.12 /usr/lib/symmetria/symmetria_portal.py`
(`portal/org.freedesktop.impl.portal.desktop.symmetria.service:3`) — the system
Python, which does **not** have `dbus-fast`. The systemd unit declares
`ExecStart=%h/.local/share/symmetria/portal-venv/bin/python3 …`
(`portal/xdg-desktop-portal-symmetria.service:9`) — the venv. Because the D-Bus
file also names `SystemdService=xdg-desktop-portal-symmetria.service`, systemd
activation wins in practice and the `Exec=` line is dead. It is also pinned to a
Python **point release** and will rot on the next Arch update.

### 6.5 The startup pitfall

Documented in `CLAUDE.md` under Critical Pitfalls. `xdg-desktop-portal`
activates the **GTK Settings backend synchronously** at startup, because GTK is
the only backend implementing that interface. When GTK is not already running,
the call burns a 75 s D-Bus timeout and systemd can kill the unit. Then **no**
file dialog works system-wide — including ours — so the symptom looks like a bug
in `portal/`.

Diagnosis order: check `systemctl --user status xdg-desktop-portal` for
`start operation timed out` **before** suspecting anything in this repository.

The fix is a systemd drop-in that lives in **dotfiles, not this repository**:
`~/.dotfiles/.config/systemd/user/xdg-desktop-portal.service.d/gtk-ordering.conf`.
When it is missing, re-stow from `~/.dotfiles` and run
`systemctl --user daemon-reload`; confirm with
`systemctl --user cat xdg-desktop-portal`.

### 6.6 Files required that live OUTSIDE this repository

Named explicitly, because a fresh machine loses each one silently:

| Path | Owner | Consequence when missing |
|---|---|---|
| `/usr/lib/symmetria/symmetria_portal.py` | installed by `install-portal.sh` | the backend cannot start; the router falls back or fails |
| `/usr/share/xdg-desktop-portal/portals/symmetria.portal` | `install-portal.sh` | the router never considers this backend |
| `/usr/share/dbus-1/services/org.freedesktop.impl.portal.desktop.symmetria.service` | `install-portal.sh` | no D-Bus activation |
| `~/.config/systemd/user/xdg-desktop-portal-symmetria.service` | `install-portal.sh` | the backend is not started at login |
| `~/.config/systemd/user/symmetria-fm.service` | `install.sh` **and** `install-portal.sh` (two copies) | the daemon is not started at login; every `symmetria-fm-cli` call fails with exit 1 |
| `~/.local/share/symmetria/portal-venv/` | `install-portal.sh` | `ModuleNotFoundError: dbus_fast` |
| `~/.config/xdg-desktop-portal/portals.conf` | tracked by **neither** repository — machine-local state | `FileChooser` routes to GTK; the Symmetria picker never appears |
| `~/.dotfiles/.config/systemd/user/xdg-desktop-portal.service.d/gtk-ordering.conf` | the dotfiles repository | 75 s D-Bus timeout at startup; **no** file dialog works system-wide |
| `/usr/share/applications/symmetria-fm.desktop` | the **host** CMake install, not the portal installer | Qt logs `Could not register app ID: App info not found for ''`; portal requests stay anonymous |
| `/usr/share/icons/hicolor/512x512/apps/symmetria-fm.png` | the host CMake install | `Icon=symmetria-fm` degrades to a generic glyph |
| `~/.config/symmetria/ui/color-scheme.json` | optional, toolkit-owned | the built-in near-black palette is used |

Uninstall guidance explicitly warns **not** to remove
`/usr/share/applications/symmetria-fm.desktop`, because it belongs to the binary,
not to the portal backend (`install-portal.sh:88-90`).

**Port to Electron.** The portal backend does **not** port. It is a D-Bus service
that the desktop's portal router activates; Electron has no story for it. The
options:

1. **Keep the Python backend as-is.** It talks to the daemon over a socket and a
   FIFO, both of which Node speaks natively. This is the lowest-risk path: the
   only change is the socket server's implementation language.
2. **Rewrite the backend in Node with `dbus-next`.** Feasible — `dbus-next`
   exports interfaces and handles `a{sv}` variants — but it means owning a
   long-lived D-Bus service, and it cannot live inside the Electron main process
   without making a heavyweight GUI process a boot-time D-Bus dependency. It
   would be a second, small Node daemon.

Either way, this is **Linux-desktop integration that Electron does not solve**:
the `.portal` file, the D-Bus activation file, the `portals.conf` routing, the
systemd units and the GTK-ordering drop-in all remain hand-installed system files.

---

## 7. The app-id contract and window rules

### 7.1 The three-way contract

Three strings must be identical, and they fail differently.

| Position | File | Value |
|---|---|---|
| 1. `setDesktopFileName()` | `host/standalone/main.cpp:57` | `"symmetria-fm"` |
| 2. installed `.desktop` basename | `host/standalone/CMakeLists.txt:58-59` → `/usr/share/applications/symmetria-fm.desktop` | `symmetria-fm` |
| 3. `StartupWMClass` | `symmetria-fm.desktop:24` | `symmetria-fm` |

**Only the first two are load-bearing.**

- **Drift between 1 and 2** breaks Qt's `org.freedesktop.portal.Registry`
  registration. Qt registers the app with `desktopFileName()` as the id; when no
  XDG applications directory holds a matching file, the portal answers
  `Could not register app ID: App info not found for '<id>'`. When
  `setDesktopFileName` is absent **entirely**, the id is empty and the message
  shows `''`. The failure is non-fatal but real: the portal needs a resolvable app
  id to attribute requests in the permission store and to parent dialogs against
  the right window (`main.cpp:43-50`).
- **Drift in 3 (`StartupWMClass`) breaks nothing here.** It is a launcher /
  XWayland hint for associating an already-open window with the entry. It does
  **not** drive Hyprland window rules. Editing it to fix a window rule does
  nothing (`symmetria-fm.desktop:18-23`).

**What a compositor rule actually matches** is the Wayland `app_id`. Qt derives it
from `setDesktopFileName()`, falling back to the executable's basename only when
that is unset. Both are `symmetria-fm` today, so renaming the literal in
`main.cpp:57` — say, to a reverse-DNS id like `org.symmetria.FileManager` —
would **silently change the `app_id`** every window rule matches on
(`main.cpp:52-56`).

### 7.2 Install scope

The `.desktop` entry and its icon ship with the **host** build and only with it:
`host/standalone/CMakeLists.txt:58-61` installs both into the system prefix
(`/usr/share/applications` and `/usr/share/icons/hicolor/512x512/apps`).

`install.sh:53-58` actively **deletes** any `~/.local/share` copies, because the
user scope takes XDG precedence and a stale copy silently shadows the freshly
built one — this is how an `Exec=` pointing at the retired QuickShell daemon
survived the Qt6 migration.

Verify a healthy start with
`journalctl --user -u symmetria-fm --invocation=0 | grep "app ID"` — a healthy
start logs nothing. The `--invocation=0` scoping is load-bearing: without it the
query matches the hundreds of pre-fix failures still in the journal and looks
like a regression.

### 7.3 Window rules and Wayland focus

No Hyprland `windowrule` matches this class today. The documented fallback, when
Hyprland's bindings swallow keys destined for the picker, is
`windowrule = float, match:class ^(symmetria-fm)$` — note the current
`windowrule = <action>, match:<selector>` syntax, not the older
`windowrulev2 = <action>,<selector>` form. The comment inside
`host/standalone/main.qml:80-83` still shows the **old** `windowrulev2` syntax and
is out of date relative to `CLAUDE.md`.

Absent a layer-shell exclusive-focus mode (which existed only under QuickShell's
`WlrKeyboardFocus.Exclusive`), the picker relies on
`Qt.Dialog | Qt.WindowStaysOnTopHint` plus `requestActivate()`
(`main.qml:84`, `:88`).

**Port to Electron.** The `.desktop` entry, its `Exec=` line and its icon stay
exactly as they are — they are packaging, not application code. Electron's
Wayland `app_id` comes from the process/`argv[0]` and can be forced with
`--class=symmetria-fm`; it does **not** read `desktopFileName`, so the Qt
mechanism that ties the two together disappears and the two must be kept aligned
by hand. Electron also has no `setDesktopFileName` equivalent for the portal
registry, so the "App info not found" class of failure changes shape: Chromium
registers with the portal using its own logic. Focus behaviour
(`WindowStaysOnTopHint` + `requestActivate`) maps to
`BrowserWindow({alwaysOnTop: true, modal: true})` plus `win.focus()`, with the
same Hyprland caveat.

---

## 8. Port-to-Electron summary

### 8.1 Direct mappings

| Qt / Linux mechanism | Electron / Node equivalent |
|---|---|
| resident `symmetria-fm` daemon | resident Electron **main process** |
| `Window` created from a QML `Component` | `new BrowserWindow(...)` |
| `QLocalServer` on `$XDG_RUNTIME_DIR/symmetria-fm.sock` | `net.createServer()` on the same path, newline-delimited JSON |
| `symmetria-fm-cli` | small Node script using `net.connect` (**not** an Electron binary) |
| `ShellRunner` | `child_process.execFile` / `spawn` with argv arrays |
| `gio trash -- <paths>` | `shell.trashItem(path)` per path |
| `xdg-open <path>` | `shell.openPath(path)` |
| `cp -r` / `mv` | `fs.promises.cp({recursive:true})` / `fs.promises.rename` |
| `mkdir -p` / `touch` | `fs.promises.mkdir({recursive:true})` / `writeFile(…, {flag:"wx"})` |
| `test -e` probe | `fs.promises.access`, or drop it and map `EEXIST` |
| `python3 -c open(...).write(...)` FIFO writer | `fs.createWriteStream(fifoPath)` |
| `QFileSystemWatcher` in `FileSystemModel` | `chokidar` or `fs.watch` (see the two watcher pitfalls in `CLAUDE.md`) |
| `FileManagerService` singleton state | a main-process store, mirrored to renderers over `ipcMain`/`ipcRenderer` |
| `wl-copy` | `clipboard.writeText` / `writeImage`, **or** keep `systemd-run … wl-copy` |
| `bsdtar -xvf … -C …` | keep spawning `bsdtar`; count stderr lines with `readline` |
| `zoxide add` / `zoxide query` | unchanged; still an external binary |

### 8.2 What Electron makes easier

- The FIFO writer, its 5 s timeout, its failed-start handling and the busy-reject
  queue — five interlocking state machines in `host/standalone/main.qml:204-373` —
  collapse into a stream write and a promise.
- Copy conflicts and copy progress become implementable, because the copy runs
  in-process instead of inside `cp(1)`.
- Per-item trash errors become available, because `shell.trashItem` is one call
  per path rather than one `gio trash --` for the batch.
- `errorOccurred` versus `exited` disappears as a concern; Node gives one
  rejection.

### 8.3 What Electron makes harder — the three integration points

1. **The XDG portal backend.** Electron offers nothing here. Either keep the
   Python `dbus-fast` service unchanged (recommended — it only needs the socket
   and the FIFO, both native to Node) or write a second, small Node daemon with
   `dbus-next`. It cannot live inside the Electron main process without making a
   heavyweight GUI process a boot-time D-Bus dependency. The `.portal` file, the
   D-Bus activation file, `portals.conf`, the systemd units and the dotfiles
   GTK-ordering drop-in all remain hand-installed system files that no Electron
   packager produces.

2. **The Wayland clipboard lifetime.** `clipboard.writeText` makes the Electron
   main process the live selection owner, so the exact bug of §2.4 returns in a
   new shape: quit after a copy and the selection is gone. The current fix
   (`systemd-run --user --collect -- wl-copy --foreground`) detaches the holder
   into its own transient unit — a Linux/systemd/Wayland mechanism with no
   Electron API. Choose deliberately: keep shelling out to `wl-copy` (retaining
   the `wl-clipboard` dependency and the ability to advertise a specific MIME with
   `--type`), or keep the main process resident forever and accept that
   `clipboard.writeImage` loses explicit MIME control.

3. **The systemd daemon lifecycle and the desktop-integration contract.** The
   `Restart=always` + `quitOnLastWindowClosed` design, the
   `UnsetEnvironment=HL_INITIAL_WORKSPACE_TOKEN` workaround for Hyprland's
   initial-workspace tracking, the `.desktop` / `app_id` three-way contract, and
   the `Terminal=true` handler probe in `FileOpener.qml` are all
   Linux-desktop-integration work that Electron does not perform. In particular
   `shell.openPath` cannot open a terminal application correctly — it hands the
   `.desktop` entry to `xdg-open`, which is precisely the behaviour the current
   probe exists to bypass. That probe, or an equivalent `.desktop` parser in Node,
   must be carried over intact.

---

## 9. Open issues found while mapping

Recorded here so the port does not inherit them silently.

1. **`closePicker` is unreachable through the CLI.** `cli.cpp:57-76` accepts only
   `open`, `openOverlay` and `createPicker`; `symmetria_portal.py:153` calls
   `launch_fm_ipc("closePicker", …)`, which exits 2 with `unknown method`. The
   daemon-side handler (`server.cpp:137-149`) and the QML listener
   (`main.qml:170-179`) are both implemented and dead. App-initiated
   `Request.Close` therefore falls back to the 300 s FIFO timeout.
2. **The D-Bus activation file names the wrong interpreter.**
   `portal/org.freedesktop.impl.portal.desktop.symmetria.service:3` points at
   `/usr/bin/python3.12`, which lacks `dbus-fast`, and pins a point release.
   Systemd activation masks the problem today.
3. **Copy and move overwrite silently.** No conflict prompt exists anywhere in
   `_pasteAction` (`KeyRegistry.js:116-130`).
4. **Trash failures are invisible.** `DeleteConfirmPopup.qml:250-258` closes the
   dialog on failure and only logs.
5. **Two TOCTOU existence probes** — `RenamePopup.qml:185` and
   `CreateFilePopup.qml:170` — check with `test -e` and act afterwards.
6. **Picker path resolution is duplicated.**
   `FileManagerService.confirmPickerSelection` (`:136-168`) and
   `NormalModeHandler._resolvePickerPath` (`:39-55`) encode the same
   save / directory / file precedence in two places.
7. **The window-rule syntax in `main.qml:80-83` is stale** — it shows
   `windowrulev2 = float, class:^(symmetria-fm)$`, while `CLAUDE.md` documents the
   current `windowrule = float, match:class ^(symmetria-fm)$` form.
8. **Two unsynchronised copies of `symmetria-fm.service`** — the repository copy
   and a dotfiles copy.
