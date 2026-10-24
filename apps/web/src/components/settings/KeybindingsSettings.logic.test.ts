import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { groupKeybindingRows, buildKeybindingCommandOptions, filterKeybindingRows } from "./KeybindingsSettings.logic";
import { assert, describe, expect, it } from "vite-plus/test";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import {
  compileResolvedKeybindingsConfig,
  parseKeybindingShortcut,
} from "@t3tools/shared/keybindings";

import { resolveShortcutCommand } from "../../keybindings";

import {
  buildKeybindingRows,
  keybindingConflictLabels,
  keybindingFromKeyboardEvent,
  parseWhenExpressionDraft,
  shortcutToKeybindingInput,
  whenAstToExpression,
} from "./KeybindingsSettings.logic";

describe("KeybindingsSettings.logic", () => {
  it("lists composer, provider, and pull request commands with editable defaults", () => {
    const rows = filterKeybindingRows(buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS), "");
    for (const command of [
      "runContext.toggle",
      "runContext.cycleMachine",
      "runContext.toggleWorkspace",
      "composer.sendAlternate",
      "composer.sendBackground",
      "thread.steerQueuedMessage",
      "thread.editQueuedMessage",
      "composer.mode",
      "composer.workspace",
      "composer.branch",
      "composer.previousWorktree",
      "modelPicker.previousProvider",
      "modelPicker.nextProvider",
      "thread.copyReference",
      "pullRequest.copyNumber",
    ]) {
      expect(rows.find((row) => row.command === command)).toMatchObject({
        source: "Default",
        conflicts: [],
      });
    }
  });
  it("finds the editable shortcut for sending the first queued message", () => {
    expect(filterKeybindingRows(buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS), "first queued")).toContainEqual(
      expect.objectContaining({
        command: "thread.steerQueuedMessage",
        key: "mod+shift+enter",
      }),
    );
  });
  it.each(["pu", "pull request", "copy link", "thread id"])(
    "finds the copy link shortcut with %s",
    (query) => {
      const rows = filterKeybindingRows(buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS), query);
      expect(rows).toContainEqual(
        expect.objectContaining({ command: "thread.copyReference", key: "mod+shift+c" }),
      );
    },
  );
  it("groups rows by command area in page order and drops empty groups", () => {
    const groups = groupKeybindingRows(filterKeybindingRows(buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS), ""));
    expect(groups.map((group) => group.title)).toEqual([
      "Navigation",
      "Threads",
      "Composer",
      "Terminal",
      "Preview & diff",
      "Appearance",
      "Other",
    ]);
    const composer = groups.find((group) => group.id === "composer");
    expect(composer?.rows.map((row) => row.command)).toEqual(
      // Mesura: composer.host ships unbound here, and runContext joins Composer.
      expect.arrayContaining(["composer.mode", "modelPicker.toggle", "runContext.toggle"]),
    );
  });

  it("changes row identity when a shortcut changes", () => {
    const before = buildKeybindingRows(compileResolvedKeybindingsConfig([{ command: "chat.new", key: "mod+n" }]));
    const after = buildKeybindingRows(compileResolvedKeybindingsConfig([{ command: "chat.new", key: "mod+shift+n" }]));
    expect(after.find((row) => row.command === "chat.new")?.id).not.toBe(before.find((row) => row.command === "chat.new")?.id);
  });
  it("orders Usage bindings and command choices like the page", () => {
    const expected = [
      "usage.open",
      "usage.cost",
      "usage.tokens",
      "usage.limits",
      "usage.period.day",
      "usage.period.week",
      "usage.period.month",
      "usage.period.quarter",
      "usage.peek",
    ];
    // The order must not depend on the order of the configured bindings.
    for (const bindings of [
      DEFAULT_RESOLVED_KEYBINDINGS,
      DEFAULT_RESOLVED_KEYBINDINGS.toReversed(),
    ]) {
      expect(filterKeybindingRows(buildKeybindingRows(bindings), "usage").map((row) => row.command)).toEqual(expected);
      expect(
        buildKeybindingCommandOptions(bindings).filter((command) => command.startsWith("usage.")),
      ).toEqual(expected);
    }
  });

  it("shares a stable editor for resolved duplicates but separates commands, shortcuts, and conditions", () => {
    const bindings = compileResolvedKeybindingsConfig([
      { command: "terminal.toggle", key: "mod+esc", when: "terminalFocus" },
      { command: "terminal.toggle", key: "mod+escape", when: "(terminalFocus)" },
      { command: "terminal.toggle", key: "mod+esc", when: "!terminalFocus" },
      { command: "terminal.toggle", key: "mod+j", when: "terminalFocus" },
      { command: "chat.new", key: "mod+esc", when: "terminalFocus" },
    ]);
    const rows = buildKeybindingRows(bindings);
    expect(rows.map(({ command, key, when }) => ({ command, key, when }))).toEqual([
      { command: "chat.new", key: "mod+esc", when: "terminalFocus" },
      { command: "terminal.toggle", key: "mod+esc", when: "terminalFocus" },
      { command: "terminal.toggle", key: "mod+esc", when: "!terminalFocus" },
      { command: "terminal.toggle", key: "mod+j", when: "terminalFocus" },
    ]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(4);
    expect(rows.find((row) => row.command === "chat.new")?.conflicts).toEqual(["Terminal: Toggle"]);
    expect(buildKeybindingRows(bindings.slice(1)).map((row) => row.id)).toEqual(
      rows.map((row) => row.id),
    );
  });

  it("captures platform-specific mod shortcuts", () => {
    expect(
      keybindingFromKeyboardEvent(
        { key: "K", code: "KeyK", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true },
        "MacIntel",
      ),
    ).toBe("mod+shift+k");
    expect(
      keybindingFromKeyboardEvent(
        { key: "K", code: "KeyK", metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
        "Win32",
      ),
    ).toBe("mod+shift+k");
  });

  it("waits for a key when only a modifier is pressed", () => {
    expect(
      keybindingFromKeyboardEvent(
        {
          key: "Meta",
          code: "MetaLeft",
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        },
        "MacIntel",
      ),
    ).toBeNull();
  });

  it.each([
    ["@", "Digit2", "mod+shift+2"],
    ['"', "Digit2", "mod+shift+2"],
    ["@", "Quote", "mod+shift+'"],
  ])("captures %s at %s by physical key", (key, code, expected) => {
    expect(
      keybindingFromKeyboardEvent(
        {
          key,
          code,
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: true,
        },
        "MacIntel",
      ),
    ).toBe(expected);
  });

  it("records layout punctuation while preserving physical Alt shortcuts; saved bindings still trigger", () => {
    for (const { key, code, altKey = false, shiftKey, expected, defaultInput } of [
      { key: "#", code: "Backslash", shiftKey: false, expected: "#", defaultInput: "\\" },
      {
        key: "'",
        code: "Backslash",
        shiftKey: true,
        expected: "shift+'",
        defaultInput: "shift+\\",
      },
      {
        key: "¡",
        code: "Digit1",
        altKey: true,
        shiftKey: false,
        expected: "alt+1",
        defaultInput: "alt+1",
      },
    ]) {
      const pressed = {
        key,
        code,
        metaKey: false,
        ctrlKey: false,
        altKey,
        shiftKey,
      };
      expect(keybindingFromKeyboardEvent(pressed, "MacIntel")).toBe(defaultInput);
      const input = keybindingFromKeyboardEvent(pressed, "MacIntel", { layoutCharacter: true });
      expect(input).toBe(expected);
      assert(input);
      const shortcut = parseKeybindingShortcut(input);
      assert(shortcut);
      expect(
        resolveShortcutCommand(pressed, [{ command: "chat.new", shortcut }], {
          platform: "MacIntel",
        }),
      ).toBe("chat.new");
    }
  });

  it("captures Latin layout keys instead of their punctuation position", () => {
    expect(
      keybindingFromKeyboardEvent(
        {
          key: "m",
          code: "Semicolon",
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        },
        "MacIntel",
      ),
    ).toBe("mod+m");
  });

  it("serializes shortcuts and when expressions for upserts", () => {
    expect(
      shortcutToKeybindingInput({
        key: " ",
        modKey: true,
        metaKey: false,
        ctrlKey: false,
        altKey: true,
        shiftKey: false,
      }),
    ).toBe("mod+alt+space");

    expect(
      whenAstToExpression({
        type: "and",
        left: { type: "identifier", name: "editorFocus" },
        right: {
          type: "not",
          node: { type: "identifier", name: "terminalFocus" },
        },
      }),
    ).toBe("editorFocus && !terminalFocus");

    expect(parseWhenExpressionDraft("editorFocus && (!terminalFocus || modelPickerOpen)")).toEqual({
      ok: true,
      value: {
        type: "and",
        left: { type: "identifier", name: "editorFocus" },
        right: {
          type: "or",
          left: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
          right: { type: "identifier", name: "modelPickerOpen" },
        },
      },
    });
    expect(parseWhenExpressionDraft("editorFocus &&")).toEqual({
      ok: false,
      message: "Use variables with !, &&, ||, and parentheses.",
    });

    expect(parseWhenExpressionDraft("!(terminalFocus || modelPickerOpen)")).toEqual({
      ok: true,
      value: {
        type: "not",
        node: {
          type: "or",
          left: { type: "identifier", name: "terminalFocus" },
          right: { type: "identifier", name: "modelPickerOpen" },
        },
      },
    });
  });

  it("reports conflicting shortcuts that share an active when context", () => {
    const rows = buildKeybindingRows([
      {
        command: "chat.new",
        shortcut: {
          key: "n",
          modKey: true,
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        },
        whenAst: {
          type: "not",
          node: { type: "identifier", name: "terminalFocus" },
        },
      },
      {
        command: "chat.newLocal",
        shortcut: {
          key: "n",
          modKey: true,
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        },
        whenAst: {
          type: "not",
          node: { type: "identifier", name: "terminalFocus" },
        },
      },
    ] satisfies ResolvedKeybindingsConfig);

    expect(rows[0]?.conflicts).toEqual(["Chat: New Local"]);
    expect(
      keybindingConflictLabels(rows, {
        rowId: rows[0]?.id ?? "",
        key: "mod+n",
        when: "",
      }),
    ).toEqual(["Chat: New Local"]);
  });
});

// Mesura: the fork's own capture wrapper (bare Tab passed through, plain
// letters ignored) was superseded by upstream #14548, which records plain keys
// and Tab while recording. These keep the chords this fork relies on covered.
describe("keybindingFromKeyboardEvent for the fork's chords", () => {
  const event = (
    key: string,
    modifiers: Partial<
      Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">
    > = {},
  ) => ({
    key,
    // v0.0.42 reads the chord off the physical key. These fixtures name the
    // layout key alone, which is what a US layout reports for both.
    code: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  });

  it("records a Tab held with a modifier", () => {
    // Thread traversal on Ctrl+Tab was unreachable while every Tab was
    // discarded: the only way to set it was to hand-edit keybindings.json.
    expect(keybindingFromKeyboardEvent(event("Tab", { ctrlKey: true }), "Linux")).toBe("mod+tab");
    expect(
      keybindingFromKeyboardEvent(event("Tab", { ctrlKey: true, shiftKey: true }), "Linux"),
    ).toBe("mod+shift+tab");
  });

  it("records the Alt shortcuts this fork uses for the composer pickers", () => {
    expect(keybindingFromKeyboardEvent(event("e", { altKey: true }), "Linux")).toBe("alt+e");
    expect(keybindingFromKeyboardEvent(event("m", { altKey: true }), "Linux")).toBe("alt+m");
  });
});
