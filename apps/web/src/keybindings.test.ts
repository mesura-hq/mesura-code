import {
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "./keybindings";
import { assert, describe, it } from "vite-plus/test";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";

import {
  type KeybindingCommand,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  effectiveShortcutsForCommand,
  formatShortcutLabel,
  findEffectiveShortcutForCommand,
  isDiffToggleShortcut,
  isRichTextBoldShortcut,
  isTerminalNewShortcut,
  isTerminalSplitShortcut,
  resolveChatShortcutCommand,
  resolveShortcutCommand,
  shouldShowThreadJumpHintsForModifiers,
  shortcutLabelForCommand,
  type ShortcutEventLike,
} from "./keybindings";

function event(overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return {
    key: "j",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

function modShortcut(
  key: string,
  overrides: Partial<Omit<KeybindingShortcut, "key">> = {},
): KeybindingShortcut {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: true,
    ...overrides,
  };
}

function whenIdentifier(name: string): KeybindingWhenNode {
  return { type: "identifier", name };
}

function whenNot(node: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "not", node };
}

function whenAnd(left: KeybindingWhenNode, right: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "and", left, right };
}

interface TestBinding {
  shortcut: KeybindingShortcut;
  command: KeybindingCommand;
  whenAst?: KeybindingWhenNode;
}

function compile(bindings: TestBinding[]): ResolvedKeybindingsConfig {
  return bindings.map((binding) => ({
    command: binding.command,
    shortcut: binding.shortcut,
    ...(binding.whenAst ? { whenAst: binding.whenAst } : {}),
  }));
}

const DEFAULT_BINDINGS = compile([
  {
    shortcut: {
      key: "u",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: true,
      modKey: false,
    },
    command: "usage.peek",
  },
  { shortcut: modShortcut("b"), command: "sidebar.toggle" },
  { shortcut: modShortcut("j"), command: "terminal.toggle" },
  { shortcut: modShortcut("b", { altKey: true }), command: "rightPanel.toggle" },
  {
    shortcut: modShortcut("d"),
    command: "terminal.split",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("d", { shiftKey: true }),
    command: "terminal.splitVertical",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("n"),
    command: "terminal.new",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("w"),
    command: "terminal.close",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("w"),
    command: "rightPanel.close",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("d"),
    command: "diff.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("k"),
    command: "commandPalette.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("p"),
    command: "filePicker.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("g", { altKey: true }),
    command: "projectSearch.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("f", { shiftKey: true }),
    command: "projectScope.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("k", { altKey: true }),
    command: "threadSearch.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("t", { altKey: true, shiftKey: true }),
    command: "themeEditor.toggle",
  },
  {
    shortcut: modShortcut("f"),
    command: "chat.find",
    whenAst: whenAnd(
      whenNot(whenIdentifier("terminalFocus")),
      whenNot(whenIdentifier("previewFocus")),
    ),
  },
  {
    shortcut: modShortcut("m", { shiftKey: true }),
    command: "modelPicker.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  { shortcut: modShortcut("o", { shiftKey: true }), command: "chat.new" },
  { shortcut: modShortcut("n", { shiftKey: true }), command: "chat.newLocal" },
  { shortcut: modShortcut("o"), command: "editor.openFavorite" },
  { shortcut: modShortcut("[", { shiftKey: true }), command: "thread.previous" },
  { shortcut: modShortcut("]", { shiftKey: true }), command: "thread.next" },
  {
    shortcut: modShortcut("c", { shiftKey: true }),
    command: "thread.copyReference",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("s", { shiftKey: true }),
    command: "thread.settle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  { shortcut: modShortcut("1"), command: "thread.jump.1" },
  { shortcut: modShortcut("2"), command: "thread.jump.2" },
  { shortcut: modShortcut("3"), command: "thread.jump.3" },
  {
    shortcut: modShortcut("1"),
    command: "modelPicker.jump.1",
    whenAst: whenIdentifier("modelPickerOpen"),
  },
  {
    shortcut: modShortcut("2"),
    command: "modelPicker.jump.2",
    whenAst: whenIdentifier("modelPickerOpen"),
  },
  {
    shortcut: modShortcut("3"),
    command: "modelPicker.jump.3",
    whenAst: whenIdentifier("modelPickerOpen"),
  },
]);

describe("effectiveShortcutsForCommand", () => {
  it("passes only effective preview shortcuts to the desktop bridge", () => {
    const reopen = modShortcut("t", { shiftKey: true });
    const second = modShortcut("y", { shiftKey: true });
    const keybindings = compile([
      { shortcut: reopen, command: "view.reopenClosed" },
      {
        shortcut: second,
        command: "view.reopenClosed",
        whenAst: whenIdentifier("previewFocus"),
      },
      {
        shortcut: reopen,
        command: "preview.toggle",
        whenAst: whenIdentifier("previewFocus"),
      },
    ]);
    assert.deepEqual(
      effectiveShortcutsForCommand(keybindings, "view.reopenClosed", {
        platform: "MacIntel",
        context: { previewFocus: true, previewOpen: true },
      }),
      [second],
    );
    assert.deepEqual(
      effectiveShortcutsForCommand(keybindings, "view.reopenClosed", {
        platform: "MacIntel",
        context: { previewFocus: false },
      }),
      [reopen],
    );
  });
});

describe("settle thread shortcut", () => {
  it("does not intercept the terminal", () => {
    assert.isNull(
      resolveShortcutCommand(event({ key: "s", ctrlKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "Win32",
        context: { terminalFocus: true },
      }),
    );
  });
});

describe("thread undo shortcut", () => {
  it("leaves native undo alone inside text fields and terminals", () => {
    assert.isNull(
      resolveShortcutCommand(event({ key: "z", ctrlKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Win32",
        context: { editableFocus: true },
      }),
    );
    assert.isNull(
      resolveShortcutCommand(event({ key: "z", ctrlKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Win32",
        context: { terminalFocus: true },
      }),
    );
  });
});

describe("split/new/close terminal shortcuts", () => {
  it("supports when expressions", () => {
    const keybindings = compile([
      {
        shortcut: modShortcut("\\"),
        command: "terminal.split",
        whenAst: whenAnd(whenIdentifier("terminalOpen"), whenNot(whenIdentifier("terminalFocus"))),
      },
      {
        shortcut: modShortcut("n", { shiftKey: true }),
        command: "terminal.new",
        whenAst: whenAnd(whenIdentifier("terminalOpen"), whenNot(whenIdentifier("terminalFocus"))),
      },
      { shortcut: modShortcut("j"), command: "terminal.toggle" },
    ]);
    assert.isTrue(
      isTerminalSplitShortcut(event({ key: "\\", ctrlKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: true, terminalFocus: false },
      }),
    );
    assert.isFalse(
      isTerminalSplitShortcut(event({ key: "\\", ctrlKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: false, terminalFocus: false },
      }),
    );
    assert.isTrue(
      isTerminalNewShortcut(event({ key: "n", ctrlKey: true, shiftKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: true, terminalFocus: false },
      }),
    );
  });
});

describe("shortcutLabelForCommand", () => {
  it("returns the effective binding label", () => {
    const bindings = compile([
      {
        shortcut: modShortcut("\\"),
        command: "terminal.split",
        whenAst: whenIdentifier("terminalFocus"),
      },
      {
        shortcut: modShortcut("\\", { shiftKey: true }),
        command: "terminal.split",
        whenAst: whenNot(whenIdentifier("terminalFocus")),
      },
    ]);
    assert.strictEqual(
      shortcutLabelForCommand(bindings, "terminal.split", {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
      "Ctrl+Shift+\\",
    );
  });

  it("returns effective labels for non-terminal commands", () => {
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "sidebar.toggle", "MacIntel"),
      "⌘B",
    );
    assert.strictEqual(shortcutLabelForCommand(DEFAULT_BINDINGS, "chat.new", "MacIntel"), "⇧⌘O");
    assert.strictEqual(shortcutLabelForCommand(DEFAULT_BINDINGS, "diff.toggle", "Linux"), "Ctrl+D");
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "rightPanel.toggle", "MacIntel"),
      "⌥⌘B",
    );
    assert.strictEqual(shortcutLabelForCommand(DEFAULT_BINDINGS, "usage.peek", "Linux"), "Alt+U");
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "commandPalette.toggle", "MacIntel"),
      "⌘K",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "filePicker.toggle", "MacIntel"),
      "⌘P",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "projectSearch.toggle", "MacIntel"),
      "⌥⌘G",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "projectScope.toggle", "MacIntel"),
      "⇧⌘F",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "modelPicker.toggle", "Linux"),
      "Ctrl+Shift+M",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "editor.openFavorite", "Linux"),
      "Ctrl+O",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "thread.jump.3", "MacIntel"),
      "⌘3",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "thread.previous", "Linux"),
      "Ctrl+Shift+[",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "modelPicker.jump.3", {
        platform: "MacIntel",
        context: { modelPickerOpen: true },
      }),
      "⌘3",
    );
  });

  it("resolves the effective held Usage shortcut after precedence", () => {
    const bindings = compile([
      {
        shortcut: {
          key: "u",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: true,
          modKey: false,
        },
        command: "usage.peek",
      },
      { shortcut: modShortcut("u"), command: "diff.toggle" },
    ]);

    assert.deepEqual(
      findEffectiveShortcutForCommand(bindings, "usage.peek", { platform: "Linux" }),
      {
        key: "u",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: true,
        modKey: false,
      },
    );
  });

  it("returns null for commands shadowed by a later conflicting shortcut", () => {
    const bindings = compile([
      { shortcut: modShortcut("1", { shiftKey: true }), command: "thread.jump.1" },
      { shortcut: modShortcut("1", { shiftKey: true }), command: "thread.jump.7" },
    ]);

    assert.isNull(shortcutLabelForCommand(bindings, "thread.jump.1", "MacIntel"));
    assert.strictEqual(shortcutLabelForCommand(bindings, "thread.jump.7", "MacIntel"), "⇧⌘1");
  });

  it("respects when-context while resolving labels", () => {
    const bindings = compile([
      { shortcut: modShortcut("d"), command: "diff.toggle" },
      {
        shortcut: modShortcut("d"),
        command: "terminal.split",
        whenAst: whenIdentifier("terminalFocus"),
      },
    ]);

    assert.strictEqual(
      shortcutLabelForCommand(bindings, "diff.toggle", {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
      "Ctrl+D",
    );
    assert.isNull(
      shortcutLabelForCommand(bindings, "diff.toggle", {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
    assert.strictEqual(
      shortcutLabelForCommand(bindings, "terminal.split", {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
      "Ctrl+D",
    );
  });
});

describe("thread navigation helpers", () => {
  it("maps jump commands to visible thread indices", () => {
    assert.strictEqual(threadJumpCommandForIndex(0), "thread.jump.1");
    assert.strictEqual(threadJumpCommandForIndex(2), "thread.jump.3");
    // Mesura: a tenth jump, on mod+0.
    assert.strictEqual(threadJumpCommandForIndex(9), "thread.jump.10");
    assert.isNull(threadJumpCommandForIndex(10));
    assert.strictEqual(threadJumpIndexFromCommand("thread.jump.10"), 9);
    assert.strictEqual(threadJumpIndexFromCommand("thread.jump.1"), 0);
    assert.strictEqual(threadJumpIndexFromCommand("thread.jump.3"), 2);
    assert.isNull(threadJumpIndexFromCommand("thread.next"));
  });

  it("maps traversal commands to directions", () => {
    assert.strictEqual(threadTraversalDirectionFromCommand("thread.previous"), "previous");
    assert.strictEqual(threadTraversalDirectionFromCommand("thread.next"), "next");
    assert.strictEqual(threadTraversalDirectionFromCommand("thread.nextPage"), "next-page");
    assert.strictEqual(threadTraversalDirectionFromCommand("thread.previousPage"), "previous-page");
    assert.isNull(threadTraversalDirectionFromCommand("thread.jump.1"));
    assert.isNull(threadTraversalDirectionFromCommand(null));
  });

  it("shows jump hints only when configured modifiers match", () => {
    assert.isTrue(
      shouldShowThreadJumpHintsForModifiers(event({ metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
    );
    assert.isFalse(
      shouldShowThreadJumpHintsForModifiers(
        event({ metaKey: true, shiftKey: true }),
        DEFAULT_BINDINGS,
        {
          platform: "MacIntel",
        },
      ),
    );
    assert.isTrue(
      shouldShowThreadJumpHintsForModifiers(event({ ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
      }),
    );
  });

  it("never shows jump hints while the terminal is focused, even with an unrestricted binding", () => {
    assert.isFalse(
      shouldShowThreadJumpHintsForModifiers(event({ metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
    assert.isTrue(
      shouldShowThreadJumpHintsForModifiers(event({ metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
  });

  it("keeps default thread jumps off the web so the browser can switch tabs", () => {
    const input = event({ key: "1", metaKey: true });
    assert.isNull(
      resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { isDesktop: false },
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { isDesktop: true },
      }),
      "thread.jump.1",
    );
    assert.isFalse(
      shouldShowThreadJumpHintsForModifiers(
        event({ metaKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        {
          platform: "MacIntel",
          context: { isDesktop: false },
        },
      ),
    );
    assert.isTrue(
      shouldShowThreadJumpHintsForModifiers(
        event({ metaKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        {
          platform: "MacIntel",
          context: { isDesktop: true },
        },
      ),
    );
  });
});

describe("model picker navigation helpers", () => {
  it("keeps default model jumps off the web even while the picker is open", () => {
    const input = event({ key: "3", metaKey: true });
    assert.isNull(
      resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { isDesktop: false, modelPickerOpen: true },
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { isDesktop: true, modelPickerOpen: true },
      }),
      "modelPicker.jump.3",
    );
    assert.strictEqual(
      resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { isDesktop: true, modelPickerOpen: false },
      }),
      "thread.jump.3",
    );
  });
});

describe("chat/editor shortcuts", () => {
  it("toggles the thread panel by default without taking terminal keystrokes", () => {
    for (const platform of ["MacIntel", "Win32", "Linux"]) {
      const input = event({
        key: "b",
        metaKey: platform === "MacIntel",
        ctrlKey: platform !== "MacIntel",
        shiftKey: true,
      });
      assert.strictEqual(
        resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
          platform,
          context: { terminalFocus: false, editableFocus: true },
        }),
        "threadPanel.toggle",
      );
      assert.isNull(
        resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
          platform,
          context: { terminalFocus: true },
        }),
      );
    }
  });

  it("preserves a user-configured thread panel shortcut instead of its default", () => {
    const bindings = mergeWithDefaultKeybindings(
      compile([
        {
          shortcut: modShortcut("b", { altKey: true, shiftKey: true }),
          command: "threadPanel.toggle",
        },
      ]),
    );

    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "b", metaKey: true, altKey: true, shiftKey: true }),
        bindings,
        { platform: "MacIntel" },
      ),
      "threadPanel.toggle",
    );
    assert.isNull(
      resolveShortcutCommand(event({ key: "b", metaKey: true, shiftKey: true }), bindings, {
        platform: "MacIntel",
      }),
    );
  });

  it("matches themeEditor.toggle on macOS and Windows", () => {
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "t", metaKey: true, altKey: true, shiftKey: true }),
        DEFAULT_BINDINGS,
        { platform: "MacIntel" },
      ),
      "themeEditor.toggle",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "t", ctrlKey: true, altKey: true, shiftKey: true }),
        DEFAULT_BINDINGS,
        { platform: "Win32" },
      ),
      "themeEditor.toggle",
    );
  });

  it("matches filePicker.toggle shortcut outside terminal focus", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "p", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "filePicker.toggle",
    );
    assert.notStrictEqual(
      resolveShortcutCommand(event({ key: "p", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
      "filePicker.toggle",
    );
  });

  it("matches projectSearch.toggle shortcut outside terminal focus", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "g", metaKey: true, altKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "projectSearch.toggle",
    );
    assert.notStrictEqual(
      resolveShortcutCommand(event({ key: "g", metaKey: true, altKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
      "projectSearch.toggle",
    );
  });

  it("matches projectScope.toggle shortcut outside terminal focus", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "f", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "projectScope.toggle",
    );
    assert.notStrictEqual(
      resolveShortcutCommand(event({ key: "f", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
      "projectScope.toggle",
    );
  });

  it("matches themeEditor.toggle on macOS and Windows", () => {
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "t", metaKey: true, altKey: true, shiftKey: true }),
        DEFAULT_BINDINGS,
        { platform: "MacIntel" },
      ),
      "themeEditor.toggle",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "t", ctrlKey: true, altKey: true, shiftKey: true }),
        DEFAULT_BINDINGS,
        { platform: "Win32" },
      ),
      "themeEditor.toggle",
    );
  });

  it("matches diff.toggle shortcut outside terminal focus", () => {
    assert.isTrue(
      isDiffToggleShortcut(event({ key: "d", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
    assert.isFalse(
      isDiffToggleShortcut(event({ key: "d", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
  });
});

describe("cross-command precedence", () => {
  it("uses when + order so a later focused rule overrides a global rule", () => {
    const keybindings = compile([
      { shortcut: modShortcut("n"), command: "chat.new" },
      {
        shortcut: modShortcut("n"),
        command: "terminal.new",
        whenAst: whenIdentifier("terminalFocus"),
      },
    ]);

    assert.isTrue(
      isTerminalNewShortcut(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
      "terminal.new",
    );
    assert.isFalse(
      isTerminalNewShortcut(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "chat.new",
    );
  });

  it("still lets a later global rule win when both rules match", () => {
    const keybindings = compile([
      {
        shortcut: modShortcut("n"),
        command: "terminal.new",
        whenAst: whenIdentifier("terminalFocus"),
      },
      { shortcut: modShortcut("n"), command: "chat.new" },
    ]);

    assert.isFalse(
      isTerminalNewShortcut(event({ key: "n", ctrlKey: true }), keybindings, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "n", ctrlKey: true }), keybindings, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
      "chat.new",
    );
  });
});

describe("resolveChatShortcutCommand", () => {
  it("runs the active environment's script shortcut instead of the primary environment's", () => {
    const primary = compile([{ shortcut: modShortcut("r"), command: "script.setup.run" }]);
    const active = compile([{ shortcut: modShortcut("t"), command: "script.setup.run" }]);

    assert.strictEqual(
      resolveChatShortcutCommand(event({ key: "t", ctrlKey: true }), primary, active, {
        platform: "Linux",
      }),
      "script.setup.run",
    );
    assert.isNull(
      resolveChatShortcutCommand(event({ key: "r", ctrlKey: true }), primary, active, {
        platform: "Linux",
      }),
    );
  });

  it("does not run primary scripts before the active environment's bindings arrive", () => {
    const primary = compile([{ shortcut: modShortcut("r"), command: "script.setup.run" }]);

    assert.isNull(
      resolveChatShortcutCommand(event({ key: "r", ctrlKey: true }), primary, [], {
        platform: "Linux",
      }),
    );
  });

  it("keeps primary app commands ahead of conflicting active script shortcuts", () => {
    const primary = compile([{ shortcut: modShortcut("k"), command: "commandPalette.toggle" }]);
    const active = compile([{ shortcut: modShortcut("k"), command: "script.setup.run" }]);

    assert.strictEqual(
      resolveChatShortcutCommand(event({ key: "k", ctrlKey: true }), primary, active, {
        platform: "Linux",
      }),
      "commandPalette.toggle",
    );
  });

  it("keeps app shortcuts on the primary environment when the active environment remaps them", () => {
    const primary = compile([{ shortcut: modShortcut("j"), command: "terminal.toggle" }]);
    const active = compile([{ shortcut: modShortcut("t"), command: "terminal.toggle" }]);

    assert.strictEqual(
      resolveChatShortcutCommand(event({ key: "j", ctrlKey: true }), primary, active, {
        platform: "Linux",
      }),
      "terminal.toggle",
    );
    assert.isNull(
      resolveChatShortcutCommand(event({ key: "t", ctrlKey: true }), primary, active, {
        platform: "Linux",
      }),
    );
  });

  it.each([false, true])(
    "preserves active binding precedence with terminalFocus=%s",
    (terminalFocus) => {
      const primary = compile([{ shortcut: modShortcut("r"), command: "script.setup.run" }]);
      const active = compile([
        { shortcut: modShortcut("r"), command: "script.deploy.run" },
        {
          shortcut: modShortcut("r"),
          command: "terminal.new",
          whenAst: whenIdentifier("terminalFocus"),
        },
      ]);
      const options = { platform: "Linux", context: { terminalFocus } };
      const shortcut = event({ key: "r", ctrlKey: true });

      assert.strictEqual(
        resolveChatShortcutCommand(shortcut, primary, active, options),
        terminalFocus ? null : "script.deploy.run",
      );
      assert.strictEqual(
        resolveChatShortcutCommand(shortcut, active, active, options),
        resolveShortcutCommand(shortcut, active, options),
      );
    },
  );
});

describe("resolveShortcutCommand", () => {
  it("routes mod+w to the terminal while focused and to the right panel otherwise", () => {
    const closeEvent = event({ key: "w", metaKey: true });
    assert.strictEqual(
      resolveShortcutCommand(closeEvent, DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
      "terminal.close",
    );
    assert.strictEqual(
      resolveShortcutCommand(closeEvent, DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "rightPanel.close",
    );
  });

  it("navigates history with mod+[ and mod+] outside the terminal", () => {
    const back = event({ key: "[", code: "BracketLeft", metaKey: true });
    const forward = event({ key: "]", code: "BracketRight", ctrlKey: true });
    assert.strictEqual(
      resolveShortcutCommand(back, DEFAULT_RESOLVED_KEYBINDINGS, { platform: "MacIntel" }),
      "navigation.back",
    );
    assert.strictEqual(
      resolveShortcutCommand(forward, DEFAULT_RESOLVED_KEYBINDINGS, { platform: "Linux" }),
      "navigation.forward",
    );
    assert.isNull(
      resolveShortcutCommand(back, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
  });

  it("matches punctuation shortcuts by physical key across keyboard layouts", () => {
    const keybindings = compile([
      { shortcut: modShortcut("'", { shiftKey: true }), command: "diff.toggle" },
    ]);

    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "@", code: "Quote", metaKey: true, shiftKey: true }),
        keybindings,
        { platform: "MacIntel" },
      ),
      "diff.toggle",
    );
    assert.isNull(
      resolveShortcutCommand(
        event({ key: '"', code: "Digit2", metaKey: true, shiftKey: true }),
        keybindings,
        { platform: "MacIntel" },
      ),
    );
  });

  it("does not let a punctuation position shadow a Latin layout key", () => {
    const keybindings = compile([
      { shortcut: modShortcut("m"), command: "diff.toggle" },
      { shortcut: modShortcut(";"), command: "sidebar.toggle" },
    ]);

    assert.strictEqual(
      resolveShortcutCommand(event({ key: "m", code: "Semicolon", metaKey: true }), keybindings, {
        platform: "MacIntel",
      }),
      "diff.toggle",
    );
  });

  it("matches Option-modified letters using the physical key code on macOS", () => {
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "∫", code: "KeyB", metaKey: true, altKey: true }),
        DEFAULT_BINDINGS,
        { platform: "MacIntel" },
      ),
      "rightPanel.toggle",
    );
  });

  it("matches non-Latin layout letters using the physical key code", () => {
    const keybindings = compile([{ shortcut: modShortcut("d"), command: "diff.toggle" }]);

    assert.strictEqual(
      resolveShortcutCommand(event({ key: "в", code: "KeyD", metaKey: true }), keybindings, {
        platform: "MacIntel",
      }),
      "diff.toggle",
    );
  });

  it("ignores the physical key code when the layout types a different Latin letter", () => {
    const keybindings = compile([{ shortcut: modShortcut("d"), command: "diff.toggle" }]);

    assert.isNull(
      resolveShortcutCommand(event({ key: "a", code: "KeyD", metaKey: true }), keybindings, {
        platform: "MacIntel",
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "d", code: "KeyL", metaKey: true }), keybindings, {
        platform: "MacIntel",
      }),
      "diff.toggle",
    );
  });
});

describe("isRichTextBoldShortcut", () => {
  const selected = { isCollapsed: false };

  it("matches the B key on non-Latin layouts, like the sidebar toggle does", () => {
    const cyrillicB = event({ key: "и", code: "KeyB", ctrlKey: true });
    assert.isTrue(isRichTextBoldShortcut(cyrillicB, selected));
    assert.strictEqual(
      resolveShortcutCommand(cyrillicB, DEFAULT_BINDINGS, { platform: "Win32" }),
      "sidebar.toggle",
    );
  });

  it("follows the letter a Latin layout types, not the physical key", () => {
    assert.isFalse(
      isRichTextBoldShortcut(event({ key: "x", code: "KeyB", ctrlKey: true }), selected),
    );
    assert.isTrue(
      isRichTextBoldShortcut(event({ key: "b", code: "KeyN", ctrlKey: true }), selected),
    );
  });

  it("leaves the chord to the sidebar toggle when no text is selected", () => {
    const modB = event({ key: "b", metaKey: true });
    assert.isFalse(isRichTextBoldShortcut(modB, { isCollapsed: true }));
    assert.isFalse(isRichTextBoldShortcut(modB, null));
  });
});

// The suite above resolves against a hand-written mirror of the defaults. This
// block resolves against the real DEFAULT_RESOLVED_KEYBINDINGS, so it also
// catches a default that parses fine but is shadowed by a later rule. Shipped
// order matters: the resolver scans from the end and the last match wins.
describe("shipped defaults on Linux", () => {
  const press = (
    key: string,
    modifiers: Partial<
      Pick<ShortcutEventLike, "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "code">
    > = {},
  ): ShortcutEventLike => ({
    key,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...modifiers,
  });
  const resolve = (
    shortcutEvent: ShortcutEventLike,
    terminalFocus = false,
    pane: Record<string, boolean> = {},
  ) =>
    resolveShortcutCommand(shortcutEvent, DEFAULT_RESOLVED_KEYBINDINGS, {
      platform: "Linux",
      context: { terminalFocus, ...pane },
    });

  it("scrolls the timeline with Ctrl+U and Ctrl+D while the chat has focus", () => {
    // The pair belongs to the chat pane now, not to everywhere that is not
    // the terminal, so the pane has to be said out loud here.
    assert.strictEqual(
      resolve(press("u", { ctrlKey: true }), false, { chatFocus: true }),
      "chat.scrollHalfPageUp",
    );
    assert.strictEqual(
      resolve(press("d", { ctrlKey: true }), false, { chatFocus: true }),
      "chat.scrollHalfPageDown",
    );
  });

  it("gives Ctrl+D back to the terminal when the terminal has focus", () => {
    // terminal.split owns mod+d under terminalFocus. The scroll binding is
    // later in the array but its chatFocus clause has to keep it out, and
    // the terminal drawer is its own pane rather than part of the chat.
    assert.strictEqual(resolve(press("d", { ctrlKey: true }), true), "terminal.split");
  });

  it("moved diff.toggle to Ctrl+Shift+D without colliding with the terminal split", () => {
    assert.strictEqual(resolve(press("d", { ctrlKey: true, shiftKey: true })), "diff.toggle");
    assert.strictEqual(
      resolve(press("d", { ctrlKey: true, shiftKey: true }), true),
      "terminal.splitVertical",
    );
  });

  it("opens the run context drawer and the branch picker", () => {
    assert.strictEqual(resolve(press("w", { altKey: true })), "runContext.toggle");
    assert.strictEqual(resolve(press("b", { altKey: true })), "branchPicker.toggle");
  });

  it("cycles machines and toggles the workspace without opening the drawer", () => {
    assert.strictEqual(
      resolve(press("h", { ctrlKey: true, shiftKey: true })),
      "runContext.cycleMachine",
    );
    assert.strictEqual(
      resolve(press("w", { ctrlKey: true, shiftKey: true })),
      "runContext.toggleWorkspace",
    );
    // The chord a browser lets through: it keeps Ctrl+Shift+W to close the window.
    assert.strictEqual(
      resolve(press("w", { altKey: true, shiftKey: true })),
      "runContext.toggleWorkspace",
    );
  });

  it("toggles the open thread's settled state on mod+shift+s, and leaves the terminal alone", () => {
    assert.strictEqual(
      resolve(press("s", { ctrlKey: true, shiftKey: true })),
      // Upstream's thread.settle owns this chord since the 2026-W35 sync; the
      // fork's thread.toggleSettled does the same thing and is now unbound.
      "thread.settle",
    );
    assert.strictEqual(resolve(press("s", { ctrlKey: true, shiftKey: true }), true), null);
    // mod+s stashes the composer draft and is one Shift away. Asserting it here
    // keeps a future reshuffle from collapsing the two onto one chord, which
    // last-wins resolution would hide rather than report.
    assert.strictEqual(resolve(press("s", { ctrlKey: true })), "composer.stash");
  });

  it("gives alt+s to the hosts peek now that the settle toggle has moved off it", () => {
    // The settle toggle must not keep eating the chord it left. Until the
    // Hosts dock this asserted the chord unbound; the dock's held peek took the
    // free chord, so the chord now resolves to that and to nothing settle-shaped.
    assert.strictEqual(resolve(press("s", { altKey: true })), "hosts.peek");
  });

  it("gives Ctrl+Shift+F to the project scope picker and Ctrl+Alt+G to the search", () => {
    assert.strictEqual(
      resolve(press("f", { ctrlKey: true, shiftKey: true })),
      "projectScope.toggle",
    );
    // v0.0.42 took Ctrl+Shift+G for `composer.branch`, so the project search
    // sits on Ctrl+Alt+G. A RETIRED entry migrates anyone who set the old one.
    assert.strictEqual(
      resolve(press("g", { ctrlKey: true, altKey: true })),
      "projectSearch.toggle",
    );
  });

  it("keeps both off the terminal, which owns its own Ctrl+Shift chords", () => {
    assert.strictEqual(resolve(press("f", { ctrlKey: true, shiftKey: true }), true), null);
    assert.strictEqual(resolve(press("g", { ctrlKey: true, shiftKey: true }), true), null);
  });

  it("keeps alt+b clear of the right-panel toggle on mod+alt+b", () => {
    assert.strictEqual(resolve(press("b", { ctrlKey: true, altKey: true })), "rightPanel.toggle");
  });

  it("folds the question prompt on alt+q, and leaves the terminal alone", () => {
    assert.strictEqual(resolve(press("q", { altKey: true })), "question.toggleCollapse");
    assert.strictEqual(resolve(press("q", { altKey: true }), true), null);
  });

  it("leaves AltGr+Q free to type the character it produces", () => {
    // Chromium on Linux reports AltGr as ctrl+alt; a Latin American layout types "@" there.
    // `code` must be set: resolveEventKeys falls back to the physical letter for a non-Latin
    // key, so "@" alone would match no shortcut for a reason unrelated to the modifiers.
    assert.strictEqual(resolve(press("@", { ctrlKey: true, altKey: true, code: "KeyQ" })), null);
  });

  it("still folds on Option+Q, where macOS types a ligature instead of a letter", () => {
    // The other half of the same fallback: no ctrl, so this is a real alt+q
    // that happens to produce "œ". The physical KeyQ has to carry it through.
    assert.strictEqual(
      resolve(press("œ", { altKey: true, code: "KeyQ" })),
      "question.toggleCollapse",
    );
  });

  it("navigates threads with the desktop-only tab pair as well as the brackets", () => {
    assert.strictEqual(resolve(press("Tab", { ctrlKey: true })), "thread.next");
    assert.strictEqual(resolve(press("Tab", { ctrlKey: true, shiftKey: true })), "thread.previous");
    assert.strictEqual(resolve(press("]", { ctrlKey: true, shiftKey: true })), "thread.next");
    assert.strictEqual(resolve(press("[", { ctrlKey: true, shiftKey: true })), "thread.previous");
  });

  it("walks the right panel's tabs with the tab pair while the panel has focus", () => {
    const panel = { panelFocus: true };
    assert.strictEqual(
      resolve(press("Tab", { ctrlKey: true }), false, panel),
      "rightPanel.nextTab",
    );
    assert.strictEqual(
      resolve(press("Tab", { ctrlKey: true, shiftKey: true }), false, panel),
      "rightPanel.previousTab",
    );
    assert.strictEqual(resolve(press("t", { ctrlKey: true }), false, panel), "rightPanel.newTab");
    assert.isNull(resolve(press("t", { ctrlKey: true })));
    // A terminal tab keeps ctrl+tab, as it does for the thread pair.
    assert.isNull(resolve(press("Tab", { ctrlKey: true }), true, panel));
    // The bracket pair still walks the threads from the panel.
    assert.strictEqual(
      resolve(press("]", { ctrlKey: true, shiftKey: true }), false, panel),
      "thread.next",
    );
  });

  it("closes with Ctrl+Q what Ctrl+W closes, and keeps Ctrl+W as the label", () => {
    assert.strictEqual(resolve(press("q", { ctrlKey: true })), "rightPanel.close");
    assert.strictEqual(resolve(press("q", { ctrlKey: true }), true), "terminal.close");
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "rightPanel.close", "Linux"),
      "Ctrl+W",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "terminal.close", {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
      "Ctrl+W",
    );
  });

  it("reports the everywhere-works chord as the shortcut label", () => {
    // The resolver returns the binding that wins, which is the last match.
    // Naming ctrl+tab here would be wrong on every surface that never
    // receives it, so the bracket pair has to be ordered last in the defaults.
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "thread.next", "Linux"),
      "Ctrl+Shift+]",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "modelPicker.toggle", "Linux"),
      "Ctrl+Shift+M",
    );
  });

  it("opens the model picker from either of its two defaults", () => {
    assert.strictEqual(resolve(press("m", { altKey: true })), "modelPicker.toggle");
    assert.strictEqual(
      resolve(press("m", { ctrlKey: true, shiftKey: true })),
      "modelPicker.toggle",
    );
  });

  it("opens the composer pickers", () => {
    assert.strictEqual(resolve(press("e", { altKey: true })), "traitsPicker.toggle");
    assert.strictEqual(
      resolve(press("m", { ctrlKey: true, shiftKey: true })),
      "modelPicker.toggle",
    );
  });

  it("leaves every new binding inert while the terminal has focus", () => {
    assert.strictEqual(resolve(press("u", { ctrlKey: true }), true), null);
    assert.strictEqual(resolve(press("e", { altKey: true }), true), null);
    assert.strictEqual(resolve(press("w", { altKey: true }), true), null);
    assert.strictEqual(resolve(press("b", { altKey: true }), true), null);
    // Ghostty encodes ctrl+tab, so an ungated binding would traverse threads
    // and write the key into the shell at the same time. The bracket pair is
    // deliberately not gated, matching the behaviour it already had.
    assert.strictEqual(resolve(press("Tab", { ctrlKey: true }), true), null);
    assert.strictEqual(resolve(press("]", { ctrlKey: true, shiftKey: true }), true), "thread.next");
  });
});

it("labels the thread search shortcut on both platforms", () => {
  assert.strictEqual(
    shortcutLabelForCommand(DEFAULT_BINDINGS, "threadSearch.toggle", "MacIntel"),
    "⌥⌘K",
  );
  assert.strictEqual(
    shortcutLabelForCommand(DEFAULT_BINDINGS, "threadSearch.toggle", "Linux"),
    "Ctrl+Alt+K",
  );
});

it("resolves mod+alt+k to the thread search outside terminal focus", () => {
  assert.strictEqual(
    resolveShortcutCommand(
      { key: "k", metaKey: false, ctrlKey: true, shiftKey: false, altKey: true },
      DEFAULT_BINDINGS,
      { platform: "Linux", context: { terminalFocus: false } },
    ),
    "threadSearch.toggle",
  );
});

/**
 * A stub `document` focused on `activeElement`. It must answer `querySelector`: shortcut
 * resolution queries the page for an open file manager, and a stub without it throws.
 * Null means no file manager; a test that wants one returns an element.
 */
const noFileManagerInPage = () => null;

const stubDocumentFocusedOn = (activeElement: unknown): Document =>
  ({ activeElement, querySelector: noFileManagerInPage }) as unknown as Document;

describe("pane-scoped bindings", () => {
  // No DOM is installed for tests in this workspace, so the focus tree is
  // hand-built, as terminalFocus.test.ts does.
  class PaneElement {
    isConnected = true;
    parent: PaneElement | null = null;
    constructor(readonly selectors: ReadonlyArray<string> = []) {}
    closest(selector: string): PaneElement | null {
      return closestPaneFrom(this, selector);
    }
  }

  function closestPaneFrom(start: PaneElement, selector: string): PaneElement | null {
    let node: PaneElement | null = start;
    while (node !== null) {
      if (node.selectors.includes(selector)) return node;
      node = node.parent;
    }
    return null;
  }

  const CHAT_ROOT = "[data-chat-column-maximized-away]";
  const PANEL_ROOT = "[data-preview-panel-mode]";

  /** Runs `body` with the keyboard inside `paneRootSelector`. */
  function withFocusIn(paneRootSelector: string, body: () => void): void {
    const originalDocument = globalThis.document;
    const originalHTMLElement = globalThis.HTMLElement;
    const root = new PaneElement([paneRootSelector]);
    const active = new PaneElement([]);
    active.parent = root;
    globalThis.HTMLElement = PaneElement as unknown as typeof HTMLElement;
    globalThis.document = stubDocumentFocusedOn(active);
    try {
      body();
    } finally {
      if (originalDocument === undefined) {
        delete (globalThis as { document?: Document }).document;
      } else {
        globalThis.document = originalDocument;
      }
      if (originalHTMLElement === undefined) {
        delete (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement;
      } else {
        globalThis.HTMLElement = originalHTMLElement;
      }
    }
  }

  // The real shipped table, not the hand-built fixture above: what this
  // describe block is about is which pane the shipped default belongs to.
  const scrollUp = () => event({ key: "u", ctrlKey: true });
  const resolve = (context?: Record<string, boolean>) =>
    resolveShortcutCommand(scrollUp(), DEFAULT_RESOLVED_KEYBINDINGS, {
      platform: "Linux",
      ...(context ? { context } : {}),
    });

  it("gives the half-page scroll to the chat and to no other pane", () => {
    assert.strictEqual(resolve({ chatFocus: true }), "chat.scrollHalfPageUp");
    assert.isNull(resolve({ panelFocus: true }));
  });

  it("reads the focused pane from the document when the caller passes no context", () => {
    withFocusIn(CHAT_ROOT, () => {
      assert.strictEqual(resolve(), "chat.scrollHalfPageUp");
    });
    withFocusIn(PANEL_ROOT, () => {
      assert.isNull(resolve());
    });
  });

  it("lets an explicit context override the pane read from the document", () => {
    withFocusIn(CHAT_ROOT, () => {
      assert.isNull(resolve({ chatFocus: false }));
    });
    withFocusIn(PANEL_ROOT, () => {
      assert.strictEqual(resolve({ chatFocus: true }), "chat.scrollHalfPageUp");
    });
  });

  // GUARD, not a spec: true before this change and after it. Reading the
  // focus tree inside the resolver must not make it throw where there is no
  // document, which is every caller outside a browser.
  it("resolves with no document at all, as a non-browser caller has none", () => {
    assert.strictEqual(resolve({ chatFocus: true }), "chat.scrollHalfPageUp");
  });

  /** Runs `body` with a document that counts how often focus was read. */
  function countingFocusReads(paneRootSelector: string, body: () => void): number {
    const originalDocument = globalThis.document;
    const originalHTMLElement = globalThis.HTMLElement;
    const root = new PaneElement([paneRootSelector]);
    const active = new PaneElement([]);
    active.parent = root;
    let reads = 0;
    globalThis.HTMLElement = PaneElement as unknown as typeof HTMLElement;
    globalThis.document = {
      querySelector: noFileManagerInPage,
      get activeElement() {
        reads += 1;
        return active;
      },
    } as unknown as Document;
    try {
      body();
      return reads;
    } finally {
      if (originalDocument === undefined) {
        delete (globalThis as { document?: Document }).document;
      } else {
        globalThis.document = originalDocument;
      }
      if (originalHTMLElement === undefined) {
        delete (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement;
      } else {
        globalThis.HTMLElement = originalHTMLElement;
      }
    }
  }

  it("never reads the focus tree for a key no pane-scoped binding claims", () => {
    // This runs on every keystroke typed anywhere in the app, the embedded
    // Neovim editor included. A plain letter reaches no pane-scoped rule and
    // must cost no DOM walk at all.
    const reads = countingFocusReads(CHAT_ROOT, () => {
      resolveShortcutCommand(event({ key: "q" }), DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Linux",
      });
    });
    assert.strictEqual(reads, 0);
  });

  it("reads the focus tree once, not once per binding, when a pane-scoped key matches", () => {
    const reads = countingFocusReads(CHAT_ROOT, () => {
      assert.strictEqual(resolve(), "chat.scrollHalfPageUp");
    });
    assert.strictEqual(reads, 1);
  });

  it("never reads the focus tree when the caller named every pane itself", () => {
    const reads = countingFocusReads(CHAT_ROOT, () => {
      resolve({ sidebarFocus: false, chatFocus: false, panelFocus: true });
    });
    assert.strictEqual(reads, 0);
  });
});

describe("the sidebar's list chords", () => {
  /**
   * The same hand-built element the pane block uses, plus `tagName`, because
   * what separates a thread row from the search box is what kind of element
   * has the keyboard.
   */
  class SidebarElement {
    parent: SidebarElement | null = null;
    isConnected = true;
    isContentEditable = false;

    constructor(
      readonly tagName: string,
      readonly selectors: ReadonlyArray<string> = [],
    ) {}

    closest(selector: string): SidebarElement | null {
      return closestSidebarFrom(this, selector);
    }
  }

  function closestSidebarFrom(start: SidebarElement, selector: string): SidebarElement | null {
    let node: SidebarElement | null = start;
    while (node !== null) {
      if (node.selectors.includes(selector)) return node;
      node = node.parent;
    }
    return null;
  }

  const SIDEBAR_ROOT = "[data-app-sidebar]";
  const PANEL_ROOT = "[data-preview-panel-mode]";

  /** Runs `body` with `tagName` focused inside `paneRoot`. */
  function withFocusOn(paneRoot: string, tagName: string, body: () => void): void {
    const originalDocument = globalThis.document;
    const originalHTMLElement = globalThis.HTMLElement;
    const root = new SidebarElement("DIV", [paneRoot]);
    const active = new SidebarElement(tagName);
    active.parent = root;
    globalThis.HTMLElement = SidebarElement as unknown as typeof HTMLElement;
    globalThis.document = stubDocumentFocusedOn(active);
    try {
      body();
    } finally {
      if (originalDocument === undefined) {
        delete (globalThis as { document?: Document }).document;
      } else {
        globalThis.document = originalDocument;
      }
      if (originalHTMLElement === undefined) {
        delete (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement;
      } else {
        globalThis.HTMLElement = originalHTMLElement;
      }
    }
  }

  const withSidebarFocusOn = (tagName: string, body: () => void) =>
    withFocusOn(SIDEBAR_ROOT, tagName, body);

  const resolve = (keyEvent: ShortcutEventLike, context?: Record<string, boolean>) =>
    resolveShortcutCommand(keyEvent, DEFAULT_RESOLVED_KEYBINDINGS, {
      platform: "Linux",
      ...(context ? { context } : {}),
    });

  it("walks the list one thread at a time on j and k", () => {
    assert.strictEqual(
      resolve(event({ key: "j" }), { sidebarFocus: true, sidebarSearchFocus: false }),
      "thread.next",
    );
    assert.strictEqual(
      resolve(event({ key: "k" }), { sidebarFocus: true, sidebarSearchFocus: false }),
      "thread.previous",
    );
  });

  it("types a j in the sidebar's search box instead of jumping a thread", () => {
    // The only bare-letter chords in the app. Without this the search box
    // would be unusable for any query containing a j or a k, which is most
    // of them.
    assert.isNull(resolve(event({ key: "j" }), { sidebarFocus: true, sidebarSearchFocus: true }));
    assert.isNull(resolve(event({ key: "k" }), { sidebarFocus: true, sidebarSearchFocus: true }));
  });

  it("leaves a bare j alone everywhere outside the sidebar", () => {
    // `j` is `down` in the embedded Neovim editor and an ordinary letter in
    // the composer. Neither may ever move a thread.
    assert.isNull(resolve(event({ key: "j" }), { sidebarFocus: false }));
    assert.isNull(resolve(event({ key: "k" }), { sidebarFocus: false }));
  });

  it("reads the search box off the focused element when no context is given", () => {
    withSidebarFocusOn("BUTTON", () => {
      assert.strictEqual(resolve(event({ key: "j" })), "thread.next");
    });
    withSidebarFocusOn("INPUT", () => {
      assert.isNull(resolve(event({ key: "j" })));
    });
    withSidebarFocusOn("TEXTAREA", () => {
      assert.isNull(resolve(event({ key: "j" })));
    });
  });

  it("is a motion, not a chord, inside the editor in the right panel", () => {
    // GUARD. `j` is `down` in the embedded Neovim editor in the right panel; the pane read
    // keeps it a letter there. Asserted through the focus tree, because the editor passes
    // no explicit context.
    withFocusOn(PANEL_ROOT, "TEXTAREA", () => {
      assert.isNull(resolve(event({ key: "j" })));
      assert.isNull(resolve(event({ key: "k" })));
    });
    withFocusOn(PANEL_ROOT, "DIV", () => {
      assert.isNull(resolve(event({ key: "j" })));
    });
  });

  it("steps a page with Ctrl+D and Ctrl+U, which three panes each read differently", () => {
    const down = () => event({ key: "d", ctrlKey: true });
    const up = () => event({ key: "u", ctrlKey: true });
    assert.strictEqual(resolve(down(), { sidebarFocus: true }), "thread.nextPage");
    assert.strictEqual(resolve(up(), { sidebarFocus: true }), "thread.previousPage");
    assert.strictEqual(resolve(down(), { chatFocus: true }), "chat.scrollHalfPageDown");
    assert.strictEqual(resolve(down(), { terminalFocus: true }), "terminal.split");
  });
});

describe("Usage shortcuts", () => {
  it("scopes letter shortcuts to Usage", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "t" }), DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Linux",
        context: { usagePageOpen: true },
      }),
      "usage.tokens",
    );
    assert.isNull(
      resolveShortcutCommand(event({ key: "t" }), DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Linux",
      }),
    );
  });

  it.each(["Linux", "MacIntel"])(
    "preserves desktop numbered thread shortcuts on Usage on %s",
    (platform) => {
      const shortcut = event({
        key: "2",
        ctrlKey: platform === "Linux",
        metaKey: platform === "MacIntel",
      });
      assert.strictEqual(
        resolveShortcutCommand(shortcut, DEFAULT_RESOLVED_KEYBINDINGS, {
          platform,
          context: { usagePageOpen: true, isDesktop: true },
        }),
        "thread.jump.2",
      );
      assert.isNotNull(
        shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "thread.jump.2", {
          platform,
          context: { usagePageOpen: true, isDesktop: true },
        }),
      );
    },
  );

  it("matches shifted number keys for periods and only on Usage", () => {
    const shortcut = event({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true });
    assert.strictEqual(
      resolveShortcutCommand(shortcut, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Linux",
        context: { usagePageOpen: true },
      }),
      "usage.period.day",
    );
    assert.isNull(
      resolveShortcutCommand(shortcut, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Linux",
      }),
    );
  });
});

// Upstream's composer and pull request suite, restored whole after the 0.0.46 sync
// merged it into the shipped-defaults suite above. Mesura: composer.host and
// composer.effort have no mod+shift default in this fork (runContext owns
// mod+shift+h), so their rows are left out of the shared shortcut table.
describe("composer and pull request shortcuts", () => {
  it("fills missing number shortcuts without replacing the saved URL binding", () => {
    const olderServerBindings = DEFAULT_RESOLVED_KEYBINDINGS.filter(
      (binding) =>
        binding.command !== "pullRequest.copyNumber" && binding.command !== "thread.copyReference",
    );
    const bindings = mergeWithDefaultKeybindings([
      ...olderServerBindings,
      ...compileResolvedKeybindingsConfig([
        { key: "mod+shift+8", command: "thread.copyReference", when: "!terminalFocus" },
      ]),
    ]);
    for (const [key, command] of [
      ["k", "pullRequest.copyNumber"],
      ["8", "thread.copyReference"],
      ["c", null],
      ["y", null],
    ] as const) {
      assert.strictEqual(
        resolveShortcutCommand(event({ key, metaKey: true, shiftKey: true }), bindings, {
          platform: "MacIntel",
        }),
        command,
      );
    }
  });

  it.each(["terminalOpen", "previewFocus", "previewOpen", "modelPickerOpen", "isWeb", "isDesktop"])(
    "honors custom PR shortcut conditions for %s",
    (condition) => {
      const bindings = compileResolvedKeybindingsConfig([
        { key: "mod+shift+k", command: "thread.copyReference", when: condition },
        { key: "mod+shift+k", command: "pullRequest.copyNumber", when: `!${condition}` },
      ]);
      const input = event({ key: "k", ctrlKey: true, shiftKey: true });
      for (const enabled of [false, true]) {
        assert.strictEqual(
          resolveShortcutCommand(input, bindings, {
            platform: "Linux",
            context: { [condition]: enabled },
          }),
          enabled ? "thread.copyReference" : "pullRequest.copyNumber",
        );
      }
    },
  );

  it.each(["MacIntel", "Win32", "Linux"])(
    "reserves the alternate send chord for the focused composer on %s",
    (platform) => {
      const modifier = {
        metaKey: platform === "MacIntel",
        ctrlKey: platform !== "MacIntel",
      };
      const shiftedEnter = event({ key: "Enter", shiftKey: true, ...modifier });
      for (const composerRequiresModifier of [false, true]) {
        const context = {
          composerFocus: true,
          turnRunning: true,
          composerRequiresModifier,
        };
        assert.strictEqual(
          resolveShortcutCommand(shiftedEnter, DEFAULT_RESOLVED_KEYBINDINGS, {
            platform,
            context,
          }),
          composerRequiresModifier ? "composer.sendAlternate" : "thread.steerQueuedMessage",
        );
        assert.strictEqual(
          shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "composer.sendAlternate", {
            platform,
            context,
          }),
          formatShortcutLabel(
            modShortcut("enter", { shiftKey: composerRequiresModifier }),
            platform,
          ),
        );
        assert.strictEqual(
          resolveShortcutCommand(shiftedEnter, DEFAULT_RESOLVED_KEYBINDINGS, {
            platform,
            context: { ...context, composerFocus: false },
          }),
          "thread.steerQueuedMessage",
        );
      }
    },
  );

  const altEffortBindings = compileResolvedKeybindingsConfig([
    { key: "mod+alt+e", command: "composer.effort", when: "!terminalFocus" },
  ]);

  it("leaves AltGr text entry alone with a custom Alt binding", () => {
    for (const platform of ["Win32", "Linux"]) {
      const input = event({
        key: "€",
        code: "KeyE",
        ctrlKey: true,
        altKey: true,
        getModifierState: (key) => key === "AltGraph",
      });
      assert.isNull(resolveShortcutCommand(input, altEffortBindings, { platform }));
      assert.strictEqual(
        resolveShortcutCommand({ ...input, getModifierState: () => false }, altEffortBindings, {
          platform,
        }),
        "composer.effort",
      );
    }
  });

  it("keeps Firefox modifier reporting usable on Windows and macOS", () => {
    const getModifierState = (key: string) => key === "AltGraph";
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "e", ctrlKey: true, altKey: true, getModifierState }),
        altEffortBindings,
        { platform: "Win32" },
      ),
      "composer.effort",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "´", code: "KeyE", metaKey: true, altKey: true, getModifierState }),
        altEffortBindings,
        { platform: "MacIntel" },
      ),
      "composer.effort",
    );
  });
});

// Mesura: Ctrl+0 is the tenth thread jump, beside Ctrl+1..9.
describe("the tenth thread jump", () => {
  const ctrlZero = (overrides: Partial<ShortcutEventLike> = {}) =>
    event({ key: "0", code: "Digit0", ctrlKey: true, ...overrides });
  const resolveOnLinux = (input: ShortcutEventLike, context: Record<string, boolean>) =>
    resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, { platform: "Linux", context });

  it("jumps to the tenth thread with Ctrl+0 on the desktop, from the number row and the keypad", () => {
    assert.strictEqual(resolveOnLinux(ctrlZero(), { isDesktop: true }), "thread.jump.10");
    assert.strictEqual(
      resolveOnLinux(ctrlZero({ code: "Numpad0" }), { isDesktop: true }),
      "thread.jump.10",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "0", code: "Digit0", metaKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        { platform: "MacIntel", context: { isDesktop: true } },
      ),
      "thread.jump.10",
    );
  });

  it("labels the tenth jump with the modifier and 0", () => {
    const desktop = { context: { isDesktop: true } };
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "thread.jump.10", {
        platform: "Linux",
        ...desktop,
      }),
      "Ctrl+0",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "thread.jump.10", {
        platform: "MacIntel",
        ...desktop,
      }),
      "\u23180",
    );
  });

  it("leaves Ctrl+0 to the browser on the web, as Ctrl+1..9 are left to its tabs", () => {
    assert.isNull(resolveOnLinux(ctrlZero(), { isDesktop: false }));
  });

  it("leaves Ctrl+0 to the preview's reset zoom while the preview has focus", () => {
    assert.strictEqual(
      resolveOnLinux(ctrlZero(), { isDesktop: true, previewFocus: true }),
      "preview.resetZoom",
    );
    assert.isNull(
      shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "thread.jump.10", {
        platform: "Linux",
        context: { isDesktop: true, previewFocus: true },
      }),
    );
    // The first nine still jump there, as before.
    assert.strictEqual(
      resolveOnLinux(event({ key: "1", code: "Digit1", ctrlKey: true }), {
        isDesktop: true,
        previewFocus: true,
      }),
      "thread.jump.1",
    );
  });

  it("follows a rebinding like the other nine", () => {
    const rebound = mergeWithDefaultKeybindings(
      compileResolvedKeybindingsConfig([{ key: "mod+shift+0", command: "thread.jump.10" }]),
    );
    const desktop = { isDesktop: true };
    assert.strictEqual(
      resolveShortcutCommand(ctrlZero({ key: ")", shiftKey: true }), rebound, {
        platform: "Linux",
        context: desktop,
      }),
      "thread.jump.10",
    );
    assert.isNull(
      resolveShortcutCommand(ctrlZero(), rebound, { platform: "Linux", context: desktop }),
    );
    assert.strictEqual(
      shortcutLabelForCommand(rebound, "thread.jump.10", { platform: "Linux", context: desktop }),
      "Ctrl+Shift+0",
    );
  });
});
