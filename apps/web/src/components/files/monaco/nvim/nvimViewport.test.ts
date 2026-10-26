import { EditorSessionViewportInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_VIEWPORT_HISTORY,
  MINIMUM_VIEWPORT_COLUMNS,
  REMEMBERED_TOPLINES,
  rememberTopline,
  shouldEchoViewport,
  viewportFromEditor,
} from "./nvimViewport.ts";

/**
 * Monaco owns pointer and wheel scrolling, Neovim owns key scrolling, and each tells the other;
 * without the echo rule they scroll each other forever. Neovim draws nothing beyond the grid's
 * width, so a flash label past a narrow grid's last column is never seen.
 */

const range = (start: number, end: number) => ({ startLineNumber: start, endLineNumber: end });

describe("viewportFromEditor", () => {
  const model = {
    getLineCount: () => 500,
    getLineContent: (line: number) => "x".repeat(line === 12 ? 260 : 40),
  };

  it("reports the first visible line as the topline", () => {
    const viewport = viewportFromEditor([range(10, 40)], { height: 620, lineHeight: 20 }, model);
    expect(viewport.topline).toBe(10);
  });

  it("reports the visible line count as rows", () => {
    const viewport = viewportFromEditor([range(10, 40)], { height: 620, lineHeight: 20 }, model);
    expect(viewport.rows).toBe(31);
  });

  it("never asks for a grid narrower than the labels drawn on it", () => {
    // Neovim draws nothing past the grid's width, and flash puts its labels at
    // the end of a match. A grid sized to the text alone loses every label on
    // a long line.
    const viewport = viewportFromEditor([range(100, 120)], { height: 420, lineHeight: 20 }, model);
    expect(viewport.cols).toBe(MINIMUM_VIEWPORT_COLUMNS);
  });

  it("grows the grid for a visible line wider than the minimum", () => {
    const viewport = viewportFromEditor([range(10, 20)], { height: 220, lineHeight: 20 }, model);
    expect(viewport.cols).toBe(260);
  });

  it("takes the whole span when several ranges are visible", () => {
    // Folded regions split the visible ranges, and Neovim has one window with
    // one topline: the span from the first visible line to the last is the
    // only thing that describes what the developer can see.
    const viewport = viewportFromEditor(
      [range(10, 20), range(30, 44)],
      { height: 700, lineHeight: 20 },
      model,
    );
    expect(viewport.topline).toBe(10);
    expect(viewport.rows).toBe(35);
  });

  it("falls back to the editor's height when nothing is visible yet", () => {
    // Called once before Monaco has laid out, where the visible ranges are
    // empty. Sending rows of zero would resize Neovim's grid to nothing.
    const viewport = viewportFromEditor([], { height: 400, lineHeight: 20 }, model);
    expect(viewport.topline).toBe(1);
    expect(viewport.rows).toBe(20);
  });

  it("never reports fewer than one row", () => {
    const viewport = viewportFromEditor([], { height: 0, lineHeight: 20 }, model);
    expect(viewport.rows).toBe(1);
  });
});

describe("viewportFromEditor against the viewport contract", () => {
  it("asks for a viewport the contract accepts whatever the length of a visible line", () => {
    // Phase 2, criterion 5: the contract bounds `cols`, but a line can be longer than any bound
    // (1,087-character Markdown, megabyte minified lines). A refused request never reaches Neovim.
    const accepts = Schema.is(EditorSessionViewportInput);
    for (const length of [1087, 1_000_000]) {
      const wide = {
        getLineCount: () => 300,
        getLineContent: (line: number) => "x".repeat(line === 231 ? length : 600),
      };
      const viewport = viewportFromEditor([range(228, 234)], { height: 140, lineHeight: 20 }, wide);
      expect(
        accepts({ threadId: "thread", ...viewport }),
        `a visible line of ${length} characters asks for cols ${viewport.cols}`,
      ).toBe(true);
    }
  });
});

describe("shouldEchoViewport", () => {
  const history = (sent: ReadonlyArray<number>, fromNeovim: ReadonlyArray<number>) => ({
    sentToplines: sent,
    neovimToplines: fromNeovim,
  });

  it("moves Monaco for a topline a key caused", () => {
    expect(shouldEchoViewport(history([10], [10]), 200)).toBe(true);
  });

  it("ignores the echo of what the client just sent", () => {
    // The ping-pong: Monaco scrolls, the client sends 40, Neovim moves and
    // reports 40 back. Acting on it scrolls Monaco to where it already is and
    // starts the exchange again.
    expect(shouldEchoViewport(history([40], [10]), 40)).toBe(false);
  });

  it("ignores a repeat of the last topline Neovim sent", () => {
    expect(shouldEchoViewport(history([10], [90]), 90)).toBe(false);
  });

  it("moves Monaco on the first viewport of a session", () => {
    expect(shouldEchoViewport(EMPTY_VIEWPORT_HISTORY, 1)).toBe(true);
  });

  it("ignores a stale echo from a scroll the developer has already left", () => {
    // A wheel outruns the round trip. The developer scrolls 10 → 300 → 10
    // before the first answer lands; with one slot remembered, the echo of 300
    // fails the test and the editor jumps back to a position they left.
    const afterScrolling = rememberTopline(rememberTopline([10], 300), 10);
    expect(shouldEchoViewport(history(afterScrolling, []), 300)).toBe(false);
    expect(shouldEchoViewport(history(afterScrolling, []), 10)).toBe(false);
  });

  it("still moves for a topline neither side has seen recently", () => {
    const afterScrolling = rememberTopline(rememberTopline([10], 300), 10);
    expect(shouldEchoViewport(history(afterScrolling, []), 700)).toBe(true);
  });

  it("forgets far enough back that a genuine return is not mistaken for an echo", () => {
    // The memory is short on purpose: a developer who scrolls away and comes
    // back much later is making a new request, not echoing an old one.
    let sent: ReadonlyArray<number> = [42];
    for (let step = 0; step < REMEMBERED_TOPLINES; step += 1) {
      sent = rememberTopline(sent, 100 + step);
    }
    expect(shouldEchoViewport(history(sent, []), 42)).toBe(true);
  });
});
