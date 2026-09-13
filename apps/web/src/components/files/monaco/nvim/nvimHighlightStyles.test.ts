import { describe, expect, it } from "vite-plus/test";

import { highlightClassName, highlightRule, highlightStylesheet } from "./nvimHighlightStyles.ts";

/**
 * Neovim's highlight attributes, as CSS.
 *
 * The colours are the developer's own colourscheme, read out of
 * `hl_attr_define` rather than guessed from a group name — flash's labels, the
 * search highlight and a plugin's own groups all arrive the same way, as an id
 * with attributes attached, and the id is the only thing the drawing refers to.
 *
 * Scoped to one editor by a prefix class, because two file panels showing two
 * threads have two Neovims, and id 7 means something different in each.
 */

const PREFIX = "nvim-scope-abc";

describe("highlightRule", () => {
  it("turns Neovim's packed colours into CSS ones", () => {
    const rule = highlightRule(PREFIX, 7, { fg: 0xff8800, bg: 0x102030, groups: [] });
    expect(rule).toContain(".nvim-scope-abc .mesura-nvim-hl-7");
    expect(rule).toContain("color: #ff8800");
    expect(rule).toContain("background-color: #102030");
  });

  it("pads a colour that does not fill its six digits", () => {
    // `0x00ff00` is a number, and a number does not remember its leading
    // zeroes. Written out unpadded it reads as `#ff00`, which is not a colour.
    const rule = highlightRule(PREFIX, 1, { fg: 0x00ff00, groups: [] });
    expect(rule).toContain("color: #00ff00");
  });

  it("swaps the two colours for a reversed definition", () => {
    // Vim's own `Search` and `IncSearch` are commonly reverse video rather
    // than a pair of colours, so a host that ignores `reverse` draws a match
    // in the text's own colours and shows nothing at all.
    const rule = highlightRule(PREFIX, 2, {
      fg: 0x111111,
      bg: 0xeeeeee,
      reverse: true,
      groups: ["Search"],
    });
    expect(rule).toContain("color: #eeeeee");
    expect(rule).toContain("background-color: #111111");
  });

  it("carries weight, slant and the two kinds of underline", () => {
    const rule = highlightRule(PREFIX, 3, {
      bold: true,
      italic: true,
      underline: true,
      groups: [],
    });
    expect(rule).toContain("font-weight: bold");
    expect(rule).toContain("font-style: italic");
    expect(rule).toContain("text-decoration: underline");

    const wavy = highlightRule(PREFIX, 4, { undercurl: true, groups: [] });
    expect(wavy).toContain("text-decoration: underline wavy");
  });

  it("writes an empty body for a definition with nothing in it", () => {
    // Neovim defines id 0 as the default, with no attributes at all. A rule
    // that invented a colour for it would repaint the whole file.
    const rule = highlightRule(PREFIX, 0, { groups: [] });
    expect(rule).toContain(".mesura-nvim-hl-0");
    expect(rule).not.toContain("color:");
    expect(rule).not.toContain("background-color:");
  });
});

describe("highlightStylesheet", () => {
  it("writes one rule per id", () => {
    const sheet = highlightStylesheet(PREFIX, {
      "1": { fg: 0xff0000, groups: [] },
      "2": { bg: 0x00ff00, groups: [] },
    });
    expect(sheet).toContain(".mesura-nvim-hl-1");
    expect(sheet).toContain(".mesura-nvim-hl-2");
    expect(sheet.split("}").length - 1).toBe(2);
  });

  it("replaces the rule for an id that was defined again", () => {
    // Neovim never redefines an id it has already sent, but a session that was
    // reattached sends them all again, and two rules for one id would leave
    // the outcome to the order they were written in.
    const sheet = highlightStylesheet(PREFIX, {
      "1": { fg: 0xff0000, groups: [] },
    });
    const updated = highlightStylesheet(PREFIX, {
      "1": { fg: 0x0000ff, groups: [] },
    });
    expect(sheet).toContain("color: #ff0000");
    expect(updated).toContain("color: #0000ff");
    expect(updated).not.toContain("#ff0000");
  });
});

describe("highlightClassName", () => {
  it("names a class the drawing and the stylesheet both agree on", () => {
    expect(highlightClassName(7)).toBe("mesura-nvim-hl-7");
  });
});
