import { describe, expect, it } from "vite-plus/test";

import { caretStyleFor, describeMode } from "./nvimMode.ts";

const VISUAL_BLOCK = "\x16";

describe("describeMode", () => {
  it.each([
    ["n", "NORMAL"],
    ["i", "INSERT"],
    ["ic", "INSERT"],
    ["v", "VISUAL"],
    ["V", "V-LINE"],
    [VISUAL_BLOCK, "V-BLOCK"],
    ["R", "REPLACE"],
    ["Rv", "REPLACE"],
    ["c", "COMMAND"],
    ["cv", "COMMAND"],
    ["t", "TERMINAL"],
    ["s", "SELECT"],
    ["S", "SELECT"],
  ])("names %j as %s", (mode, expected) => {
    expect(describeMode(mode)).toBe(expected);
  });

  it.each(["no", "nov", "noV"])("names %s as an operator waiting for a motion", (mode) => {
    // `no` starts with `n`, so a table that checked normal mode first would
    // call this NORMAL — hiding the one state where the next key is about to
    // delete something.
    expect(describeMode(mode)).toBe("OPERATOR");
  });

  it("falls back to normal rather than showing a code nobody can read", () => {
    expect(describeMode("niI")).toBe("NORMAL");
    // Terminal-normal, which a real Neovim reports while a terminal buffer is
    // open and the developer is not typing into it.
    expect(describeMode("nt")).toBe("NORMAL");
    expect(describeMode("")).toBe("NORMAL");
  });
});

describe("caretStyleFor", () => {
  it("is a bar where text is inserted and a block where keys are commands", () => {
    expect(caretStyleFor("i")).toBe("line");
    expect(caretStyleFor("ic")).toBe("line");
    // Replace mode types *on* the character under the caret, so it keeps the
    // block. A bar there would point between two characters and change the
    // one to its left.
    expect(caretStyleFor("R")).toBe("block");
    expect(caretStyleFor("n")).toBe("block");
    expect(caretStyleFor("v")).toBe("block");
    expect(caretStyleFor(VISUAL_BLOCK)).toBe("block");
  });
});
