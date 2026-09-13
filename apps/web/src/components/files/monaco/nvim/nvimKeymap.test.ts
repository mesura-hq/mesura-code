import { describe, expect, it } from "vite-plus/test";

import { toNvimKey, type NvimKeyEvent } from "./nvimKeymap.ts";

/**
 * Turning a browser key event into Neovim's key notation.
 *
 * Two things make this harder than the table it looks like. The developer's
 * keyboard is Latin-American, where a great many printable characters are
 * produced with Shift or AltGr — so the modifier flags cannot be read as
 * modifiers, and only `event.key` says what was actually typed. And a key that
 * belongs to the browser's own composition — a dead-key accent — must not be
 * routed at all, or the accent is swallowed and the letter arrives bare.
 *
 * `null` means "this key is not ours": the event goes on to Monaco and to the
 * application, untouched.
 */

const event = (overrides: Partial<NvimKeyEvent>): NvimKeyEvent => ({
  key: "",
  code: "",
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  keyCode: 0,
  isComposing: false,
  ...overrides,
});

describe("toNvimKey", () => {
  it.each([
    ["Escape", "<Esc>"],
    ["Enter", "<CR>"],
    ["Backspace", "<BS>"],
    ["Tab", "<Tab>"],
    ["Delete", "<Del>"],
    ["ArrowUp", "<Up>"],
    ["ArrowDown", "<Down>"],
    ["ArrowLeft", "<Left>"],
    ["ArrowRight", "<Right>"],
    ["Home", "<Home>"],
    ["End", "<End>"],
    ["PageUp", "<PageUp>"],
    ["PageDown", "<PageDown>"],
  ])("maps %s to %s", (key, expected) => {
    expect(toNvimKey(event({ key }))).toBe(expected);
  });

  it("sends a printable character as itself", () => {
    expect(toNvimKey(event({ key: "j" }))).toBe("j");
    expect(toNvimKey(event({ key: "J", shiftKey: true }))).toBe("J");
  });

  it("sends a character typed with Shift as the character, not as a modifier", () => {
    // `/` is Shift+7 on a Latin-American layout. Read as a modifier this would
    // become `<S-/>`, which Neovim would not recognise as a search.
    expect(toNvimKey(event({ key: "/", code: "Digit7", shiftKey: true }))).toBe("/");
    expect(toNvimKey(event({ key: ":", code: "Period", shiftKey: true }))).toBe(":");
  });

  it("escapes the one character Neovim's own notation would eat", () => {
    // A literal `<` would open a key name.
    expect(toNvimKey(event({ key: "<" }))).toBe("<lt>");
    expect(toNvimKey(event({ key: " " }))).toBe("<Space>");
  });

  it("composes Control and Alt, and names them the way Neovim does", () => {
    expect(toNvimKey(event({ key: "r", ctrlKey: true }))).toBe("<C-r>");
    expect(toNvimKey(event({ key: "x", altKey: true }))).toBe("<M-x>");
    expect(toNvimKey(event({ key: "Enter", ctrlKey: true }))).toBe("<C-CR>");
  });

  it("refuses a modifier pressed on its own", () => {
    for (const key of ["Shift", "Control", "Alt", "Meta", "CapsLock"]) {
      expect(toNvimKey(event({ key }))).toBeNull();
    }
  });

  it("refuses anything carrying Meta, so the application keeps its shortcuts", () => {
    // Neovim's `<D-` notation exists, and using it here would take the
    // developer's own command palette and file picker away from them.
    expect(toNvimKey(event({ key: "p", metaKey: true }))).toBeNull();
    expect(toNvimKey(event({ key: "k", metaKey: true, ctrlKey: true }))).toBeNull();
  });

  it("refuses everything that belongs to a composition", () => {
    // A dead-key accent. Routed to Neovim, the accent is swallowed and the
    // letter after it arrives bare — the developer types `á` and gets `a`.
    expect(toNvimKey(event({ key: "Dead" }))).toBeNull();
    expect(toNvimKey(event({ key: "Unidentified" }))).toBeNull();
    expect(toNvimKey(event({ key: "a", keyCode: 229 }))).toBeNull();
    expect(toNvimKey(event({ key: "a", isComposing: true }))).toBeNull();
  });

  it("puts Shift back on a named key, where `event.key` cannot carry it", () => {
    // Measured against the developer's own configuration: `<S-Tab>` and
    // `<Tab>` are `vim.snippet.jump` backwards and forwards, so a Shift+Tab
    // that arrives as `<Tab>` jumps the wrong way.
    expect(toNvimKey(event({ key: "Tab", shiftKey: true }))).toBe("<S-Tab>");
    expect(toNvimKey(event({ key: "Enter", shiftKey: true }))).toBe("<S-CR>");
    expect(toNvimKey(event({ key: "ArrowDown", shiftKey: true }))).toBe("<S-Down>");
    expect(toNvimKey(event({ key: "Tab", shiftKey: true, ctrlKey: true }))).toBe("<S-C-Tab>");
  });

  it("leaves Escape alone however it was typed", () => {
    // A `<S-Esc>` almost no configuration maps would strand the developer in
    // insert mode over a Shift held a moment too long.
    expect(toNvimKey(event({ key: "Escape", shiftKey: true }))).toBe("<Esc>");
  });

  it("sends a character the layout already composed", () => {
    // Chromium on Linux resolves a Latin dead-key accent in the layout and
    // reports the finished character on an ordinary keydown — no composition
    // event, no `keyCode` 229. That key is the developer's, and Neovim takes
    // the UTF-8 character as itself.
    expect(toNvimKey(event({ key: "\u00e1" }))).toBe("\u00e1");
    expect(toNvimKey(event({ key: "\u00f1" }))).toBe("\u00f1");
  });

  it("gives Neovim the chords Monaco would otherwise spend on its own undo", () => {
    // Undo has one owner while Neovim drives. These reach `toNvimKey`, so the
    // driver stops them before Monaco's keybinding service sees them, and
    // Neovim gets a key the developer can map. Monaco's own stack is empty by
    // construction anyway — the driver only ever calls `applyEdits` — so even
    // if one leaked through, its `undo` would have nothing to take back.
    expect(toNvimKey(event({ key: "z", ctrlKey: true }))).toBe("<C-z>");
    expect(toNvimKey(event({ key: "y", ctrlKey: true }))).toBe("<C-y>");
    expect(toNvimKey(event({ key: "Z", ctrlKey: true, shiftKey: true }))).toBe("<C-Z>");
    expect(toNvimKey(event({ key: "r", ctrlKey: true }))).toBe("<C-r>");
    expect(toNvimKey(event({ key: "u" }))).toBe("u");
  });

  it("refuses a key name it does not know", () => {
    expect(toNvimKey(event({ key: "BrightnessUp" }))).toBeNull();
  });
});
