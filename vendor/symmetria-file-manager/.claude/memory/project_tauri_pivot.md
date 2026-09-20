---
name: project_tauri_pivot
description: The Tauri 2 (Rust + React/TS) rewrite of the FM — first deliverable of the Symmetria IDE framework pivot; current build state + architecture
metadata:
  node_type: memory
  type: project
  originSessionId: 4e08950a-d890-400a-9fb5-3dcbd6574dce
---

Symmetria IDE is pivoting its wrapper from PySide6/QML to **Tauri 2 (Rust +
React 19 + TS + Vite)**. The **File Manager is the first deliverable** because
its **file tree + git status become the IDE's reused panels**. Work is on the
**`tauri-pivot` branch**, in the **`app-tauri/` subdir** (branch + subdir =
backwards-compatible: the QML app + C++ plugin keep building/serving Symmetria
Shell during the rewrite). Authoritative pivot doc:
`/home/jc/projects/symmetria-ide/docs/framework-pivot.md`. Original relay brief:
`/home/jc/.claude/relay/20260605-170008-symmetria-file-manager-tauri-pivot.md`.

## ⚠️ Critical cautions for any session
- **NEVER touch / commit the user's two dirty QML files** (`qml/.../FileList.qml`,
  `qml/.../handlers/ChordHandler.js`) — their unrelated in-progress work. Every
  commit must be scoped to explicit `app-tauri/` (+ `.claude/`) paths; never
  `git add -A`/`.`. The daily-driver QML FM is fully isolated (installed binary
  + `/usr/lib/qt6` QML), so branch work can't break it.
- **Hyprland windowrules live OUTSIDE the repo** in machine-local
  `~/.config/hypr/workspaces.conf` (3 rules for class `symmetria-fm-tauri`:
  `workspace 7 silent`, `no_initial_focus true`, `render_unfocused true`). They
  won't survive a dotfiles rebuild. Hyprland **0.55 syntax**: underscore rule
  names + boolean `true` (the old `noinitialfocus`/`suppressevent` are invalid);
  validate live with `hyprctl keyword windowrule "<rule>"` (reports errors
  without a reload). Current wiki: `wiki.hypr.land/Configuring/Basics/Window-Rules/`.

## What's BUILT (as of HEAD `faf5209`, 2026-06-06)
A working keyboard-first file manager — **Yazi-style Miller columns** main view:
- Browse: parent · current · preview panes; vim nav `j/k/h/l`, `gg/G`,
  `Ctrl-d/u` (half page, density-measured), `Ctrl-f/b` (full page), `~` home.
- **Goto which-key palette**: while the `g` chord is armed, the parent (left)
  column shows a which-key menu ("g go to" → Top + every bookmark with a keycap +
  Material Symbols icon + label, then New/Delete bookmark), mirroring the QML
  `WhichKeyPopup`. `gn`/`gx` reuse the same panel (it owns the keyboard + captures
  the letter — replaced the old footer prompt). `src/bookmarks/gotoMenu.ts` =
  pure model builder + `iconForPath` (mirrors `WindowState.chordBindings` +
  `BookmarkService.iconForPath`); `src/components/GotoMenu/`. FileList surfaces
  the armed state via `onChordArmedChange(armed)` (kept as a ref on the hot path).
  **First use of the `--fm-font-material` token** (Material Symbols Rounded,
  system-installed) — icons render via OpenType **ligatures** (the icon NAME is
  the text content). `opacity` compounds, so the parent column's 0.85 dim is
  *lifted* (`--undimmed`) when the menu shows, not just overridden.
- **Goto bookmarks** (`g<key>` chord → navigate to a saved dir; `gn`/`gx` =
  create/delete via a single-key capture prompt; `gg` stays jump-to-top). Ported
  from the QML FM's BookmarkService and **reads/writes the SAME
  `~/.config/symmetria-fm/bookmarks.json`** (format `{key:{path,label}}`), so
  destinations stay in sync across both apps (user's set: h/d/p/s/v/a/t). Rust
  `bookmarks.rs` (`load_bookmarks` returns `Option` map → null on first run so the
  frontend seeds Home+Downloads; `save_bookmarks` pretty-prints to match the QML
  writer). Seam: `BookmarkStore` iface + `tauriBookmarkStore` + `useBookmarks`
  hook (write-through), injected at the app root like FileSystemSource. FileList
  stays generic via an optional `onGotoChord(key)` prop (gg internal; host
  lowercases + resolves). **Chord-modality pitfall** (seal fix `faf5209`): the
  bookmark prompt's keydown bubbles to `onRootKeyDown`, which must early-return on
  `bookmarkMode` (not just `action`) or `d`/`r`/`a`/`.` fire trash/rename/etc.
  while binding — any future modal sub-mode needs the same guard.
- **Top toolbar** (single QML-style chrome row, owns the window drag region):
  back/forward (real history stack in MillerColumns — `nav` = `{history,index}`,
  one atomic state object so updates are batch-safe), clickable breadcrumb path,
  hidden-files **eye toggle**. `.` still toggles hidden too.
- **Bottom status bar**: item count (+ hidden flag), focused entry name,
  home-relative path (`~/…` via `homeRelativePath` in fs/format.ts).
- **Themed XDG icons** (the "Symmetria icons system" = the user's active GTK icon
  theme, literally named `Symmetria`, which `Inherits=MacTahoe-grey-dark,hicolor,
  breeze`). Rust port of the QML FM's C++ `IconThemeResolver` lives in
  `src-tauri/src/icons.rs`: `icon_name_for_path` (path→XDG icon name via the
  `xdg-mime` crate / shared-mime-info, computed per entry in `list_dir` as
  `FsEntry.iconName`) + the `icon_data_uri` command (name→cached base64 `data:`
  URI via the `freedesktop-icons` crate — theme + `Inherits` chain + scalable).
  Active theme read from gsettings → GTK3 settings.ini → hicolor. Frontend seam:
  optional `FileSystemSource.iconDataUri` + `useIconCache` (fetch-once provider,
  `iconFor(name)`) threaded MillerColumns→FileList (statusProvider-shaped);
  FileList renders `<img>`, Nerd-glyph fallback while loading / when unthemed.
  **Gotcha**: never wrap `.svgz` as `image/svg+xml` (gzip bytes → unrenderable
  data URI); it must fall through to `.svg`/`.png`. The Nerd Font glyphs
  (`\u` escapes — raw PUA literals get silently stripped) remain the fallback.
- **No active-column focus ring** — the host's global `:focus-visible` box was an
  IDE pane-switch affordance; meaningless here (active col is always middle), so
  `.fm-filelist:focus-visible` suppresses it. Cursor-row highlight marks active.
- Open files on `l`/`Enter` via tauri-plugin-opener.
- **Actions**: `r` rename, `a`/`A` new file/dir, `d`/`D` trash (y/n confirm in a
  footer action bar). Recoverable trash via the Rust `trash` crate.
- **Live auto-refresh**: a `notify` directory watcher (verified working) — any
  external change refreshes the view.
- Transparent decorationless window; Symmetria aesthetic via CSS variables.

NOT yet built: permanent delete, file preview (right pane is filename-only for
files / dir-listing for dirs), the **nested tree** (task 6, the IDE-reused
panel — port of `qml/.../FileTreeView.qml`), and **git status** (task 5).

## Architecture map (key files / roles)
- `src-tauri/src/fs.rs` — `list_dir` + mutations `rename_entry`/`trash_entry`/
  `create_entry`. Entry shape mirrors QML `FileSystemEntry`. **Regression guard
  in-file**: do NOT add `#[tauri::command(rename_all="snake_case")]` — Tauri's
  default is camelCase; snake_case breaks the JS→Rust param contract at runtime.
- `src-tauri/src/watcher.rs` — notify watcher in Tauri-managed `WatcherState`;
  `watch_dir(path)` re-arms (replaces) the watch, emits `fs-change` events.
- `src/fs/source.ts` — **`FileSystemSource` interface = the reuse seam**:
  `listDir`, `rename`, `trash`, `create`, optional `watch`. Components depend on
  THIS, never on Tauri directly. `src/data/tauriFileSource.ts` is the standalone
  app's Tauri-backed impl (injected at the App root); the IDE injects its own.
- `src/fs/useListing.ts` — caller-owned-path data hook (null path = disabled
  column); `reloadKey` forces refetch; clears listing ONLY on path change (so
  watcher/mutation reloads refresh in place, no flicker).
- `src/components/FileList/FileList.tsx` — presentational, CONTROLLED-cursor
  column (cursor/active/onCursorChange props); keyboard runs only when `active`;
  keymap is registry-shaped (key→command) for the future IDE command-gate.
  **VIRTUALIZED** (`@tanstack/react-virtual`, commit `c8421e8`) — only viewport
  rows get DOM nodes, mirroring QML's `ListView`. Without it a ~560-entry dir
  (Downloads) was very laggy: a DOM node per entry + full re-reconcile per
  cursor move. Memoized so inactive columns skip re-render. **The nested tree
  (task 6) MUST virtualize the same way** — it's the same large-list problem.
  Miller's preview path is **debounced 120ms** (MillerColumns.tsx) so fast j/k
  doesn't storm `list_dir`; the pane is gated on debounced===cursor to avoid
  flashing the previous dir. Cursor input is also **frame-coalesced** (commit
  `e0e7b98`): each keydown bumps an intended-cursor ref, a single rAF flushes
  the net position once per frame — without this, held j/k backed up the event
  loop and overshot after release. The tree must do this too.
- `src/components/MillerColumns/MillerColumns.tsx` — the navigation CONTROLLER:
  owns path/cursor/showHidden/action; renders 3 FileLists (active middle);
  app-level keys (`.`/`~`/`r`/`a`/`A`/`d`) bubble up from the unclaimed-key path.
- `src/theme/{tokens.css,theme.ts,global.css}` — CSS-variable theme (the shared
  visual contract); `applyColorScheme()` ingests color-scheme.json (wallpaper).

## Decisions
- Reimplement FS in **Rust** (the C++ FileSystemModel is Qt-bound; reusing it
  drags Qt back in). Standalone main view = **Miller columns** (per user).
- **Reuse contract** (most important): file tree + git status are self-contained,
  prop-driven React components with an **injectable data source** — mirror the
  QML `FileTreeView` duck-typed extension points: `statusProvider`
  (statusForPath→{char,color,adds,dels} + statusChanged), `ignoredPathSet`,
  `pathFilter`, `compactScale`.
- Window: transparent + decorationless, **default WebKitGTK rendering** — do NOT
  set `WEBKIT_DISABLE_DMABUF_RENDERER`/`COMPOSITING_MODE`. Tauri **2.11.2**;
  window class **`symmetria-fm-tauri`** (distinct from QML's `symmetria-fm`);
  identifier com.symmetria.filemanager; binary renamed so the class is clean.

## Process
- Every feature is committed then sealed via `/seal` (commit→review→fix→commit),
  scoped to exclude the QML files. **Sealed through HEAD** `faf5209` — recent
  Retro-Seals: UI-chrome `02e1b63..09853d1` (fix `6454d21`; atomic `nav` object),
  themed-icons `bae282b..a1e8b58` (fix `551d9a3`; reject `.svgz` data URIs), and
  goto-bookmarks `7692ad7` (fix `faf5209`; the bookmarkMode root-key guard), and
  the goto which-key palette `f9f4c7f` (fix `fc21e38`; panel width overflow +
  create-mode orphan separator + role=region).
  Run/test on Hyprland ws7 silently — see [[feedback_tauri_testing_workflow]].
- **Keyboard features can't be verified via synthetic input** in this setup:
  `hyprctl dispatch sendshortcut` goes to Hyprland's keybind layer (never becomes
  a `wl_keyboard` event on the surface, so the WebKitGTK DOM / React onKeyDown
  never sees it), and `wtype` renegotiates the keymap (NumLock/layout churn) so
  the key arrives under a transient layout. Verified by sending `j`×5 → cursor did
  not move. Screenshots verify STATIC rendering only; keyboard-driven behavior =
  unit tests + the user's real-keyboard pass. So the goto chords + which-key menu
  + Material Symbols ligature rendering are committed + unit-sealed but **awaiting
  the user's real-keyboard confirmation** (the app loads cleanly with the changes).
- **Verify UI visually** with `scripts/screenshot-ws7.sh /tmp/x.png`, but note it
  captures the window ISOLATED on a headless output (no wallpaper behind the
  transparent panels) → everything reads near-black/dim in the capture; muted
  glyphs (folder icons, the eye) look invisible there yet are fine on the real
  wallpapered desktop. Brighten crops (`magick … -auto-level -gamma 2.2`) or
  sample pixel maxima to disambiguate "dim" from "absent".

## Next steps (tasks 5 + 6, recommended next)
1. **Nested tree** — port `FileTreeView.qml` as a React component over the same
   FileSystemSource + the statusProvider/ignoredPathSet/pathFilter/compactScale
   seams. THE IDE-reused panel.
2. **Git status** — shell out to `git` (Terax-style, no libgit2); feed badges
   through the `statusProvider` contract (lights up both Miller + the tree).
3. Standalone polish: permanent delete, file preview (text/image) in right pane.
