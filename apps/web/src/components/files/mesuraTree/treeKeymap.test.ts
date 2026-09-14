import { describe, expect, it } from "vite-plus/test";

import { treeCommandForKey, type TreeKeyInput } from "./treeKeymap";

function key(key: string, mods: Partial<Omit<TreeKeyInput, "key">> = {}): TreeKeyInput {
  return {
    key,
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
    inTextInput: false,
    ...mods,
  };
}

describe("treeCommandForKey", () => {
  it.each([
    ["j", "down"],
    ["ArrowDown", "down"],
    ["k", "up"],
    ["ArrowUp", "up"],
    ["h", "left"],
    ["ArrowLeft", "left"],
    ["l", "right"],
    ["ArrowRight", "right"],
    ["o", "toggle"],
    ["Enter", "activate"],
    ["Home", "first"],
    ["End", "last"],
    ["PageDown", "page-down"],
    ["PageUp", "page-up"],
    ["/", "search"],
    ["n", "search-next"],
    ["s", "flash"],
  ] as const)("maps %s to %s", (pressed, command) => {
    expect(treeCommandForKey(key(pressed))).toBe(command);
  });

  it("maps the shifted letters", () => {
    expect(treeCommandForKey(key("G", { shift: true }))).toBe("last");
    expect(treeCommandForKey(key("N", { shift: true }))).toBe("search-previous");
  });

  it("opens search on / from any layout's modifier for it", () => {
    expect(treeCommandForKey(key("/", { shift: true }))).toBe("search");
    expect(treeCommandForKey(key("/", { ctrl: true, alt: true }))).toBe("search");
    expect(treeCommandForKey(key("/", { meta: true }))).toBeNull();
  });

  it("maps the control chords for half pages", () => {
    expect(treeCommandForKey(key("d", { ctrl: true }))).toBe("half-down");
    expect(treeCommandForKey(key("u", { ctrl: true }))).toBe("half-up");
  });

  it("claims nothing with Meta, or with Ctrl and Alt together", () => {
    expect(treeCommandForKey(key("j", { meta: true }))).toBeNull();
    expect(treeCommandForKey(key("d", { ctrl: true, alt: true }))).toBeNull();
    expect(treeCommandForKey(key("j", { alt: true }))).toBeNull();
  });

  it("claims nothing while a text input has focus", () => {
    expect(treeCommandForKey(key("j", { inTextInput: true }))).toBeNull();
    expect(treeCommandForKey(key("Enter", { inTextInput: true }))).toBeNull();
  });

  it("claims nothing for a key the tree does not use", () => {
    expect(treeCommandForKey(key("x"))).toBeNull();
    expect(treeCommandForKey(key("Escape"))).toBeNull();
    expect(treeCommandForKey(key("e", { ctrl: true }))).toBeNull();
  });
});
