import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FOREIGN_DOCUMENT_STYLE,
  FOREIGN_DOCUMENT_TOKENS,
  SCROLLBAR_RULES,
} from "@symmetria/fm-core/scrollbar";
import { describe, expect, it } from "vitest";

/**
 * Every colour comes from a declared token.
 *
 * A literal colour in a component or in the stylesheet cannot be re-themed and
 * cannot be found: it does not appear in the token file, so a reader looking
 * for "where is that grey from" is left grepping. This test is what keeps the
 * palette a single place rather than a convention.
 *
 * `theme/tokens.css` is where the literals live, and is the one exemption.
 */

const RENDERER = join(import.meta.dirname, "..", "src");
const TOKENS = join(RENDERER, "theme", "tokens.css");
/**
 * The finder ships its own stylesheet, and it is in scope here.
 *
 * It moved out of this package when its components did, and a rule that is not
 * scanned is a rule that may carry a colour literal. The invariant is about the
 * PANEL AS RENDERED, not about one directory — so the check follows the CSS.
 */
const FINDER_CSS = join(import.meta.dirname, "..", "..", "fm-search", "src", "ui", "finder.css");

/** Hex, `rgb()`, `hsl()` and `oklch()` — every way to write a colour. */
const COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\bcolor-mix\(/;

async function sourceFiles(dir: string, match: RegExp): Promise<string[]> {
  const found: string[] = [];

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(path, match)));
    else if (match.test(entry.name)) found.push(path);
  }
  return found;
}

/** Lines that write a colour, with their file and number, for a useful failure. */
async function colourLiterals(files: readonly string[]): Promise<string[]> {
  const offences: string[] = [];

  for (const file of files) {
    if (file === TOKENS) continue;

    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((line, index) => {
      // A comment may name a colour while describing why it is not written.
      const code = line.replace(/\/\*.*?\*\//g, "").replace(/\/\/.*$/, "");
      if (COLOUR.test(code)) offences.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  return offences;
}

describe("colour inheritance", () => {
  it("puts the mark colour on the row, not on the name", async () => {
    // The regression this pins. With the colour on `.row__name`, the icon —
    // which is that element's SIBLING — resolved `currentColor` against `.row`
    // and stayed foreground-white beside a coloured name. A component test
    // cannot see it: a headless DOM has no cascade to compute.
    const sheet = await readFile(join(RENDERER, "styles.css"), "utf8");

    expect(sheet).toMatch(/^\.row--marked \{$/m);
    expect(sheet).not.toMatch(/\.row--marked \.row__name/);
  });

  it("lets icons inherit the surrounding colour when no palette is supplied", async () => {
    // The rule moved with its component into the finder's package. This test
    // did not move: the property it pins is about how the PANEL renders, and
    // the panel imports that stylesheet.
    const sheet = await readFile(FINDER_CSS, "utf8");
    const rule = /\.file-icon \{[^}]*\}/.exec(sheet)?.[0] ?? "";

    expect(rule).toContain("currentcolor");
  });
});

describe("the palette", () => {
  it("has no colour literal in any component source", async () => {
    const components = await sourceFiles(RENDERER, /\.tsx?$/);

    expect(await colourLiterals(components)).toEqual([]);
  });

  it("has no colour literal in any stylesheet but the token file", async () => {
    // The generated syntax theme is the other exemption: it IS a palette, and
    // it is regenerated from the KDE theme the Qt build reads.
    const sheets = [...(await sourceFiles(RENDERER, /\.css$/)), FINDER_CSS].filter(
      (file) => !file.endsWith("syntax-wine.css"),
    );

    expect(await colourLiterals(sheets)).toEqual([]);
  });

  it("declares every token the stylesheet reads", async () => {
    // A `var(--thing)` with no declaration renders as nothing at all, silently.
    const tokens = await readFile(TOKENS, "utf8");
    const declared = new Set([...tokens.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]));

    const sheets = (await sourceFiles(RENDERER, /\.css$/)).filter((file) => file !== TOKENS);
    const used = new Set<string>();
    for (const sheet of sheets) {
      const text = await readFile(sheet, "utf8");
      for (const match of text.matchAll(/var\((--[\w-]+)\)/g)) used.add(match[1] ?? "");
    }

    expect([...used].filter((token) => !declared.has(token))).toEqual([]);
  });
});

/**
 * Every `selector { … }` block in a sheet, as sorted declaration lists.
 *
 * Sorted and whitespace-flattened so the comparison is about what the rules
 * SAY, not about how either copy is laid out. Comments come out first: the
 * panel's copy explains itself inside its rule bodies and the served copy does
 * not, and that difference is not a drift.
 */
function rulesIn(css: string): Map<string, string[]> {
  const rules = new Map<string, string[]>();

  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = (match[2] ?? "")
      .split(";")
      .map((one) => one.trim().replace(/\s+/g, " "))
      .filter((one) => one !== "")
      .sort();
    rules.set((match[1] ?? "").trim(), declarations);
  }
  return rules;
}

/** The value `tokens.css` declares for one custom property. */
function declaredValue(tokens: string, name: string): string | undefined {
  return new RegExp(`^\\s*${name}:\\s*([^;]+);`, "m").exec(tokens)?.[1]?.trim();
}

/**
 * The scrollbars.
 *
 * Chromium draws a wide white scrollbar with arrow buttons by default, and over
 * a near-black window it is the loudest thing on screen. These assert the rules
 * exist and read from tokens; whether the result LOOKS right is a screenshot's
 * job, and this phase was verified with one.
 */
describe("the scrollbar", () => {
  async function sheet(): Promise<string> {
    return readFile(join(RENDERER, "styles.css"), "utf8");
  }

  it("declares its three tokens", async () => {
    const tokens = await readFile(TOKENS, "utf8");

    expect(tokens).toMatch(/^\s*--scrollbar-width:/m);
    expect(tokens).toMatch(/^\s*--scrollbar-thumb:/m);
    expect(tokens).toMatch(/^\s*--scrollbar-thumb-hover:/m);
  });

  it("sizes the bar from the width token", async () => {
    const rule = /::-webkit-scrollbar\s*\{[^}]*\}/.exec(await sheet())?.[0] ?? "";

    expect(rule).toContain("var(--scrollbar-width)");
  });

  it("paints the thumb from the token, and a different one on hover", async () => {
    const text = await sheet();
    const thumb = /::-webkit-scrollbar-thumb\s*\{[^}]*\}/.exec(text)?.[0] ?? "";
    const hover = /::-webkit-scrollbar-thumb:hover\s*\{[^}]*\}/.exec(text)?.[0] ?? "";

    expect(thumb).toContain("var(--scrollbar-thumb)");
    expect(hover).toContain("var(--scrollbar-thumb-hover)");
  });

  it("rounds the thumb", async () => {
    const thumb = /::-webkit-scrollbar-thumb\s*\{[^}]*\}/.exec(await sheet())?.[0] ?? "";

    expect(thumb).toMatch(/border-radius:/);
  });

  it("leaves the panel's track transparent, so the surface shows through the lane", async () => {
    const track = /::-webkit-scrollbar-track\s*\{[^}]*\}/.exec(await sheet())?.[0] ?? "";
    const tokens = await readFile(TOKENS, "utf8");

    expect(track).toContain("var(--scrollbar-track)");
    expect(declaredValue(tokens, "--scrollbar-track")).toBe("transparent");
  });

  it("draws no arrow buttons at the ends", async () => {
    // The usual reason a restyled scrollbar still looks wrong: the thumb and
    // the track are handled and the two little arrows are left alone.
    const button = /::-webkit-scrollbar-button\s*\{[^}]*\}/.exec(await sheet())?.[0] ?? "";

    expect(button).toMatch(/display:\s*none/);
  });

  it("styles every scrolling surface, not one class at a time", async () => {
    // Applied globally rather than per class. The surfaces that scroll today are
    // the three columns, a preview body, a directory listing and the modal
    // panel; a rule per class would need a seventh edit for the next one.
    //
    // A review read this as checking only that SOME rule is unscoped, and it
    // does not: `every` fails when any single prefix is non-empty. Measured —
    // re-scoping one of the six rules to `.list::-webkit-scrollbar-thumb` and
    // leaving the rest alone fails this test. Noted so the next reader does not
    // "tighten" it into something it already does.
    const selectors = [...(await sheet()).matchAll(/^([^\n{]*)::-webkit-scrollbar[^\n{]*\{/gm)].map(
      (match) => (match[1] ?? "").trim(),
    );

    expect(selectors.length).toBeGreaterThan(0);
    expect(selectors.every((prefix) => prefix === "" || prefix === "*")).toBe(true);
  });

  /**
   * One definition, two documents.
   *
   * A previewed HTML file is a second document with its own cascade — it
   * cannot see one declaration of `styles.css` — so the main process appends
   * `SCROLLBAR_RULES` to every HTML document it serves. The rules therefore
   * exist twice, and these are what stop the copies drifting into two
   * scrollbars that merely resemble each other.
   */
  it("says exactly what the main process serves to a framed document", async () => {
    const shared = rulesIn(SCROLLBAR_RULES);
    const panel = rulesIn(await sheet());

    // Every rule, not a sample: a declaration added to one copy alone is the
    // whole failure being guarded against.
    expect(shared.size).toBe(6);
    for (const [selector, declarations] of shared) {
      expect({ selector, declarations: panel.get(selector) }).toEqual({ selector, declarations });
    }
  });

  it("gives a framed document every one of the panel's own values but one", async () => {
    // A page carries no `tokens.css`, so the served copy has to declare the
    // values itself. Four of the five are the panel's exactly — the two
    // lengths and both thumb colours — which is what makes the lane in a
    // preview the same object as the lane in the file list rather than one
    // that resembles it.
    const tokens = await readFile(TOKENS, "utf8");
    const foreign = rulesIn(FOREIGN_DOCUMENT_TOKENS).get(":root") ?? [];

    for (const name of [
      "--scrollbar-width",
      "--radius-sm",
      "--scrollbar-thumb",
      "--scrollbar-thumb-hover",
    ]) {
      expect(foreign).toContain(`${name}: ${declaredValue(tokens, name)}`);
    }
  });

  it("paints that document's track solid, because transparent cannot work there", async () => {
    // THE finding this arrangement exists for, and the edit a future reader
    // will be tempted to make. Measured against Chromium 41: once a track
    // carries author styles, a framed document composites it against the
    // FRAME's own white base rather than against the page. A previewed page
    // cannot paint that area — a background on its `body` and a background on
    // its `html` were both tried, and both left a white stripe down a dark
    // page, which is worse than the default scrollbar it replaced.
    //
    // Solid, and specifically the panel's own base: that known substrate is
    // what lets the four values above be the panel's rather than a second set
    // chosen to survive an unknown background.
    const tokens = await readFile(TOKENS, "utf8");
    const foreign = rulesIn(FOREIGN_DOCUMENT_TOKENS).get(":root") ?? [];

    expect(foreign).not.toContain("--scrollbar-track: transparent");
    expect(foreign).toContain(`--scrollbar-track: ${declaredValue(tokens, "--background")}`);
  });

  it("travels as one style element, tokens first", async () => {
    // Order matters inside the served text: the rules read the tokens, and a
    // `var()` with no declaration drops its whole declaration silently.
    expect(FOREIGN_DOCUMENT_STYLE.startsWith("<style>")).toBe(true);
    expect(FOREIGN_DOCUMENT_STYLE.endsWith("</style>")).toBe(true);
    expect(FOREIGN_DOCUMENT_STYLE.indexOf(":root")).toBeLessThan(
      FOREIGN_DOCUMENT_STYLE.indexOf("::-webkit-scrollbar"),
    );
  });
});

/**
 * The audio seek control.
 *
 * Its whole rule was once `accent-color: var(--primary)`, which does not style
 * a range input — it re-tints Chromium's NATIVE widget, keeping a full-width
 * opaque track and a 16px thumb beside a 36px waveform drawn at 6% white.
 * Reverting to that would pass every other test in this suite, which is why
 * these exist. As with the scrollbar above, whether the result LOOKS right is a
 * screenshot's job and was verified with one; these pin the mechanics that make
 * the drawing ours rather than the browser's.
 */
describe("the seek control", () => {
  async function sheet(): Promise<string> {
    return readFile(join(RENDERER, "styles.css"), "utf8");
  }

  function rule(text: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`${escaped}\\s*\\{[^}]*\\}`).exec(text)?.[0] ?? "";
  }

  it("takes the drawing away from the browser", async () => {
    // Without this the rest of the rules below are decoration on a native
    // widget that ignores them.
    expect(rule(await sheet(), ".preview__seek-input")).toContain("appearance: none");
  });

  it("keeps its geometry in one place", async () => {
    // The track height is read by three rules and the thumb's offset is
    // computed from both lengths, so a literal repeated per rule un-centres the
    // playhead the first time one of them is edited alone.
    //
    // In the token file and not local to `.preview__seek`, because "declares
    // every token the stylesheet reads" above resolves declarations ONLY from
    // there — a locally declared property fails that test. Found by it.
    const tokens = await readFile(TOKENS, "utf8");

    expect(tokens).toMatch(/^\s*--seek-track:/m);
    expect(tokens).toMatch(/^\s*--seek-thumb:/m);
    expect(rule(await sheet(), ".preview__seek::before")).toContain("var(--seek-track)");
  });

  it("centres the thumb from that geometry rather than from a typed-in offset", async () => {
    const thumb = rule(await sheet(), ".preview__seek-input::-webkit-slider-thumb");

    expect(thumb).toContain("var(--seek-thumb)");
    expect(thumb).toMatch(/margin-top:\s*calc\(/);
  });

  it("never leaves the suppressed outline unreplaced", async () => {
    // `outline: none` with nothing in its place is the failure mode this pins.
    // It matters more here than on an ordinary control: `useKeyDispatch` treats
    // any focused input as a text field and suppresses the entire file-manager
    // key cascade, so this ring is the only sign that j/k have stopped working.
    const text = await sheet();

    expect(rule(text, ".preview__seek-input:focus-visible")).toContain("outline: none");
    expect(rule(text, ".preview__seek-input:focus-visible::-webkit-slider-thumb")).toContain(
      "box-shadow",
    );
  });

  it("draws the ring in something a reader can see", async () => {
    // `--accent` is 8% white, picked to be nearly invisible as a row highlight.
    // A ring drawn in it around an already-white thumb says nothing at all.
    const ring = rule(await sheet(), ".preview__seek-input:focus-visible::-webkit-slider-thumb");

    expect(ring).not.toContain("var(--accent)");
  });

  it("still shows focus where box-shadow is discarded", async () => {
    // Forced colours drops `box-shadow` and keeps `outline: none`, which would
    // remove the only indicator this control has.
    expect(await sheet()).toMatch(/@media \(forced-colors: active\)/);
  });
});

/**
 * The status bar's fixed height belongs to the status bar alone.
 *
 * It did not. `.status-bar` shared its rule with `.path-bar`, and the height,
 * the `overflow: hidden` and the cross-axis centring this phase added went to
 * both — so the breadcrumb bar silently gained a 26-pixel ceiling it had never
 * had. It looks fine only while one row of breadcrumbs is shorter than that.
 *
 * The comment inserted between the two selectors is what hid it: CSS treats a
 * comment as whitespace, so `.path-bar, /* … *\/ .status-bar { }` is still one
 * rule, while it READS as if the block below belongs to the second selector.
 */
describe("the status bar's height", () => {
  /** The stylesheet, split into rules. A comment counts as whitespace to CSS. */
  async function rulesOf(): Promise<string[]> {
    const sheet = await readFile(join(RENDERER, "styles.css"), "utf8");
    return sheet.split("}");
  }

  /** What a rule's selector list actually is, once any comment above it is cut. */
  function selectorOf(rule: string): string {
    return rule.slice(rule.lastIndexOf("*/") + 2).split("{")[0] ?? "";
  }

  /**
   * The declarations alone.
   *
   * Not the whole chunk: these rules carry long comments, and the first version
   * of the assertion below matched the words `overflow:` inside the prose
   * EXPLAINING why the path bar must not have one. A test that fails on its own
   * documentation is worse than no test.
   */
  function bodyOf(rule: string): string {
    // The comment comes off FIRST. These comments quote CSS — one of them
    // contains the literal `.status-bar {` — so taking everything after the
    // first brace lands inside the prose rather than inside the rule.
    const afterComment = rule.slice(rule.lastIndexOf("*/") + 2);
    return afterComment.slice(afterComment.indexOf("{") + 1);
  }

  it("is set on a rule that names only the status bar", async () => {
    const rules = await rulesOf();
    const withHeight = rules.filter((rule) => rule.includes("--status-bar-height)"));

    expect(withHeight.length).toBeGreaterThan(0);
    for (const rule of withHeight) expect(selectorOf(rule)).not.toContain(".path-bar");
  });

  it("leaves the path bar free to be as tall as it needs", async () => {
    // Whatever rule sets `.path-bar` must not fix its height, or a long
    // breadcrumb trail clips with nothing on screen to say why.
    const pathBarRule = (await rulesOf()).find((rule) =>
      /(^|[\s,])\.path-bar(\s|,|$)/.test(selectorOf(rule)),
    );

    expect(pathBarRule).toBeDefined();
    expect(bodyOf(pathBarRule ?? "")).not.toContain("height:");
    expect(bodyOf(pathBarRule ?? "")).not.toContain("overflow:");
  });
});

describe("the file finder's split", () => {
  it("drives the list's share from one declared token", async () => {
    // The user asked for sixty/forty and asked to try fifty/fifty. That second
    // experiment has to be ONE number, which is only true while the rule reads
    // a token rather than a literal.
    const tokens = await readFile(TOKENS, "utf8");
    const styles = await readFile(FINDER_CSS, "utf8");
    expect(tokens).toMatch(/--finder-list-share:\s*0\.5\b/);
    // The gap is subtracted before the share is taken. Declared as a plain
    // percentage the list got its cut of the WHOLE body and the gap came out of
    // the panel alone, which measured 61.5:38.5 in a real window against a
    // token that said sixty/forty.
    expect(styles).toContain("calc((100% - var(--finder-gap)) * var(--finder-list-share))");
  });

  it("lets the list shrink below its content, so a long path elides", async () => {
    // A flex item's default minimum is its content, so without `min-width: 0` a
    // single very long path would push the list past its share and starve it —
    // the exact failure Qt worked around by pinning its information panel to
    // 360px with a hard maximum. The ratio is only safe with this line.
    const styles = await readFile(FINDER_CSS, "utf8");
    const rule = styles.slice(styles.indexOf(".finder__list {"));
    expect(rule.slice(0, rule.indexOf("}"))).toContain("min-width: 0");
  });

  it("cancels the shared list's top margin, so the two panes align", async () => {
    // `.overlay__list` is shared with the zoxide popup and carries
    // `margin: 8px 0 0`, which is right where the list follows the field
    // directly. In the finder the body owns that gap, so the inherited margin
    // both doubles it and drops the list 8px below the panel beside it — two
    // flex siblings under `align-items: stretch`, only one of which moved.
    const styles = await readFile(FINDER_CSS, "utf8");
    const rule = styles.slice(styles.indexOf(".finder__list {"));
    expect(rule.slice(0, rule.indexOf("}"))).toContain("margin-top: 0");
  });
});
