// KeyRegistry.js — the single source of truth for NORMAL-MODE keybindings.
//
// Both the keyboard DISPATCHER and the help popup (HelpPopup.qml) read this one
// array, so a binding added here automatically (a) works and (b) appears in the
// cheat-sheet. This finishes the data-driven keymap the chord system started
// (_staticChordBindings in WindowState.qml).
//
// NOT pragma-library ON PURPOSE. A `.pragma library` script has no QML scope and
// cannot see `Qt` or singletons (documented at TreeFlashHandler.js, and why
// FileOpsHandler.js — which uses Qt.Key_* — has no pragma line). This module is
// imported by BOTH FileList.qml and FileTreeView.qml; its references therefore
// resolve through the IMPORTING view's scope. That is the mechanism that lets a
// TREE_ONLY row call TreeModel.* (resolves in FileTreeView scope) and a
// MILLER_ONLY row call NormalModeHandler.* (resolves in FileList scope), while
// CORE rows touch only symbols present in BOTH scopes.
//
// DEPENDENCY INJECTION. Singletons the dispatch DECISION and the op run-bodies
// need (FileManagerService, Config, Paths) are passed in via `ctx.services`, NOT
// referenced as globals. This keeps dispatch() hermetically testable: the test
// passes stub services and never loads the real UI module. The only run-bodies
// that still reach through scope are the genuinely view-specific ones
// (NormalModeHandler._jumpToDirFileBoundary, TreeModel.*) — those are exercised
// at runtime; the routing test covers their MATCH via matchBinding() without
// executing them.
//
// SCOPE OF THIS MODULE — it covers only normal-mode key→command bindings. The
// following are MODES, not bindings, and stay as dedicated handlers OUTSIDE the
// registry (they contribute static help rows, not registry rows):
//   • the outer Keys.onPressed cascade (modal → bookmarkSubMode → chord
//     RESOLUTION → flash) — unchanged; dispatch() replaces only the final
//     normal-mode switch.
//   • picker-mode suppression / picker-Escape — handled as a PRE-PASS inside
//     dispatch (ported from FileOpsHandler.tryHandle), not as bindings.
//   • flash-jump, incremental search, bookmark sub-mode — text-input modes.
//   • the windowState-less embedded tree path (IDE sidebar) — bypasses the
//     registry entirely; TreeKeyHandler keeps its legacy nav-only switch + gg
//     timer for that case.
//
// ── ctx contract ─────────────────────────────────────────────────────────────
// Each view builds `ctx` in its Keys.onPressed before calling dispatch():
//   ctx = {
//     root,                 // the view's root Item (FileList / FileTreeView)
//     view,                 // the inner ListView
//     windowState,          // WindowState instance (never null when dispatching)
//     viewKind,             // "miller" | "tree"
//     pasteProcess,         // PasteRunner
//     clipboardCopyProcess, // ClipboardCopyRunner (picker path-copy)
//     services: { fileManager, config, paths },  // injected singletons
//     // --- view adapter (the only view-divergent capabilities) ---
//     activateCurrent(),    // open/enter the current item
//     halfPageCount(),      // rows per half page (view-specific metric)
//     nav(fn),              // run fn as a navigation (miller: save-cursor; tree: passthrough)
//     invalidateFlashCache() // reset the view's flash entry cache
//   }
//
// ── binding shape ────────────────────────────────────────────────────────────
//   { id, keys:[Qt.Key_*...], mods, keycap, label, icon, group,
//     when?(ctx)->bool, run(ctx) }
//   mods ∈ "" | "Ctrl" | "Shift" | "Alt" | "Ctrl+Shift" | "*"  ("*" = ignore modifiers)
//   keycap is the human display string; label/icon/group drive the help UI.
//   when() gates EXECUTION only (a false when() returns "not consumed" so the key
//   falls through, exactly like today's n/N guards) — it does NOT hide the row
//   from help. View scoping is by membership in CORE / MILLER_ONLY / TREE_ONLY.
//
// ── SYMBOL KEYS MUST USE mods: "*" (load-bearing) ────────────────────────────
//   A binding on a PUNCTUATION/SYMBOL glyph (`/ ? ~ - = [ ] . ,` …) must use
//   mods: "*", NOT mods: "". The modifiers that PRODUCE a glyph are
//   layout-dependent: on the Spanish Latin-American layout `/` is Shift+7 and
//   `=` is Shift+0, so the event arrives as e.g. Qt.Key_Slash + ShiftModifier.
//   A strict mods: "" match rejects it and the key silently does nothing — this
//   is exactly the regression that broke `/`-search after the registry landed
//   (the old switch matched on event.key alone, ignoring modifiers). Letter and
//   real chord bindings (Ctrl/Shift/Alt + key) keep their precise mods because
//   THERE the modifier is the user's intent, not a side effect of the layout.
//   The (key,mods) collision test guards "*" from clashing with a real chord.
//   tst_keyregistry.qml fires these glyphs WITH Shift to lock the rule in.

// Keys suppressed in picker mode — ported from FileOpsHandler.js. Clipboard ops
// don't belong in a file chooser. Key_C is intentionally absent (it starts the
// harmless copy-path chord); Ctrl+V is handled separately below.
var _PICKER_SUPPRESSED_KEYS = [Qt.Key_Y, Qt.Key_X, Qt.Key_P, Qt.Key_Space,
    Qt.Key_T, Qt.Key_BracketLeft, Qt.Key_BracketRight];

// ── Shared op helpers (single definition; reused by multiple rows) ────────────

function _deleteAction(ctx) {
    var ws = ctx.windowState;
    if (ws.selectedCount > 0) {
        ws.requestDelete(ws.getSelectedPathsArray());
        ws.clearSelection();
    } else if (ctx.root.currentEntry) {
        ws.requestDelete([ctx.root.currentEntry.path]);
    }
}

function _yankAction(ctx) {
    var ws = ctx.windowState;
    if (ws.selectedCount > 0) {
        ctx.services.fileManager.yank(ws.getSelectedPathsArray());
        ws.clearSelection();
    } else if (ctx.root.currentEntry) {
        ctx.services.fileManager.yank([ctx.root.currentEntry.path]);
    }
}

function _cutAction(ctx) {
    var ws = ctx.windowState;
    if (ws.selectedCount > 0) {
        ctx.services.fileManager.cut(ws.getSelectedPathsArray());
        ws.clearSelection();
    } else if (ctx.root.currentEntry) {
        ctx.services.fileManager.cut([ctx.root.currentEntry.path]);
    }
}

function _pasteAction(ctx) {
    var fm = ctx.services.fileManager;
    if (fm.clipboardPaths.length === 0 || ctx.pasteProcess.running)
        return;
    var paths = fm.clipboardPaths;
    var destDir = ctx.root.fileOpsTargetDir();
    // Focus the first pasted item after the model refreshes.
    ctx.root.setPendingPasteFocus(ctx.services.paths.basename(paths[0]));
    // cp and mv both accept multiple source args before a single destination.
    if (fm.clipboardMode === "yank")
        ctx.pasteProcess.command = ["cp", "-r", "--"].concat(paths).concat([destDir]);
    else
        ctx.pasteProcess.command = ["mv", "--"].concat(paths).concat([destDir]);
    ctx.pasteProcess.start();
}

function _toggleSelectionAction(ctx) {
    var ws = ctx.windowState;
    var fm = ctx.services.fileManager;
    var root = ctx.root, view = ctx.view;
    if (!root.currentEntry)
        return;
    // Picker type-filter: a file picker marks only files, a dir picker only dirs.
    // pickerFileOps (full-ops host) and save mode opt out. Mirrors FileOpsHandler.
    if (fm.pickerMode && !fm.pickerSaveMode && !fm.pickerFileOps
            && fm.pickerDirectory !== root.currentEntry.isDir)
        return;
    ws.toggleSelection(root.currentEntry.path);
    if (view.currentIndex < view.count - 1)
        view.currentIndex++;
}

// ── CORE: identical in both views (shared section of the help) ────────────────

var CORE = [
    // Navigation
    { id: "nav.down", keys: [Qt.Key_J, Qt.Key_Down], mods: "", keycap: "j  ↓",
      label: "Move down", icon: "keyboard_arrow_down", group: "Navigation",
      run: function(ctx) { if (ctx.view.currentIndex < ctx.view.count - 1) ctx.view.currentIndex++; } },
    { id: "nav.up", keys: [Qt.Key_K, Qt.Key_Up], mods: "", keycap: "k  ↑",
      label: "Move up", icon: "keyboard_arrow_up", group: "Navigation",
      run: function(ctx) { if (ctx.view.currentIndex > 0) ctx.view.currentIndex--; } },
    { id: "nav.bottom", keys: [Qt.Key_G], mods: "Shift", keycap: "G",
      label: "Jump to bottom", icon: "vertical_align_bottom", group: "Navigation",
      run: function(ctx) {
          if (ctx.view.count > 0) {
              ctx.view.currentIndex = ctx.view.count - 1;
              ctx.view.positionViewAtIndex(ctx.view.count - 1, ListView.End);
          }
      } },
    { id: "nav.activate", keys: [Qt.Key_Return, Qt.Key_Enter], mods: "", keycap: "⏎",
      label: "Open / enter", icon: "subdirectory_arrow_left", group: "Navigation",
      run: function(ctx) { ctx.activateCurrent(); } },
    { id: "nav.halfDown", keys: [Qt.Key_D], mods: "Ctrl", keycap: "⌃d",
      label: "Half-page down", icon: "keyboard_double_arrow_down", group: "Navigation",
      run: function(ctx) {
          if (ctx.view.count > 0) {
              ctx.view.currentIndex = Math.min(ctx.view.currentIndex + ctx.halfPageCount(), ctx.view.count - 1);
              ctx.view.positionViewAtIndex(ctx.view.currentIndex, ListView.Contain);
          }
      } },
    { id: "nav.halfUp", keys: [Qt.Key_U], mods: "Ctrl", keycap: "⌃u",
      label: "Half-page up", icon: "keyboard_double_arrow_up", group: "Navigation",
      run: function(ctx) {
          if (ctx.view.count > 0) {
              ctx.view.currentIndex = Math.max(ctx.view.currentIndex - ctx.halfPageCount(), 0);
              ctx.view.positionViewAtIndex(ctx.view.currentIndex, ListView.Contain);
          }
      } },

    // History
    { id: "hist.back", keys: [Qt.Key_S], mods: "Shift", keycap: "⇧S",
      label: "Back", icon: "arrow_back", group: "History",
      run: function(ctx) { ctx.nav(function() { ctx.windowState.back(); }); } },
    { id: "hist.forward", keys: [Qt.Key_D], mods: "Shift", keycap: "⇧D",
      label: "Forward", icon: "arrow_forward", group: "History",
      run: function(ctx) { ctx.nav(function() { ctx.windowState.forward(); }); } },

    // File operations
    { id: "op.delete", keys: [Qt.Key_D], mods: "", keycap: "d",
      label: "Trash", icon: "delete", group: "File",
      run: _deleteAction },
    { id: "op.rename", keys: [Qt.Key_R], mods: "", keycap: "r",
      label: "Rename", icon: "drive_file_rename_outline", group: "File",
      run: function(ctx) { if (ctx.root.currentEntry) ctx.windowState.requestRename(ctx.root.currentEntry.path, false); } },
    { id: "op.create", keys: [Qt.Key_A], mods: "", keycap: "a",
      label: "New file / folder", icon: "add", group: "File",
      run: function(ctx) { ctx.windowState.requestCreate(ctx.root.fileOpsTargetDir()); } },
    { id: "op.pickerSaveEdit", keys: [Qt.Key_R], mods: "Ctrl", keycap: "⌃r",
      label: "Edit save name", icon: "edit_note", group: "File",
      when: function(ctx) { return ctx.services.fileManager.pickerSaveMode; },
      run: function(ctx) { ctx.services.fileManager.saveNameEditing = true; } },

    // Clipboard
    { id: "clip.yank", keys: [Qt.Key_Y], mods: "", keycap: "y",
      label: "Yank (copy)", icon: "content_copy", group: "Clipboard",
      run: _yankAction },
    { id: "clip.cut", keys: [Qt.Key_X], mods: "", keycap: "x",
      label: "Cut", icon: "content_cut", group: "Clipboard",
      run: _cutAction },
    { id: "clip.paste", keys: [Qt.Key_P], mods: "", keycap: "p",
      label: "Paste", icon: "content_paste", group: "Clipboard",
      run: _pasteAction },
    { id: "clip.pasteCtrl", keys: [Qt.Key_V], mods: "Ctrl", keycap: "⌃v",
      label: "Paste", icon: "content_paste", group: "Clipboard",
      run: _pasteAction },

    // Selection
    { id: "sel.toggle", keys: [Qt.Key_Space], mods: "", keycap: "␣",
      label: "Select / mark", icon: "check_box", group: "Selection",
      run: _toggleSelectionAction },
    { id: "sel.clear", keys: [Qt.Key_Escape], mods: "", keycap: "Esc",
      label: "Clear selection", icon: "deselect", group: "Selection",
      when: function(ctx) { return ctx.windowState.selectedCount > 0; },
      run: function(ctx) { ctx.windowState.clearSelection(); } },

    // Search & jump
    // mods: "*" (not "") — `/` is a SYMBOL key whose producing modifiers are
    // LAYOUT-DEPENDENT. On the Spanish Latin-American layout `/` is Shift+7, so
    // the event arrives as Qt.Key_Slash WITH Qt.ShiftModifier; a strict mods: ""
    // match would reject it and search would silently do nothing. See the
    // "Symbol keys" note in the header — all glyph bindings (`/ - = [ ] . ,`) use "*".
    { id: "search.start", keys: [Qt.Key_Slash], mods: "*", keycap: "/",
      label: "Search", icon: "search", group: "Search & jump",
      run: function(ctx) { ctx.root._preSearchIndex = ctx.view.currentIndex; ctx.windowState.startSearch(); } },
    { id: "match.next", keys: [Qt.Key_N], mods: "", keycap: "n",
      label: "Next match", icon: "arrow_downward", group: "Search & jump",
      when: function(ctx) { return !ctx.windowState.searchActive && ctx.windowState.matchIndices.length > 0; },
      run: function(ctx) { ctx.windowState.nextMatch(); } },
    { id: "match.prev", keys: [Qt.Key_N], mods: "Shift", keycap: "⇧N",
      label: "Previous match", icon: "arrow_upward", group: "Search & jump",
      when: function(ctx) { return !ctx.windowState.searchActive && ctx.windowState.matchIndices.length > 0; },
      run: function(ctx) { ctx.windowState.previousMatch(); } },
    { id: "flash.enter", keys: [Qt.Key_S], mods: "", keycap: "s",
      label: "Flash jump", icon: "bolt", group: "Search & jump",
      run: function(ctx) {
          ctx.root._preFlashIndex = ctx.view.currentIndex;
          ctx.invalidateFlashCache();
          ctx.windowState.startFlash();
      } },
    { id: "finder.fuzzy", keys: [Qt.Key_F], mods: "", keycap: "f",
      label: "Fuzzy finder", icon: "manage_search", group: "Search & jump",
      run: function(ctx) {
          if (ctx.viewKind === "miller")
              ctx.windowState.saveCursor(ctx.windowState.currentPath, ctx.view.currentIndex);
          ctx.windowState.requestFuzzyFinder();
      } },

    // Chord prefixes (resolution lives in the outer cascade / ChordHandler)
    { id: "chord.go", keys: [Qt.Key_G], mods: "", keycap: "g",
      label: "Go to / bookmarks…", icon: "explore", group: "Chords",
      run: function(ctx) { ctx.windowState.activeChordPrefix = "g"; } },
    { id: "chord.copy", keys: [Qt.Key_C], mods: "", keycap: "c",
      label: "Copy to clipboard…", icon: "content_copy", group: "Chords",
      run: function(ctx) { ctx.windowState.activeChordPrefix = "c"; } },
    // mods: "*" — symbol key (see search.start). Base-level on latam, but the
    // "all symbol glyphs use *" invariant keeps it layout-robust; no chord uses ,.
    { id: "chord.sort", keys: [Qt.Key_Comma], mods: "*", keycap: ",",
      label: "Sort by…", icon: "sort", group: "Chords",
      run: function(ctx) { ctx.windowState.activeChordPrefix = ","; } },

    // View
    { id: "view.toggle", keys: [Qt.Key_E], mods: "Ctrl", keycap: "⌃e",
      label: "Toggle Miller / tree view", icon: "account_tree", group: "View",
      run: function(ctx) { ctx.windowState.toggleViewMode(); } },

    // Help
    { id: "help.open", keys: [Qt.Key_Question], mods: "*", keycap: "?",
      label: "Keyboard help", icon: "help", group: "Help",
      run: function(ctx) { ctx.windowState.openHelp(); } }
];

// ── MILLER_ONLY: Miller-columns view bindings ─────────────────────────────────

var MILLER_ONLY = [
    { id: "miller.up", keys: [Qt.Key_H, Qt.Key_Left], mods: "", keycap: "h  ←",
      label: "Up a directory", icon: "arrow_back", group: "Navigation",
      run: function(ctx) { ctx.nav(function() { ctx.windowState.goUp(); }); } },
    { id: "miller.into", keys: [Qt.Key_L, Qt.Key_Right], mods: "", keycap: "l  →",
      label: "Enter directory", icon: "arrow_forward", group: "Navigation",
      run: function(ctx) { ctx.root._navigateIntoCurrentItem(); } },
    { id: "miller.contextMenu", keys: [Qt.Key_Return, Qt.Key_Enter], mods: "Ctrl", keycap: "⌃⏎",
      label: "Context menu", icon: "more_horiz", group: "Navigation",
      run: function(ctx) {
          if (ctx.root.currentEntry && !ctx.root.currentEntry.isDir)
              ctx.windowState.requestContextMenu(ctx.root.currentEntry.path, ctx.root.currentEntry.mimeType);
      } },
    { id: "miller.shiftEnter", keys: [Qt.Key_Return, Qt.Key_Enter], mods: "Shift", keycap: "⇧⏎",
      label: "Open (copy path in picker)", icon: "content_paste_go", group: "Navigation",
      run: function(ctx) {
          // In a picker, copy the chosen path to the clipboard, then confirm —
          // the activate runs inside the wl-copy exit callback so the picker
          // window stays open until the clipboard write completes. Outside a
          // picker, Shift+Enter is a plain open (mirrors the old switch).
          if (ctx.services.fileManager.pickerMode)
              NormalModeHandler._copyPickerPathToClipboard(ctx.root, ctx.clipboardCopyProcess,
                  function() { ctx.root._activateCurrentItem(); });
          else
              ctx.root._activateCurrentItem();
      } },
    { id: "miller.tabBoundary", keys: [Qt.Key_Tab], mods: "", keycap: "⇥",
      label: "Jump dir / file boundary", icon: "swap_vert", group: "Navigation",
      run: function(ctx) { NormalModeHandler._jumpToDirFileBoundary(ctx.root, ctx.view); } },
    { id: "miller.escapeSwallow", keys: [Qt.Key_Escape], mods: "", keycap: "Esc",
      label: "Dismiss", icon: "close", group: "Navigation",
      run: function(ctx) { /* swallow stray Escape so it doesn't propagate */ } },

    // History aliases
    { id: "miller.home", keys: [Qt.Key_AsciiTilde], mods: "*", keycap: "~",
      label: "Go home", icon: "home", group: "History",
      run: function(ctx) { ctx.nav(function() { ctx.windowState.navigate(ctx.services.paths.home); }); } },
    // mods: "*" — symbol keys (see search.start). On latam `=` is Shift+0 and
    // `-` is base, but both are glyph bindings so neither should care about the
    // producing modifier; no chord uses `-`/`=`, so "*" can't collide.
    { id: "miller.back", keys: [Qt.Key_Minus], mods: "*", keycap: "-",
      label: "Back", icon: "arrow_back", group: "History",
      run: function(ctx) { ctx.nav(function() { ctx.windowState.back(); }); } },
    { id: "miller.forward", keys: [Qt.Key_Equal], mods: "*", keycap: "=",
      label: "Forward", icon: "arrow_forward", group: "History",
      run: function(ctx) { ctx.nav(function() { ctx.windowState.forward(); }); } },

    // File
    { id: "miller.renameExt", keys: [Qt.Key_R], mods: "Shift", keycap: "⇧R",
      label: "Rename (with extension)", icon: "edit", group: "File",
      run: function(ctx) { if (ctx.root.currentEntry) ctx.windowState.requestRename(ctx.root.currentEntry.path, true); } },

    // View
    // mods: "*" — symbol key (see search.start); base-level on latam, kept
    // robust per the "all symbol glyphs use *" invariant.
    { id: "miller.toggleHidden", keys: [Qt.Key_Period], mods: "*", keycap: ".",
      label: "Toggle hidden files", icon: "visibility", group: "View",
      run: function(ctx) { ctx.services.config.fileManager.showHidden = !ctx.services.config.fileManager.showHidden; ctx.services.config.save(); } },
    // Render HTML in WebEngine vs. show highlighted source. when()-gated to HTML
    // files so Ctrl+R falls through (not consumed) on anything else — and so it
    // never clashes with op.pickerSaveEdit (also Ctrl+R, gated on pickerSaveMode,
    // scanned earlier in CORE, so it wins in a save picker). See HtmlPreview.qml.
    { id: "miller.htmlRender", keys: [Qt.Key_R], mods: "Ctrl", keycap: "⌃r",
      label: "Render HTML preview", icon: "html", group: "View",
      when: function(ctx) { return !!ctx.root.currentEntry
          && ctx.services.fileManager.isHtmlFile(ctx.root.currentEntry.mimeType); },
      run: function(ctx) { ctx.windowState.toggleHtmlRender(); } },

    // Search & jump
    { id: "miller.zoxide", keys: [Qt.Key_Z], mods: "", keycap: "z",
      label: "Zoxide jump", icon: "history", group: "Search & jump",
      run: function(ctx) {
          ctx.windowState.saveCursor(ctx.windowState.currentPath, ctx.view.currentIndex);
          ctx.windowState.requestZoxide();
      } },

    // Tools
    { id: "miller.audioToggle", keys: [Qt.Key_P], mods: "Ctrl", keycap: "⌃p",
      label: "Play / pause audio", icon: "play_circle", group: "Tools",
      run: function(ctx) { ctx.windowState.audioPlaybackToggle(); } },

    // Tabs
    { id: "miller.tabNew", keys: [Qt.Key_T], mods: "", keycap: "t",
      label: "New tab", icon: "add", group: "Tabs",
      run: function(ctx) { if (ctx.root.tabManager) ctx.root.tabManager.createTab(ctx.windowState.currentPath); } },
    { id: "miller.tabClose", keys: [Qt.Key_Q], mods: "Ctrl", keycap: "⌃q",
      label: "Close tab", icon: "close", group: "Tabs",
      run: function(ctx) {
          if (!ctx.root.tabManager) return;
          ctx.windowState.saveCursor(ctx.windowState.currentPath, ctx.view.currentIndex);
          if (!ctx.root.tabManager.closeTab(ctx.root.tabManager.activeIndex))
              ctx.root.closeRequested();
      } },
    // mods: "*" — symbol keys (see search.start). On latam `[`/`]` need Shift or
    // AltGr; the Ctrl+Tab / Ctrl+Shift+Tab tab-cycling bindings below use
    // different KEYS (Tab/Backtab), so "*" here can't collide with them.
    { id: "miller.tabPrev", keys: [Qt.Key_BracketLeft], mods: "*", keycap: "[",
      label: "Previous tab", icon: "chevron_left", group: "Tabs",
      run: function(ctx) { if (ctx.root.tabManager) ctx.root.tabManager.prevTab(); } },
    { id: "miller.tabNext", keys: [Qt.Key_BracketRight], mods: "*", keycap: "]",
      label: "Next tab", icon: "chevron_right", group: "Tabs",
      run: function(ctx) { if (ctx.root.tabManager) ctx.root.tabManager.nextTab(); } },
    { id: "miller.tabNextCtrl", keys: [Qt.Key_Tab], mods: "Ctrl", keycap: "⌃⇥",
      label: "Next tab", icon: "chevron_right", group: "Tabs",
      run: function(ctx) { if (ctx.root.tabManager) ctx.root.tabManager.nextTab(); } },
    { id: "miller.tabPrevCtrl", keys: [Qt.Key_Backtab], mods: "Ctrl+Shift", keycap: "⌃⇧⇥",
      label: "Previous tab", icon: "chevron_left", group: "Tabs",
      run: function(ctx) { if (ctx.root.tabManager) ctx.root.tabManager.prevTab(); } }
];

// ── TREE_ONLY: tree view bindings ─────────────────────────────────────────────

var TREE_ONLY = [
    { id: "tree.collapseOrParent", keys: [Qt.Key_H, Qt.Key_Left], mods: "", keycap: "h  ←",
      label: "Collapse / parent", icon: "chevron_left", group: "Navigation",
      run: function(ctx) {
          var row = ctx.root.currentRow;
          if (row && row.isDir && row.expanded) TreeModel.collapse(ctx.root, row.path);
          else TreeModel.jumpToParent(ctx.root);
      } },
    { id: "tree.expandOrActivate", keys: [Qt.Key_L, Qt.Key_Right], mods: "", keycap: "l  →",
      label: "Expand / open", icon: "chevron_right", group: "Navigation",
      run: function(ctx) {
          var row = ctx.root.currentRow;
          if (!row) return;
          if (row.isDir) {
              if (!row.expanded) TreeModel.expand(ctx.root, row.path);
              else if (ctx.view.currentIndex + 1 < ctx.view.count) ctx.view.currentIndex++;
          } else {
              ctx.root.fileActivated(row.path);
          }
      } },
    { id: "tree.toggleExpand", keys: [Qt.Key_O], mods: "", keycap: "o",
      label: "Toggle expand", icon: "unfold_more", group: "Navigation",
      run: function(ctx) {
          var row = ctx.root.currentRow;
          if (row && row.isDir) TreeModel.toggle(ctx.root, row.path);
      } },

    // View
    { id: "tree.toggleHidden", keys: [Qt.Key_H], mods: "Shift", keycap: "⇧H",
      label: "Toggle hidden files", icon: "visibility", group: "View",
      run: function(ctx) { ctx.root.showHiddenToggleRequested(); } },
    // mods: "*" — symbol key (see search.start); base-level on latam, kept
    // robust per the "all symbol glyphs use *" invariant.
    { id: "tree.toggleGitignore", keys: [Qt.Key_Period], mods: "*", keycap: ".",
      label: "Toggle .gitignore filter", icon: "rule", group: "View",
      run: function(ctx) { ctx.root.respectGitignore = !ctx.root.respectGitignore; } },
    { id: "tree.refreshAll", keys: [Qt.Key_R], mods: "Shift", keycap: "⇧R",
      label: "Refresh tree", icon: "refresh", group: "View",
      run: function(ctx) { TreeModel.refreshAll(ctx.root); } }
];

// ── Public API ────────────────────────────────────────────────────────────────

function bindingsFor(viewKind) {
    return CORE.concat(viewKind === "tree" ? TREE_ONLY : MILLER_ONLY);
}

// Canonical help-section order. HelpPopup renders the registry's groups in
// THIS order, and the KeyRegistryTest asserts every binding's `group` is one of
// these — so a binding given an unknown group can't silently vanish from the
// cheat-sheet (which would re-create the very drift this registry prevents).
// "Chords" is rendered as expanded sub-menus from chordBindings, not as the
// registry's bare chord-prefix rows, so HelpPopup filters it out of this list.
var HELP_GROUPS = ["Navigation", "History", "File", "Clipboard", "Selection",
    "Search & jump", "Chords", "View", "Tabs", "Tools", "Help"];

// Static "Modes" help rows for the text-input modes that are NOT registry
// bindings (so the help is complete). Pure data — no run().
var MODES = [
    { keycap: "s", label: "Flash jump — type letters to jump, Esc cancels", icon: "bolt" },
    { keycap: "/", label: "Search — type to filter, n/N to cycle, Enter confirms", icon: "search" },
    { keycap: "gn / gx", label: "Bookmarks — assign / delete with a letter", icon: "bookmark" }
];

// Modifier mask helpers ───────────────────────────────────────────────────────
function _relMods() {
    return Qt.ControlModifier | Qt.ShiftModifier | Qt.AltModifier | Qt.MetaModifier;
}

function _requiredMask(mods) {
    switch (mods) {
    case "": return 0;
    case "Ctrl": return Qt.ControlModifier;
    case "Shift": return Qt.ShiftModifier;
    case "Alt": return Qt.AltModifier;
    case "Ctrl+Shift": return Qt.ControlModifier | Qt.ShiftModifier;
    default: return -1; // "*" wildcard — handled by matchKey before this is called
    }
}

function isBareModifier(event) {
    return event.key === Qt.Key_Shift || event.key === Qt.Key_Control
        || event.key === Qt.Key_Alt || event.key === Qt.Key_Meta;
}

function matchKey(binding, event) {
    if (binding.keys.indexOf(event.key) === -1)
        return false;
    if (binding.mods === "*")
        return true;
    // Compare only Ctrl/Shift/Alt/Meta — ignore Keypad/GroupSwitch which arrow
    // keys may carry, mirroring the old switch's modifier-agnostic arrow cases.
    return (event.modifiers & _relMods()) === _requiredMask(binding.mods);
}

// Routing decision ONLY — returns the binding that would handle `event` in the
// given view (respecting when()), or null. No pre-pass, no run(), no side
// effects. Used by dispatch() and by the KeyRegistryTest routing assertions.
function matchBinding(event, ctx) {
    var list = bindingsFor(ctx.viewKind);
    for (var i = 0; i < list.length; i++) {
        var b = list[i];
        if (!matchKey(b, event))
            continue;
        if (b.when && !b.when(ctx))
            continue;
        return b;
    }
    return null;
}

// Picker pre-pass — ported from FileOpsHandler.tryHandle (44-75). Runs before
// the binding scan; returns true when it consumes the event. Uses injected
// services so it is testable with a stub fileManager.
function _pickerPrePass(event, ctx) {
    var ws = ctx.windowState;
    var fm = ctx.services.fileManager;
    var key = event.key, mods = event.modifiers;
    if (key === Qt.Key_Escape) {
        if (fm.pickerMultiple && ws.selectedCount > 0)
            ws.clearSelection();
        else
            fm.cancelPickerMode();
        event.accepted = true;
        return true;
    }
    if (!fm.pickerFileOps) {
        if (_PICKER_SUPPRESSED_KEYS.indexOf(key) !== -1
                && !(key === Qt.Key_Space && fm.pickerMultiple)
                && !(key === Qt.Key_P && (mods & Qt.ControlModifier))) {
            event.accepted = true;
            return true;
        }
        if (key === Qt.Key_V && (mods & Qt.ControlModifier)) {
            event.accepted = true;
            return true;
        }
    }
    return false;
}

// True when a binding is hidden by picker suppression in the current state —
// used by HelpPopup so the cheat-sheet never advertises a suppressed key.
// `fileManager` is passed in (HelpPopup hands it FileManagerService from scope;
// tests hand a stub).
function isSuppressedInPicker(binding, fileManager) {
    if (!fileManager.pickerMode || fileManager.pickerFileOps)
        return false;
    for (var i = 0; i < binding.keys.length; i++) {
        var k = binding.keys[i];
        if (_PICKER_SUPPRESSED_KEYS.indexOf(k) !== -1) {
            // Mirror the pre-pass exemptions EXACTLY so the sheet never lies:
            // Space stays live under multi-select (marking before confirm), and
            // Ctrl+P (audio toggle) is exempt — only bare `p` (paste) is
            // suppressed. Without these continues the help would hide a binding
            // that actually still works in the picker.
            if (k === Qt.Key_Space && fileManager.pickerMultiple)
                continue;
            if (k === Qt.Key_P && binding.mods === "Ctrl")
                continue;
            return true;
        }
        if (k === Qt.Key_V && binding.mods === "Ctrl")
            return true;
    }
    return false;
}

// The dispatcher — replaces the legacy normal-mode switch. Phases mirror today's
// cascade: bare-modifier → picker pre-pass → binding scan. Returns true iff the
// event was consumed. A binding whose when() is false does NOT consume (the key
// falls through), preserving today's n/N behavior.
function dispatch(event, ctx) {
    if (isBareModifier(event))
        return false;

    if (ctx.services.fileManager.pickerMode && _pickerPrePass(event, ctx))
        return true;

    var b = matchBinding(event, ctx);
    if (!b)
        return false;
    b.run(ctx);
    event.accepted = true;
    return true;
}
