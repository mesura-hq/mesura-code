import { beforeEach, describe, expect, it } from "vitest";

import { type CascadeMode, handleKey } from "../src/keys/cascade.ts";
import { resolveChord } from "../src/keys/chords.ts";
import { dispatch, isSuppressedInPicker, matchBinding } from "../src/keys/dispatch.ts";
import { bindingsFor, CORE, MILLER_ONLY } from "../src/keys/registry.ts";
import type {
  Binding,
  CursorEntry,
  KeyActions,
  KeyContext,
  KeyEvent,
  KeyState,
  Mods,
  ViewKind,
} from "../src/keys/types.ts";

/**
 * What the keys actually do.
 *
 * `registry.test.ts` checks the table's shape; this checks its behaviour. The
 * actions are a recording stub, which is the whole reason the registry takes
 * them by injection: routing is exercised without a window, a filesystem, or a
 * single real side effect.
 */

interface Recorder {
  readonly calls: string[];
  readonly actions: KeyActions;
}

function recorder(): Recorder {
  const calls: string[] = [];
  const log =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push(args.length === 0 ? name : `${name}(${args.join(",")})`);
    };

  const actions: KeyActions = {
    moveDown: log("moveDown"),
    moveUp: log("moveUp"),
    jumpToTop: log("jumpToTop"),
    jumpToBottom: log("jumpToBottom"),
    halfPageDown: log("halfPageDown"),
    halfPageUp: log("halfPageUp"),
    activate: log("activate"),
    goUp: log("goUp"),
    enterDirectory: log("enterDirectory"),
    goHome: log("goHome"),
    jumpDirectoryFileBoundary: log("jumpDirectoryFileBoundary"),
    dismiss: log("dismiss"),
    historyBack: log("historyBack"),
    historyForward: log("historyForward"),
    trash: log("trash"),
    rename: log("rename"),
    createEntry: log("createEntry"),
    editSaveName: log("editSaveName"),
    yank: log("yank"),
    cut: log("cut"),
    paste: log("paste"),
    copyToClipboard: log("copyToClipboard"),
    toggleSelection: log("toggleSelection"),
    clearSelection: log("clearSelection"),
    startSearch: log("startSearch"),
    nextMatch: log("nextMatch"),
    previousMatch: log("previousMatch"),
    startFlash: log("startFlash"),
    openFuzzyFinder: log("openFuzzyFinder"),
    openZoxide: log("openZoxide"),
    setChordPrefix: log("setChordPrefix"),
    startBookmarkSubMode: log("startBookmarkSubMode"),
    exitBookmarkSubMode: log("exitBookmarkSubMode"),
    navigateToBookmark: log("navigateToBookmark"),
    assignBookmark: log("assignBookmark"),
    deleteBookmark: log("deleteBookmark"),
    setSort: log("setSort"),
    showMessage: log("showMessage"),
    toggleViewMode: log("toggleViewMode"),
    toggleHidden: log("toggleHidden"),
    toggleDocumentRender: log("toggleDocumentRender"),
    openContextMenu: log("openContextMenu"),
    openCopyingPath: log("openCopyingPath"),
    tabNew: log("tabNew"),
    tabClose: log("tabClose"),
    tabNext: log("tabNext"),
    tabPrevious: log("tabPrevious"),
    toggleAudioPlayback: log("toggleAudioPlayback"),
    openHelp: log("openHelp"),
    treeCollapseOrParent: log("treeCollapseOrParent"),
    treeExpandOrActivate: log("treeExpandOrActivate"),
    treeToggleExpand: log("treeToggleExpand"),
    treeToggleHidden: log("treeToggleHidden"),
    treePageDown: log("treePageDown"),
    treePageUp: log("treePageUp"),
    treeRefresh: log("treeRefresh"),
  };

  return { calls, actions };
}

/** A state in which as many conditional rows as possible are live. */
function permissiveState(): KeyState & { cursorEntry: NonNullable<KeyState["cursorEntry"]> } {
  return {
    selectedCount: 1,
    searchActive: false,
    matchCount: 2,
    cursorEntry: {
      name: "page.html",
      path: "/tmp/page.html",
      isDirectory: false,
      isImage: true,
      mimeType: "text/html",
    },
    picker: { active: false, saveMode: false, fileOps: false, multiple: false, directory: false },
  };
}

function contextWith(state: Partial<KeyState>, view: ViewKind = "miller"): KeyContext & Recorder {
  const { calls, actions } = recorder();
  return {
    view,
    state: { ...permissiveState(), ...state },
    actions,
    calls,
    overview: { toggle: () => calls.push("overview.toggle"), command: (name) => calls.push(name) },
    tree: { close: () => calls.push("tree.close") },
  };
}

function press(key: string, mods: Mods = ""): KeyEvent {
  return {
    key,
    ctrl: mods === "Ctrl" || mods === "Ctrl+Shift",
    shift: mods === "Shift" || mods === "Ctrl+Shift",
    alt: mods === "Alt",
    meta: false,
  };
}

/**
 * The state each conditional row needs to be the one that wins.
 *
 * Only three rows need one, and each says why. Everything else routes under the
 * permissive default.
 */
function stateFor(binding: Binding): Partial<KeyState> {
  // Ctrl+R is shared with `miller.renderToggle`; save mode is what makes the
  // picker row win, and it sits earlier in CORE.
  if (binding.id === "op.pickerSaveEdit") {
    return { picker: { ...permissiveState().picker, saveMode: true } };
  }
  // Escape is claimed by `sel.clear` while anything is selected.
  if (binding.id === "miller.escapeSwallow") return { selectedCount: 0 };
  return {};
}

describe("every binding routes to its own action", () => {
  it.each(["miller", "tree", "overview"] as const)("in the %s view", (view) => {
    for (const binding of bindingsFor(view)) {
      const key = binding.keys[0];
      expect(key, binding.id).toBeDefined();
      if (key === undefined) continue;

      // A wildcard row must match whatever modifiers arrive, so it is fired
      // WITH Shift held — the Latin-American case — not without.
      const ctx = contextWith(stateFor(binding), view);
      const consumed = dispatch(press(key, binding.mods === "*" ? "Shift" : binding.mods), ctx);

      expect(matchBinding(press(key, binding.mods === "*" ? "Shift" : binding.mods), ctx)?.id).toBe(
        binding.id,
      );
      expect(consumed, binding.id).toBe(true);
      expect(ctx.calls, binding.id).toHaveLength(1);
    }
  });

  it("reaches every alternative key a binding declares", () => {
    // `j` and ArrowDown are one row. A port that dropped the second key would
    // still pass the loop above, which only fires the first.
    for (const binding of [...CORE, ...MILLER_ONLY]) {
      for (const key of binding.keys) {
        const ctx = contextWith(stateFor(binding));
        const matched = matchBinding(
          press(key, binding.mods === "*" ? "Shift" : binding.mods),
          ctx,
        );
        expect(matched?.id, `${binding.id} via ${key}`).toBe(binding.id);
      }
    }
  });
});

describe("a false condition does not consume", () => {
  it("lets n fall through when there is nothing to cycle", () => {
    // The load-bearing semantic a naive port loses. `n` with no matches must
    // fall through rather than be swallowed, which is what lets a later handler
    // — or the host — see it.
    const ctx = contextWith({ matchCount: 0 });

    expect(dispatch(press("n"), ctx)).toBe(false);
    expect(ctx.calls).toEqual([]);
  });

  it("lets n fall through while the search field is collecting a query", () => {
    const ctx = contextWith({ searchActive: true, matchCount: 5 });

    expect(dispatch(press("n"), ctx)).toBe(false);
  });

  it("closes the tree on Escape without propagating to the embedding host", () => {
    const ctx = contextWith({ selectedCount: 0 }, "tree");
    const tree = { ...ctx, tree: { close: () => ctx.calls.push("tree.close") } };
    expect(dispatch(press("escape"), tree)).toBe(true);
    expect(tree.calls).toEqual(["tree.close"]);

    const miller = contextWith({ selectedCount: 0 }, "miller");
    expect(dispatch(press("escape"), miller)).toBe(true);
  });

  it("consumes a bare modifier as nothing at all", () => {
    const ctx = contextWith({});
    expect(dispatch(press("Shift"), ctx)).toBe(false);
    expect(ctx.calls).toEqual([]);
  });
});

/** A cursor entry differing from the fixture only in name and type. */
function entryOn(name: string, mimeType: string): CursorEntry {
  return { name, path: `/tmp/${name}`, isDirectory: false, isImage: false, mimeType };
}

describe("Ctrl+R precedence, which two rows share", () => {
  it("edits the save name inside a save picker", () => {
    const ctx = contextWith({ picker: { ...permissiveState().picker, saveMode: true } });

    dispatch(press("r", "Ctrl"), ctx);
    expect(ctx.calls).toEqual(["editSaveName"]);
  });

  it.each([
    ["an HTML file", "page.html", "text/html"],
    ["an XHTML file", "page.xhtml", "application/xhtml+xml"],
    ["a markdown file", "NOTES.md", "text/markdown"],
    ["a markdown file the database calls plain text", "NOTES.md", "text/plain"],
    ["a README the NAME says nothing about", "README", "text/markdown"],
  ])("toggles the rendered view for %s, outside one", (_why, name, mimeType) => {
    const ctx = contextWith({ cursorEntry: entryOn(name, mimeType) });

    dispatch(press("r", "Ctrl"), ctx);
    expect(ctx.calls).toEqual(["toggleDocumentRender"]);
  });

  it.each([
    ["a plain text file", "notes.txt", "text/plain"],
    ["a source file", "route.ts", "text/x-typescript"],
    ["an image", "photo.png", "image/png"],
  ])("falls through on %s, so the key reaches whatever handles it next", (_why, name, mimeType) => {
    // A `when()` that is false does NOT consume its key. That is what lets two
    // rows share Ctrl+R at all, and what keeps the key available to anything
    // bound to it later.
    const ctx = contextWith({ cursorEntry: entryOn(name, mimeType) });

    expect(dispatch(press("r", "Ctrl"), ctx)).toBe(false);
    expect(ctx.calls).toEqual([]);
  });

  it("falls through with no entry under the cursor at all", () => {
    const ctx = contextWith({ cursorEntry: null });

    expect(dispatch(press("r", "Ctrl"), ctx)).toBe(false);
  });
});

describe("the Latin-American layout", () => {
  it.each([
    ["/", "startSearch"],
    ["?", "openHelp"],
    [".", "toggleHidden"],
    ["-", "historyBack"],
    ["=", "historyForward"],
    ["[", "tabPrevious"],
    ["]", "tabNext"],
    ["~", "goHome"],
  ])("dispatches %s even though the layout produces it with Shift", (key, action) => {
    // The regression this pins: on this layout `/` is Shift+7, so the event
    // carries Shift. A row declaring empty modifiers rejects it and the key
    // silently does nothing.
    const ctx = contextWith({});

    dispatch({ key, ctrl: false, shift: true, alt: false, meta: false }, ctx);
    expect(ctx.calls).toEqual([action]);
  });

  it("dispatches the same glyphs without Shift, on a layout that produces them bare", () => {
    const ctx = contextWith({});
    dispatch(press("/"), ctx);
    expect(ctx.calls).toEqual(["startSearch"]);
  });
});

describe("chords", () => {
  let ctx: KeyContext & Recorder;
  beforeEach(() => {
    ctx = contextWith({});
  });

  it("opens a pending prefix rather than acting", () => {
    dispatch(press("g"), ctx);
    expect(ctx.calls).toEqual(["setChordPrefix(g)"]);
  });

  it("resolves gg to the top", () => {
    resolveChord("g", press("g"), ctx);
    expect(ctx.calls).toEqual(["setChordPrefix()", "jumpToTop"]);
  });

  it("treats an unknown g key as a bookmark, which the host may not have", () => {
    resolveChord("g", press("q"), ctx);
    expect(ctx.calls).toEqual(["setChordPrefix()", "navigateToBookmark(q)"]);
  });

  it("cancels on Escape without acting", () => {
    const result = resolveChord("c", press("escape"), ctx);

    expect(result.cancelled).toBe(true);
    expect(ctx.calls).toEqual(["setChordPrefix()"]);
  });

  it("keeps the chord pending while a modifier is held", () => {
    // Typing an uppercase sort key means holding Shift. If that cancelled the
    // chord, no descending sort would ever be reachable.
    const result = resolveChord(",", press("Shift"), ctx);

    expect(result.cancelled).toBe(false);
    expect(ctx.calls).toEqual([]);
  });

  it("does nothing for a second key the chord does not define", () => {
    resolveChord(",", press("q"), ctx);
    expect(ctx.calls).toEqual(["setChordPrefix()"]);
  });

  it("reads case as sort direction, and only for the sort chord", () => {
    resolveChord(",", { key: "S", ctrl: false, shift: true, alt: false, meta: false }, ctx);
    expect(ctx.calls).toEqual(["setChordPrefix()", "setSort(size,true)"]);

    const ascending = contextWith({});
    resolveChord(",", press("s"), ascending);
    expect(ascending.calls).toEqual(["setChordPrefix()", "setSort(size,false)"]);
  });

  it("refuses to copy the bytes of something that is not an image", () => {
    const notImage = contextWith({
      cursorEntry: { ...permissiveState().cursorEntry, isImage: false },
    });

    resolveChord("c", press("i"), notImage);
    expect(notImage.calls).toEqual(["setChordPrefix()", "showMessage(Not an image)"]);
  });

  it("refuses to copy an image whose MIME type the clipboard cannot advertise", () => {
    // An RPG-Maker `.rpgmvp` sniffs as an image but reports
    // `application/octet-stream`, and its bytes are not valid PNG.
    const disguised = contextWith({
      cursorEntry: {
        ...permissiveState().cursorEntry,
        mimeType: "application/octet-stream",
      },
    });

    resolveChord("c", press("i"), disguised);
    expect(disguised.calls[1]).toBe("showMessage(Can't copy this image format)");
  });
});

describe("the cascade", () => {
  const quiet: CascadeMode = {
    modalOpen: false,
    bookmarkSubMode: null,
    chordPrefix: "",
    flashActive: false,
    textInputFocused: false,
  };

  it("lets a focused text input have the key, before anything else", () => {
    const ctx = contextWith({});
    const outcome = handleKey(press("j"), { ...quiet, textInputFocused: true }, ctx);

    expect(outcome.kind).toBe("notOurs");
    expect(ctx.calls).toEqual([]);
  });

  it("lets a modal swallow everything", () => {
    const ctx = contextWith({});
    expect(handleKey(press("j"), { ...quiet, modalOpen: true }, ctx).kind).toBe("modal");
    expect(ctx.calls).toEqual([]);
  });

  it("resolves a pending chord BEFORE picker suppression could eat its second key", () => {
    // The ordering the original calls out and a naive port loses. `d` is not
    // suppressed, but `p` and `x` are: `cd` inside a picker must still copy the
    // directory path rather than being swallowed.
    const ctx = contextWith({
      picker: { ...permissiveState().picker, active: true },
    });

    const outcome = handleKey(press("d"), { ...quiet, chordPrefix: "c" }, ctx);

    expect(outcome.kind).toBe("chord");
    expect(ctx.calls).toEqual(["setChordPrefix()", "copyToClipboard(directory)"]);
  });

  it("hands a key to the flash handler while flash is active", () => {
    const ctx = contextWith({});
    expect(handleKey(press("a"), { ...quiet, flashActive: true }, ctx).kind).toBe("flash");
    expect(ctx.calls).toEqual([]);
  });

  it("captures a letter for the bookmark sub-mode", () => {
    const ctx = contextWith({});
    const outcome = handleKey(press("w"), { ...quiet, bookmarkSubMode: "create" }, ctx);

    expect(outcome.kind).toBe("bookmark");
    expect(ctx.calls).toEqual(["assignBookmark(w)", "exitBookmarkSubMode"]);
  });

  it("cancels the bookmark sub-mode on a key that is not a letter", () => {
    const ctx = contextWith({});
    handleKey(press("Enter"), { ...quiet, bookmarkSubMode: "delete" }, ctx);

    expect(ctx.calls).toEqual(["exitBookmarkSubMode"]);
  });

  it("names the binding that ran", () => {
    const ctx = contextWith({});
    const outcome = handleKey(press("j"), quiet, ctx);

    expect(outcome.kind === "dispatched" && outcome.binding.id).toBe("nav.down");
  });

  it("reports a key nothing claimed", () => {
    const ctx = contextWith({});
    expect(handleKey(press("w"), quiet, ctx).kind).toBe("unhandled");
  });
});

describe("Escape unwinds in order", () => {
  const modes = {
    modalOpen: false,
    bookmarkSubMode: null,
    chordPrefix: "",
    flashActive: false,
    textInputFocused: false,
  } satisfies CascadeMode;

  it("cancels the innermost mode first, one at a time", () => {
    const esc = press("escape");

    // A text input, then a modal, then the bookmark sub-mode, then a chord,
    // then flash — each wins over everything after it.
    expect(
      handleKey(esc, { ...modes, textInputFocused: true, modalOpen: true }, contextWith({})).kind,
    ).toBe("notOurs");
    expect(
      handleKey(esc, { ...modes, modalOpen: true, chordPrefix: "g" }, contextWith({})).kind,
    ).toBe("modal");
    expect(
      handleKey(esc, { ...modes, bookmarkSubMode: "create", chordPrefix: "g" }, contextWith({}))
        .kind,
    ).toBe("bookmark");
    expect(
      handleKey(esc, { ...modes, chordPrefix: "g", flashActive: true }, contextWith({})).kind,
    ).toBe("chord");
    expect(handleKey(esc, { ...modes, flashActive: true }, contextWith({})).kind).toBe("flash");
  });

  it("cancels a picker before it clears a selection", () => {
    const ctx = contextWith({
      selectedCount: 0,
      picker: { ...permissiveState().picker, active: true },
    });

    handleKey(press("escape"), modes, ctx);
    expect(ctx.calls).toEqual(["dismiss"]);
  });

  it("clears a multi-select picker's selection before cancelling the picker", () => {
    const ctx = contextWith({
      selectedCount: 2,
      picker: { ...permissiveState().picker, active: true, multiple: true },
    });

    handleKey(press("escape"), modes, ctx);
    expect(ctx.calls).toEqual(["clearSelection"]);
  });

  it("clears a selection outside a picker", () => {
    const ctx = contextWith({ selectedCount: 3 });

    handleKey(press("escape"), modes, ctx);
    expect(ctx.calls).toEqual(["clearSelection"]);
  });
});

describe("picker suppression", () => {
  const inPicker = (over: Partial<KeyState["picker"]> = {}) =>
    contextWith({ picker: { ...permissiveState().picker, active: true, ...over } });

  it.each(["y", "x", "p", " ", "t", "[", "]"])("swallows %s in a file chooser", (key) => {
    const ctx = inPicker();

    expect(dispatch(press(key), ctx)).toBe(true);
    expect(ctx.calls, key).toEqual([]);
  });

  it("keeps Space live under multi-select, because marking is the point", () => {
    const ctx = inPicker({ multiple: true });

    dispatch(press(" "), ctx);
    expect(ctx.calls).toEqual(["toggleSelection"]);
  });

  it("keeps Ctrl+P live, because that is the audio toggle and not paste", () => {
    const ctx = inPicker();

    dispatch(press("p", "Ctrl"), ctx);
    expect(ctx.calls).toEqual(["toggleAudioPlayback"]);
  });

  it("swallows Ctrl+V, the one suppressed key that carries a modifier", () => {
    const ctx = inPicker();

    expect(dispatch(press("v", "Ctrl"), ctx)).toBe(true);
    expect(ctx.calls).toEqual([]);
  });

  it("suppresses nothing for a host that asked for the full set", () => {
    const ctx = inPicker({ fileOps: true });

    dispatch(press("y"), ctx);
    expect(ctx.calls).toEqual(["yank"]);
  });

  it("hides exactly the rows it suppresses from the help sheet", () => {
    // The sheet must not advertise a key the picker has taken away — nor hide
    // one that still works. The exemptions have to agree with the pre-pass or
    // the help lies in one direction or the other.
    const ctx = inPicker();
    const hidden = bindingsFor("miller")
      .filter((b) => isSuppressedInPicker(b, ctx))
      .map((b) => b.id);

    expect(hidden.sort()).toEqual(
      [
        "clip.cut",
        "clip.paste",
        "clip.pasteCtrl",
        "clip.yank",
        "miller.tabNew",
        "miller.tabNext",
        "miller.tabPrev",
        "sel.toggle",
      ].sort(),
    );
  });
});
