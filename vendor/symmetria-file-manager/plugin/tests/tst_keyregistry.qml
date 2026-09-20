// Hermetic tests for KeyRegistry.js — the keybinding-registry single source of
// truth. Because the registry takes all its singletons through ctx.services
// (dependency injection), these tests pass plain JS STUBS and never load the
// real UI module: only QtQuick (for Qt.Key_*) and the .js itself are imported.
//
// Two responsibilities, per the "drift is structurally impossible" goal:
//   1. Well-formedness — every binding carries complete help metadata and no
//      two unconditional bindings collide on the same (key, mods) in a view.
//   2. Routing — matchBinding()/dispatch() send each (key, mods, view, state)
//      to the correct command, including the gnarly view-divergent cases.

import QtQuick
import QtTest
import "../../qml/Symmetria/FileManager/UI/modules/filemanager/handlers/KeyRegistry.js" as KeyRegistry

TestCase {
    name: "KeyRegistry"

    // --- stub builders ---------------------------------------------------------

    function _event(key, mods) {
        return { key: key, modifiers: mods || 0, text: "", accepted: false };
    }

    // A fully-stubbed ctx. Every windowState/fileManager method pushes to
    // ctx._calls so tests can assert side effects. `opts` overrides defaults.
    function _ctx(viewKind, opts) {
        opts = opts || {};
        var calls = [];
        var ws = {
            selectedCount: opts.selectedCount || 0,
            searchActive: opts.searchActive || false,
            matchIndices: opts.matchIndices || [],
            currentPath: "/home/u",
            requestDelete: function(p) { calls.push(["requestDelete", p]); },
            requestRename: function(p, ext) { calls.push(["requestRename", p, ext]); },
            requestCreate: function(d) { calls.push(["requestCreate", d]); },
            requestContextMenu: function(p, m) { calls.push(["requestContextMenu", p, m]); },
            requestZoxide: function() { calls.push(["requestZoxide"]); },
            requestFuzzyFinder: function() { calls.push(["requestFuzzyFinder"]); },
            clearSelection: function() { calls.push(["clearSelection"]); },
            getSelectedPathsArray: function() { return opts.selected || []; },
            toggleSelection: function(p) { calls.push(["toggleSelection", p]); },
            nextMatch: function() { calls.push(["nextMatch"]); },
            previousMatch: function() { calls.push(["previousMatch"]); },
            startSearch: function() { calls.push(["startSearch"]); },
            startFlash: function() { calls.push(["startFlash"]); },
            saveCursor: function() {},
            back: function() { calls.push(["back"]); },
            forward: function() { calls.push(["forward"]); },
            goUp: function() { calls.push(["goUp"]); },
            navigate: function(p) { calls.push(["navigate", p]); },
            audioPlaybackToggle: function() { calls.push(["audio"]); },
            toggleViewMode: function() { calls.push(["toggleViewMode"]); },
            toggleHtmlRender: function() { calls.push(["toggleHtmlRender"]); },
            openHelp: function() { calls.push(["openHelp"]); }
        };
        var fm = {
            pickerMode: opts.pickerMode || false,
            pickerFileOps: opts.pickerFileOps || false,
            pickerMultiple: opts.pickerMultiple || false,
            pickerSaveMode: opts.pickerSaveMode || false,
            pickerDirectory: opts.pickerDirectory || false,
            yank: function(p) { calls.push(["yank", p]); },
            cut: function(p) { calls.push(["cut", p]); },
            cancelPickerMode: function() { calls.push(["cancelPickerMode"]); },
            isHtmlFile: function(m) { return m === "text/html" || m === "application/xhtml+xml"; }
        };
        var hasEntry = opts.currentEntry !== undefined ? opts.currentEntry
                                                       : { path: "/home/u/file", isDir: false, mimeType: "text/plain" };
        return {
            _calls: calls,
            root: {
                currentEntry: hasEntry,
                currentRow: opts.currentRow !== undefined ? opts.currentRow : null,
                tabManager: opts.tabManager || null,
                fileOpsTargetDir: function() { return "/home/u"; },
                setPendingPasteFocus: function() {},
                _navigateIntoCurrentItem: function() { calls.push(["navInto"]); },
                _preSearchIndex: 0,
                _preFlashIndex: 0
            },
            view: {
                currentIndex: opts.currentIndex || 0,
                count: (opts.count !== undefined ? opts.count : 10),
                positionViewAtIndex: function() {}
            },
            windowState: ws,
            viewKind: viewKind,
            pasteProcess: { running: false, command: [], start: function() { calls.push(["paste"]); } },
            services: {
                fileManager: fm,
                config: { fileManager: { showHidden: false }, save: function() {} },
                paths: { home: "/home/u", basename: function(p) { return p; } }
            },
            activateCurrent: function() { calls.push(["activate"]); },
            halfPageCount: function() { return 5; },
            nav: function(fn) { fn(); },
            invalidateFlashCache: function() {}
        };
    }

    function _allBindings() {
        return KeyRegistry.CORE.concat(KeyRegistry.MILLER_ONLY).concat(KeyRegistry.TREE_ONLY);
    }

    function _bindingById(id) {
        var all = _allBindings();
        for (var i = 0; i < all.length; i++)
            if (all[i].id === id) return all[i];
        return null;
    }

    // --- 1. Well-formedness ----------------------------------------------------

    function test_every_binding_has_complete_metadata() {
        var all = _allBindings();
        verify(all.length > 20, "registry suspiciously small: " + all.length);
        for (var i = 0; i < all.length; i++) {
            var b = all[i];
            verify(typeof b.id === "string" && b.id.length > 0, "id missing at index " + i);
            verify(Array.isArray(b.keys) && b.keys.length > 0, "keys missing: " + b.id);
            verify(typeof b.mods === "string", "mods missing: " + b.id);
            // mods must be a value _requiredMask/matchKey understands. A typo like
            // "shift" (wrong case) or "any" passes the string check but makes
            // _requiredMask return -1 → the binding silently never matches. Catch
            // it here, the same silent-miss class as the layout-modifier bug.
            verify(["", "Ctrl", "Shift", "Alt", "Ctrl+Shift", "*"].indexOf(b.mods) !== -1,
                   "illegal mods value on " + b.id + ": '" + b.mods + "'");
            verify(typeof b.keycap === "string" && b.keycap.length > 0, "keycap missing: " + b.id);
            verify(typeof b.label === "string" && b.label.length > 0, "label missing: " + b.id);
            verify(typeof b.icon === "string" && b.icon.length > 0, "icon missing: " + b.id);
            verify(typeof b.group === "string" && b.group.length > 0, "group missing: " + b.id);
            verify(typeof b.run === "function", "run missing: " + b.id);
        }
    }

    function test_ids_are_unique() {
        var all = _allBindings();
        var seen = ({});
        for (var i = 0; i < all.length; i++) {
            verify(!seen[all[i].id], "duplicate id: " + all[i].id);
            seen[all[i].id] = true;
        }
    }

    // No two UNCONDITIONAL bindings may claim the same (key, mods) in one view.
    // Conditional (when()) bindings are allowed to overlap — they're disambiguated
    // by order + guard (e.g. Escape: sel.clear when selected, else escapeSwallow).
    function _assertNoCollision(viewKind) {
        var list = KeyRegistry.bindingsFor(viewKind);
        // A "*" binding matches ANY modifier set for its key, so at runtime it
        // shadows a specific-mods binding on the SAME key (matchKey returns true
        // for "*" first). Comparing raw sigs would miss that — "K|*" != "K|Ctrl".
        // Expand "*" into every concrete combo it implicitly claims so the exact
        // check below catches a "*"-vs-specific (or "*"-vs-"*") shadow too.
        var CONCRETE = ["", "Ctrl", "Shift", "Alt", "Ctrl+Shift"];
        var seen = ({});
        for (var i = 0; i < list.length; i++) {
            var b = list[i];
            if (b.when)
                continue;
            for (var k = 0; k < b.keys.length; k++) {
                var combos = b.mods === "*" ? CONCRETE : [b.mods];
                for (var c = 0; c < combos.length; c++) {
                    var sig = b.keys[k] + "|" + combos[c];
                    verify(!seen[sig], viewKind + " (key,mods) collision " + sig + ": " + seen[sig] + " vs " + b.id);
                    seen[sig] = b.id;
                }
            }
        }
    }

    function test_no_unconditional_collision_miller() { _assertNoCollision("miller"); }
    function test_no_unconditional_collision_tree() { _assertNoCollision("tree"); }

    // --- 2. Routing ------------------------------------------------------------

    function test_routes_data() {
        return [
            { tag: "j → down (miller)",          key: Qt.Key_J,        mods: 0,                 view: "miller", expect: "nav.down" },
            { tag: "down arrow → down (tree)",   key: Qt.Key_Down,     mods: 0,                 view: "tree",   expect: "nav.down" },
            { tag: "bare d → delete",            key: Qt.Key_D,        mods: 0,                 view: "miller", expect: "op.delete" },
            { tag: "ctrl+d → half-down",         key: Qt.Key_D,        mods: Qt.ControlModifier, view: "miller", expect: "nav.halfDown" },
            { tag: "shift+d → forward",          key: Qt.Key_D,        mods: Qt.ShiftModifier,  view: "miller", expect: "hist.forward" },
            { tag: "shift+s → back",             key: Qt.Key_S,        mods: Qt.ShiftModifier,  view: "tree",   expect: "hist.back" },
            { tag: "bare s → flash",             key: Qt.Key_S,        mods: 0,                 view: "miller", expect: "flash.enter" },
            { tag: "h → up (miller)",            key: Qt.Key_H,        mods: 0,                 view: "miller", expect: "miller.up" },
            { tag: "h → collapse (tree)",        key: Qt.Key_H,        mods: 0,                 view: "tree",   expect: "tree.collapseOrParent" },
            { tag: "shift+h → hidden (tree)",    key: Qt.Key_H,        mods: Qt.ShiftModifier,  view: "tree",   expect: "tree.toggleHidden" },
            { tag: "shift+r → rename-ext (mil)", key: Qt.Key_R,        mods: Qt.ShiftModifier,  view: "miller", expect: "miller.renameExt" },
            { tag: "shift+r → refresh (tree)",   key: Qt.Key_R,        mods: Qt.ShiftModifier,  view: "tree",   expect: "tree.refreshAll" },
            { tag: ". → hidden (miller)",        key: Qt.Key_Period,   mods: 0,                 view: "miller", expect: "miller.toggleHidden" },
            { tag: ". → gitignore (tree)",       key: Qt.Key_Period,   mods: 0,                 view: "tree",   expect: "tree.toggleGitignore" },
            { tag: "ctrl+e → view toggle",       key: Qt.Key_E,        mods: Qt.ControlModifier, view: "tree",   expect: "view.toggle" },
            { tag: "? → help",                   key: Qt.Key_Question, mods: Qt.ShiftModifier,  view: "miller", expect: "help.open" },
            { tag: "g → go chord",               key: Qt.Key_G,        mods: 0,                 view: "miller", expect: "chord.go" },
            { tag: "shift+g → bottom",           key: Qt.Key_G,        mods: Qt.ShiftModifier,  view: "miller", expect: "nav.bottom" },

            // --- Symbol keys carry layout-dependent modifiers (regression) -----
            // On the Spanish Latin-American layout `/` = Shift+7, `=` = Shift+0,
            // and `[`/`]` need Shift/AltGr. These bindings therefore use
            // mods: "*", so they MUST still route when the event carries Shift.
            // A revert to mods: "" (the original bug — `/`-search did nothing on
            // a latam keyboard) fails these. The bare-modifier (mods: 0) variants
            // are covered implicitly: "*" matches any modifier set.
            { tag: "/ → search (no mods)",       key: Qt.Key_Slash,        mods: 0,                view: "miller", expect: "search.start" },
            { tag: "shift+/ → search (miller)",  key: Qt.Key_Slash,        mods: Qt.ShiftModifier, view: "miller", expect: "search.start" },
            { tag: "shift+/ → search (tree)",    key: Qt.Key_Slash,        mods: Qt.ShiftModifier, view: "tree",   expect: "search.start" },
            { tag: "shift+= → forward",          key: Qt.Key_Equal,        mods: Qt.ShiftModifier, view: "miller", expect: "miller.forward" },
            { tag: "shift+- → back",             key: Qt.Key_Minus,        mods: Qt.ShiftModifier, view: "miller", expect: "miller.back" },
            { tag: "shift+[ → prev tab",         key: Qt.Key_BracketLeft,  mods: Qt.ShiftModifier, view: "miller", expect: "miller.tabPrev" },
            { tag: "shift+] → next tab",         key: Qt.Key_BracketRight, mods: Qt.ShiftModifier, view: "miller", expect: "miller.tabNext" },
            // `.` and `,` are base-level on latam but use mods: "*" for the
            // "all symbol glyphs are modifier-tolerant" invariant — assert a
            // modifier-carrying event still routes (guards against a "" revert).
            { tag: "shift+. → hidden (miller)",  key: Qt.Key_Period,       mods: Qt.ShiftModifier, view: "miller", expect: "miller.toggleHidden" },
            { tag: "shift+. → gitignore (tree)", key: Qt.Key_Period,       mods: Qt.ShiftModifier, view: "tree",   expect: "tree.toggleGitignore" },
            { tag: ", → sort chord",             key: Qt.Key_Comma,        mods: 0,                view: "miller", expect: "chord.sort" },
            { tag: "shift+, → sort chord",       key: Qt.Key_Comma,        mods: Qt.ShiftModifier, view: "miller", expect: "chord.sort" }
        ];
    }

    function test_routes(data) {
        var ctx = _ctx(data.view, {});
        var b = KeyRegistry.matchBinding(_event(data.key, data.mods), ctx);
        verify(b !== null, "no binding matched: " + data.tag);
        compare(b.id, data.expect, data.tag);
    }

    // when()-gating: n/N must NOT match (fall through) with no active matches,
    // but must match once matches exist — preserving today's behavior.
    function test_n_falls_through_without_matches() {
        var ctx = _ctx("miller", { matchIndices: [], searchActive: false });
        var b = KeyRegistry.matchBinding(_event(Qt.Key_N, 0), ctx);
        verify(b === null, "n should not match when there are no search matches");
    }

    function test_n_routes_with_matches() {
        var ctx = _ctx("miller", { matchIndices: [1, 2], searchActive: false });
        var b = KeyRegistry.matchBinding(_event(Qt.Key_N, 0), ctx);
        verify(b !== null);
        compare(b.id, "match.next");
    }

    // Ctrl+R HTML render toggle: matches only on an HTML entry, falls through
    // otherwise, and yields to op.pickerSaveEdit in a save picker.
    function test_ctrl_r_renders_html() {
        var ctx = _ctx("miller", { currentEntry: { path: "/a.html", isDir: false, mimeType: "text/html" } });
        var b = KeyRegistry.matchBinding(_event(Qt.Key_R, Qt.ControlModifier), ctx);
        verify(b !== null, "Ctrl+R must match on an HTML entry");
        compare(b.id, "miller.htmlRender");
        verify(KeyRegistry.dispatch(_event(Qt.Key_R, Qt.ControlModifier), ctx), "Ctrl+R consumed on HTML");
        var toggled = false;
        for (var i = 0; i < ctx._calls.length; i++)
            if (ctx._calls[i][0] === "toggleHtmlRender") toggled = true;
        verify(toggled, "Ctrl+R must call toggleHtmlRender on an HTML entry");
    }

    function test_ctrl_r_falls_through_on_non_html() {
        var ctx = _ctx("miller", { currentEntry: { path: "/a.txt", isDir: false, mimeType: "text/plain" } });
        var b = KeyRegistry.matchBinding(_event(Qt.Key_R, Qt.ControlModifier), ctx);
        verify(b === null, "Ctrl+R must fall through on a non-HTML file (not consumed)");
    }

    function test_ctrl_r_save_picker_wins() {
        // Even on an HTML entry, a save picker's edit-name binding (earlier in
        // CORE) takes Ctrl+R — the render toggle is secondary to active editing.
        var ctx = _ctx("miller", { pickerMode: true, pickerSaveMode: true,
            currentEntry: { path: "/a.html", isDir: false, mimeType: "text/html" } });
        var b = KeyRegistry.matchBinding(_event(Qt.Key_R, Qt.ControlModifier), ctx);
        verify(b !== null);
        compare(b.id, "op.pickerSaveEdit");
    }

    // --- 3. dispatch() side effects (only ctx-pure / injectable run-bodies) -----

    function test_dispatch_navdown_moves_cursor() {
        var ctx = _ctx("miller", { currentIndex: 0, count: 5 });
        var consumed = KeyRegistry.dispatch(_event(Qt.Key_J, 0), ctx);
        verify(consumed, "j should be consumed");
        compare(ctx.view.currentIndex, 1);
    }

    function test_dispatch_delete_calls_requestDelete() {
        var ctx = _ctx("miller", { currentEntry: { path: "/a", isDir: false } });
        var consumed = KeyRegistry.dispatch(_event(Qt.Key_D, 0), ctx);
        verify(consumed);
        compare(ctx._calls.length, 1);
        compare(ctx._calls[0][0], "requestDelete");
        compare(ctx._calls[0][1][0], "/a");
    }

    function test_dispatch_yank_suppressed_in_picker() {
        var ctx = _ctx("miller", { pickerMode: true });
        var consumed = KeyRegistry.dispatch(_event(Qt.Key_Y, 0), ctx);
        verify(consumed, "a suppressed key still consumes the event in picker mode");
        for (var i = 0; i < ctx._calls.length; i++)
            verify(ctx._calls[i][0] !== "yank", "yank must be suppressed in picker mode");
    }

    function test_dispatch_unmatched_returns_false() {
        var ctx = _ctx("miller", {});
        var consumed = KeyRegistry.dispatch(_event(Qt.Key_F12, 0), ctx);
        verify(!consumed, "unmapped key must not be consumed");
    }

    function test_dispatch_n_without_matches_returns_false() {
        var ctx = _ctx("miller", { matchIndices: [] });
        var consumed = KeyRegistry.dispatch(_event(Qt.Key_N, 0), ctx);
        verify(!consumed, "n with no matches must fall through (not consumed)");
    }

    // --- 4. picker suppression predicate (used by HelpPopup) --------------------

    function test_isSuppressedInPicker() {
        var yank = null;
        for (var i = 0; i < KeyRegistry.CORE.length; i++)
            if (KeyRegistry.CORE[i].id === "clip.yank") yank = KeyRegistry.CORE[i];
        verify(yank !== null);
        verify(!KeyRegistry.isSuppressedInPicker(yank, { pickerMode: false, pickerFileOps: false, pickerMultiple: false }),
               "not suppressed outside picker mode");
        verify(KeyRegistry.isSuppressedInPicker(yank, { pickerMode: true, pickerFileOps: false, pickerMultiple: false }),
               "yank suppressed in a normal picker");
        verify(!KeyRegistry.isSuppressedInPicker(yank, { pickerMode: true, pickerFileOps: true, pickerMultiple: false }),
               "full-ops picker host does not suppress");
    }

    // The help predicate must mirror the dispatch pre-pass EXACTLY, so the
    // cheat-sheet never hides a binding that is actually still live in a picker
    // (and never advertises one that is suppressed).
    function test_picker_help_matches_prepass() {
        var picker = { pickerMode: true, pickerFileOps: false, pickerMultiple: false };
        verify(KeyRegistry.isSuppressedInPicker(_bindingById("clip.pasteCtrl"), picker),
               "Ctrl+V paste is suppressed → hidden from the sheet");
        verify(KeyRegistry.isSuppressedInPicker(_bindingById("clip.paste"), picker),
               "bare p paste is suppressed → hidden from the sheet");
        verify(!KeyRegistry.isSuppressedInPicker(_bindingById("miller.audioToggle"), picker),
               "Ctrl+P audio toggle is exempt in the pre-pass → must stay on the sheet");
        verify(KeyRegistry.isSuppressedInPicker(_bindingById("sel.toggle"), picker),
               "Space marking is suppressed in a single-select picker");
        var multi = { pickerMode: true, pickerFileOps: false, pickerMultiple: true };
        verify(!KeyRegistry.isSuppressedInPicker(_bindingById("sel.toggle"), multi),
               "Space marking is live under multi-select → stays on the sheet");
    }

    // Dispatch-level confirmation of the same pre-pass exemptions: Ctrl+P reaches
    // its run-body in a picker, while Ctrl+V is consumed-but-suppressed.
    function test_dispatch_picker_exemptions() {
        var ctxP = _ctx("miller", { pickerMode: true });
        verify(KeyRegistry.dispatch(_event(Qt.Key_P, Qt.ControlModifier), ctxP), "Ctrl+P consumed in picker");
        var sawAudio = false;
        for (var i = 0; i < ctxP._calls.length; i++)
            if (ctxP._calls[i][0] === "audio") sawAudio = true;
        verify(sawAudio, "Ctrl+P reaches audioPlaybackToggle in picker (exempt from suppression)");

        var ctxV = _ctx("miller", { pickerMode: true });
        verify(KeyRegistry.dispatch(_event(Qt.Key_V, Qt.ControlModifier), ctxV), "Ctrl+V consumed in picker");
        for (var j = 0; j < ctxV._calls.length; j++)
            verify(ctxV._calls[j][0] !== "paste", "Ctrl+V paste must be suppressed in picker");
    }

    // Every binding's group must be one HelpPopup knows how to render — otherwise
    // it dispatches but silently vanishes from the cheat-sheet (drift).
    function test_every_group_is_renderable() {
        var all = _allBindings();
        for (var i = 0; i < all.length; i++)
            verify(KeyRegistry.HELP_GROUPS.indexOf(all[i].group) !== -1,
                   "binding " + all[i].id + " has group '" + all[i].group + "' not in HELP_GROUPS");
    }
}
