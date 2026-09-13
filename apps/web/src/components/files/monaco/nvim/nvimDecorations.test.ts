import { describe, expect, it } from "vite-plus/test";

import {
  applyDecorationEvent,
  EMPTY_DECORATION_STATE,
  overlayWidgetId,
} from "./nvimDecorations.ts";

/**
 * What Neovim drew over the text, kept per row.
 *
 * The rule the whole module exists for is in `rows`: an event fully replaces
 * the rows it lists and says nothing about the rest. A host that took each
 * event as the whole picture would clear every flash label the moment one
 * unrelated row redrew — and under a real configuration a row redraws
 * constantly, so that is not an edge case.
 */

const event = (
  rows: ReadonlyArray<number>,
  overlays: ReadonlyArray<{ line: number; col: number; text: string; hl: number }> = [],
  highlightRuns: ReadonlyArray<{
    line: number;
    startCol: number;
    endCol: number;
    hl: number;
  }> = [],
) => ({ rows, overlays, highlightRuns });

describe("applyDecorationEvent", () => {
  it("keeps the rows an event did not list", () => {
    const first = applyDecorationEvent(
      EMPTY_DECORATION_STATE,
      event([1, 2], [{ line: 1, col: 3, text: "a", hl: 7 }]),
    );
    const second = applyDecorationEvent(
      first.state,
      event([5], [{ line: 5, col: 1, text: "b", hl: 7 }]),
    );

    expect(second.widgets.map((widget) => widget.text).sort()).toEqual(["a", "b"]);
    expect(second.removedWidgetIds).toEqual([]);
  });

  it("replaces a row it does list", () => {
    const first = applyDecorationEvent(
      EMPTY_DECORATION_STATE,
      event([1], [{ line: 1, col: 3, text: "a", hl: 7 }]),
    );
    const second = applyDecorationEvent(
      first.state,
      event([1], [{ line: 1, col: 9, text: "z", hl: 7 }]),
    );

    expect(second.widgets.map((widget) => widget.text)).toEqual(["z"]);
    expect(second.removedWidgetIds).toEqual([overlayWidgetId(1, 3)]);
  });

  it("clears a row an event lists with nothing on it", () => {
    // How a label goes away: flash finishes, the row redraws with only the
    // text on it, and the event says so by listing the row and carrying
    // nothing for it.
    const first = applyDecorationEvent(
      EMPTY_DECORATION_STATE,
      event([1], [{ line: 1, col: 3, text: "a", hl: 7 }]),
    );
    const second = applyDecorationEvent(first.state, event([1]));

    expect(second.widgets).toEqual([]);
    expect(second.removedWidgetIds).toEqual([overlayWidgetId(1, 3)]);
  });

  it("reports a widget that stayed in place with new content as changed", () => {
    // Not removed and added again: a content widget that is taken out and put
    // back flickers, and flash redraws its labels on every keystroke of the
    // search.
    const first = applyDecorationEvent(
      EMPTY_DECORATION_STATE,
      event([1], [{ line: 1, col: 3, text: "a", hl: 7 }]),
    );
    const second = applyDecorationEvent(
      first.state,
      event([1], [{ line: 1, col: 3, text: "b", hl: 8 }]),
    );

    expect(second.addedWidgets).toEqual([]);
    expect(second.removedWidgetIds).toEqual([]);
    expect(second.changedWidgets.map((widget) => widget.text)).toEqual(["b"]);
  });

  it("says nothing changed when the same drawing arrives again", () => {
    const first = applyDecorationEvent(
      EMPTY_DECORATION_STATE,
      event([1], [{ line: 1, col: 3, text: "a", hl: 7 }]),
    );
    const second = applyDecorationEvent(
      first.state,
      event([1], [{ line: 1, col: 3, text: "a", hl: 7 }]),
    );

    expect(second.addedWidgets).toEqual([]);
    expect(second.changedWidgets).toEqual([]);
    expect(second.removedWidgetIds).toEqual([]);
  });

  it("clears everything when every row is listed empty", () => {
    // What a `grid_clear` or a scroll produces: every row named, nothing on
    // any of them.
    const drawn = applyDecorationEvent(
      EMPTY_DECORATION_STATE,
      event(
        [1, 2, 3],
        [
          { line: 1, col: 1, text: "a", hl: 7 },
          { line: 3, col: 1, text: "b", hl: 7 },
        ],
      ),
    );
    const cleared = applyDecorationEvent(drawn.state, event([1, 2, 3]));

    expect(cleared.widgets).toEqual([]);
    expect([...cleared.removedWidgetIds].sort()).toEqual(
      [overlayWidgetId(1, 1), overlayWidgetId(3, 1)].sort(),
    );
  });

  it("keeps the highlight runs of rows it did not list", () => {
    const first = applyDecorationEvent(
      EMPTY_DECORATION_STATE,
      event([1], [], [{ line: 1, startCol: 2, endCol: 6, hl: 3 }]),
    );
    const second = applyDecorationEvent(
      first.state,
      event([4], [], [{ line: 4, startCol: 1, endCol: 3, hl: 3 }]),
    );

    expect(second.runs.map((run) => run.line).sort()).toEqual([1, 4]);
  });

  it("names a widget by where it is, so the same cell keeps its node", () => {
    expect(overlayWidgetId(12, 34)).toBe("nvim-ovl-12-34");
  });
});
