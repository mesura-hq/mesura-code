import { describe, expect, it } from "vite-plus/test";

import type { KeyInput } from "./keyInput";
import { overviewCommandForKey } from "./overviewKeymap";

function key(key: string, mods: Partial<Omit<KeyInput, "key">> = {}): KeyInput {
  return {
    key,
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
    altGraph: false,
    inTextInput: false,
    ...mods,
  };
}

describe("overviewCommandForKey", () => {
  it.each([
    ["h", "left"],
    ["ArrowLeft", "left"],
    ["j", "down"],
    ["ArrowDown", "down"],
    ["k", "up"],
    ["ArrowUp", "up"],
    ["l", "right"],
    ["ArrowRight", "right"],
    ["+", "zoom-in"],
    ["=", "zoom-in"],
    ["-", "zoom-out"],
    ["0", "reset"],
    ["f", "fit"],
    ["o", "toggle"],
    [" ", "toggle"],
    ["Enter", "reveal"],
    ["/", "search"],
    ["n", "search-next"],
    ["s", "flash"],
    ["PageDown", "full-down"],
    ["PageUp", "full-up"],
  ] as const)("maps %s to %s", (pressed, command) => {
    expect(overviewCommandForKey(key(pressed))).toBe(command);
  });

  it("maps the half and full moves on the modifiers", () => {
    expect(overviewCommandForKey(key("d", { ctrl: true }))).toBe("half-down");
    expect(overviewCommandForKey(key("u", { ctrl: true }))).toBe("half-up");
    expect(overviewCommandForKey(key("j", { ctrl: true }))).toBe("half-down");
    expect(overviewCommandForKey(key("ArrowLeft", { ctrl: true }))).toBe("half-left");
    expect(overviewCommandForKey(key("L", { ctrl: true, shift: true }))).toBe("full-right");
    expect(overviewCommandForKey(key("ArrowUp", { ctrl: true, shift: true }))).toBe("full-up");
  });

  it("maps the shifted and alt-ed letters", () => {
    expect(overviewCommandForKey(key("N", { shift: true }))).toBe("search-previous");
    expect(overviewCommandForKey(key("m", { alt: true }))).toBe("toggle-minimap");
    // `+` is Shift+= on most layouts; the symbol is what the table reads.
    expect(overviewCommandForKey(key("+", { shift: true }))).toBe("zoom-in");
    expect(overviewCommandForKey(key("/", { shift: true }))).toBe("search");
  });

  it("yields nothing for Meta, for Ctrl+Alt, or for a text input target", () => {
    expect(overviewCommandForKey(key("j", { meta: true }))).toBeNull();
    expect(overviewCommandForKey(key("j", { ctrl: true, alt: true }))).toBeNull();
    expect(overviewCommandForKey(key("j", { inTextInput: true }))).toBeNull();
    expect(overviewCommandForKey(key("/", { inTextInput: true }))).toBeNull();
    expect(overviewCommandForKey(key("?"))).toBeNull();
    expect(overviewCommandForKey(key("Escape"))).toBeNull();
  });
});
