import { describe, expect, it } from "vite-plus/test";

import { assignFlashLabels } from "./flash.ts";
import { keyTokenOf, parseKeySequence, type KeyPress } from "./keyToken.ts";
import { compileKeymap, whichKeyRows, type KeymapConfig } from "./keymap.ts";
import { IDLE_SEQUENCE, stepSequence, type SequenceState } from "./sequence.ts";

const press = (overrides: Partial<KeyPress>): KeyPress => ({
  key: "",
  code: "",
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  altGraph: false,
  ...overrides,
});

describe("keyTokenOf", () => {
  it("keeps a produced glyph without Shift, so Latin-American Shift+7 is `/`", () => {
    expect(keyTokenOf(press({ key: "/", code: "Digit7", shiftKey: true }))).toBe("/");
    expect(keyTokenOf(press({ key: "G", code: "KeyG", shiftKey: true }))).toBe("G");
  });

  it("reads an AltGr glyph as the glyph alone", () => {
    expect(
      keyTokenOf(press({ key: "@", code: "KeyQ", ctrlKey: true, altKey: true, altGraph: true })),
    ).toBe("@");
  });

  it("writes Ctrl chords on the physical letter for non-Latin layouts", () => {
    expect(keyTokenOf(press({ key: "в", code: "KeyD", ctrlKey: true }))).toBe("<C-d>");
  });

  it("names special keys and drops Super chords and bare modifiers", () => {
    expect(keyTokenOf(press({ key: " ", code: "Space" }))).toBe("<Space>");
    expect(keyTokenOf(press({ key: "Escape", code: "Escape" }))).toBe("<Esc>");
    expect(keyTokenOf(press({ key: "Tab", code: "Tab", shiftKey: true }))).toBe("<S-Tab>");
    expect(keyTokenOf(press({ key: "j", code: "KeyJ", metaKey: true }))).toBeNull();
    expect(keyTokenOf(press({ key: "Shift", code: "ShiftLeft", shiftKey: true }))).toBeNull();
  });
});

describe("parseKeySequence", () => {
  it("expands the leader and bracket tokens", () => {
    expect(parseKeySequence("<leader>tr")).toEqual(["<Space>", "t", "r"]);
    expect(parseKeySequence("<c-d>")).toEqual(["<C-d>"]);
    expect(parseKeySequence("gg")).toEqual(["g", "g"]);
  });
});

const config: KeymapConfig = {
  leader: "<Space>",
  groups: [{ keys: "<leader>t", label: "thread" }],
  bindings: [
    { mode: "normal", keys: "<leader>tr", command: "thread.rename" },
    { mode: "normal", keys: "<leader>tp", command: "thread.pin" },
    { mode: "normal", keys: "<leader>f", command: "find" },
    { mode: "normal", keys: "<leader>t", command: "conflicts.with.group" },
    { mode: "normal", scope: "chat", keys: "gg", command: "chat.top" },
  ],
};

describe("compileKeymap", () => {
  it("rejects a key that would be both a command and a prefix", () => {
    const keymap = compileKeymap(config);
    expect(keymap.conflicts).toEqual([
      {
        mode: "normal",
        scope: undefined,
        keys: "<leader>t",
        command: "conflicts.with.group",
        reason: "prefix-of-existing",
      },
    ]);
  });

  it("merges scope layers over the global layer", () => {
    const keymap = compileKeymap(config);
    expect(keymap.trieFor("normal", []).children.has("g")).toBe(false);
    expect(keymap.trieFor("normal", ["chat"]).children.has("g")).toBe(true);
    expect(keymap.trieFor("normal", ["chat"]).children.has("<Space>")).toBe(true);
  });

  it("lists which-key rows with group labels first", () => {
    const keymap = compileKeymap(config);
    const leader = keymap.trieFor("normal", []).children.get("<Space>");
    expect(leader?.kind).toBe("node");
    if (leader?.kind !== "node") return;
    expect(whichKeyRows(leader).map((row) => [row.token, row.label ?? row.command])).toEqual([
      ["t", "thread"],
      ["f", "find"],
    ]);
  });
});

describe("stepSequence", () => {
  const trie = compileKeymap(config).trieFor("normal", ["chat"]);
  const feed = (tokens: readonly string[]) => {
    let state: SequenceState = IDLE_SEQUENCE;
    const outcomes = tokens.map((token) => {
      const step = stepSequence(trie, state, token);
      state = step.state;
      return step.outcome.kind === "command" ? step.outcome.command : step.outcome.kind;
    });
    return { outcomes, state };
  };

  it("waits on a prefix with no timeout, then runs the command", () => {
    expect(feed(["<Space>", "t", "r"]).outcomes).toEqual(["pending", "pending", "thread.rename"]);
  });

  it("cancels on Escape and steps back on Backspace", () => {
    expect(feed(["<Space>", "t", "<Esc>"]).outcomes).toEqual(["pending", "pending", "cancelled"]);
    expect(feed(["<Space>", "t", "<BS>", "f"]).outcomes).toEqual([
      "pending",
      "pending",
      "pending",
      "find",
    ]);
  });

  it("accumulates a count before a command", () => {
    let state: SequenceState = IDLE_SEQUENCE;
    for (const token of ["1", "2", "g"]) state = stepSequence(trie, state, token).state;
    const last = stepSequence(trie, state, "g").outcome;
    expect(last).toEqual({ kind: "command", command: "chat.top", count: 12 });
  });

  it("reports keys that leave the trie as unbound", () => {
    expect(feed(["<Space>", "x"]).outcomes).toEqual(["pending", "unbound"]);
  });
});

describe("assignFlashLabels", () => {
  it("never labels with a character that would continue the pattern", () => {
    const labels = assignFlashLabels([
      { id: "near", nextChar: "a", distance: 1 },
      { id: "far", nextChar: "s", distance: 9 },
    ]);
    expect(labels.get("near")).toBe("d");
    expect(labels.get("far")).toBe("f");
  });

  it("keeps a match's previous label while it stays allowed", () => {
    const labels = assignFlashLabels(
      [
        { id: "a", nextChar: undefined, distance: 1 },
        { id: "b", nextChar: undefined, distance: 2 },
      ],
      new Map([["b", "a"]]),
    );
    expect(labels.get("b")).toBe("a");
    expect(labels.get("a")).toBe("s");
  });
});
