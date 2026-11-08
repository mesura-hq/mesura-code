import { assert, describe, it } from "@effect/vitest";

import { classifyRow, GridModel } from "./GridModel.ts";

/** The `redraw` notification's params: one entry per event name, then its batches. */
const redraw = (...events: ReadonlyArray<readonly unknown[]>) => events;

/** Attaches one grid of `width` x `height` and makes it the buffer window. */
function attachedGrid(model: GridModel, width: number, height: number, gridId = 2) {
  model.applyRedraw(
    redraw(
      ["grid_resize", [gridId, width, height]],
      ["win_pos", [gridId, 1000, 0, 0, width, height]],
    ),
  );
}

/** Writes a row of text into the grid, all on highlight `hl`. */
function writeRow(model: GridModel, row: number, text: string, hl = 0, gridId = 2) {
  model.applyRedraw(
    redraw(["grid_line", [gridId, row, 0, [...text].map((character) => [character, hl, 1])]]),
  );
}

describe("GridModel", () => {
  it("classifies a character that differs from the buffer as virtual", () => {
    const model = new GridModel();
    attachedGrid(model, 20, 3);
    model.setBufferLines(["const value = 1;"]);
    // flash puts its label over the first column.
    writeRow(model, 0, "aonst value = 1;", 42);

    const { overlays } = model.collect();

    assert.deepStrictEqual(overlays, [{ line: 1, col: 1, text: "a", hl: 42 }]);
  });

  it("classifies an equal character carrying a highlight as a highlight run", () => {
    const model = new GridModel();
    attachedGrid(model, 20, 3);
    model.setBufferLines(["const value = 1;"]);
    model.applyRedraw(
      redraw([
        "grid_line",
        [
          2,
          0,
          0,
          [
            ["c", 0, 1],
            ["o", 7, 1],
            ["n", 7, 1],
            ["s", 7, 1],
            ["t", 7, 1],
          ],
        ],
      ]),
    );

    const { overlays, highlightRuns } = model.collect();

    assert.deepStrictEqual(overlays, []);
    assert.deepStrictEqual(highlightRuns, [{ line: 1, startCol: 2, endCol: 6, hl: 7 }]);
  });

  it("treats a blank cell as neither virtual nor highlighted", () => {
    const model = new GridModel();
    attachedGrid(model, 20, 3);
    model.setBufferLines(["ab"]);
    writeRow(model, 0, "ab", 0);

    const { overlays, highlightRuns } = model.collect();

    assert.deepStrictEqual(overlays, []);
    assert.deepStrictEqual(highlightRuns, []);
  });

  it("ignores every grid but the buffer window's", () => {
    const model = new GridModel();
    attachedGrid(model, 20, 3);
    model.setBufferLines(["const value = 1;"]);
    // A which-key or snacks float draws on its own grid and must not be read as
    // virtual text over the buffer.
    model.applyRedraw(redraw(["grid_resize", [5, 20, 3]]));
    writeRow(model, 0, "XXXXXXXXXXXX", 9, 5);

    assert.deepStrictEqual(model.collect().overlays, []);
  });

  it("does not report highlight groups the host draws itself", () => {
    const model = new GridModel();
    attachedGrid(model, 20, 3);
    // With `ext_hlstate` the definition carries the group names.
    model.applyRedraw(
      redraw(["hl_attr_define", [3, { foreground: 1 }, {}, [{ hi_name: "Visual", kind: "ui" }]]]),
    );
    model.setBufferLines(["abcd"]);
    writeRow(model, 0, "abcd", 3);

    assert.deepStrictEqual(model.collect().highlightRuns, []);
  });

  it("follows the viewport, so row zero is not always line one", () => {
    const model = new GridModel();
    attachedGrid(model, 20, 3);
    model.setBufferLines(["one", "two", "three", "four", "five"]);
    model.applyRedraw(redraw(["win_viewport", [2, 1000, 2, 5, 0, 0]]));
    writeRow(model, 0, "Xhree", 42);

    assert.deepStrictEqual(model.collect().overlays, [{ line: 3, col: 1, text: "X", hl: 42 }]);
  });

  it("reports only the rows whose content changed since the last collect", () => {
    const model = new GridModel();
    attachedGrid(model, 20, 3);
    model.setBufferLines(["aaa", "bbb"]);
    writeRow(model, 0, "Xaa", 42);

    // Every row is new on the first collection: nothing has reached a client
    // yet, so the whole viewport is owed.
    assert.include(model.collect().changedRows, 0);
    // Nothing was drawn in between, so nothing is owed.
    assert.deepStrictEqual(model.collect().changedRows, []);
    // And only the row that was drawn into comes back, which is the property
    // the bridge depends on to push a line rather than a screen.
    writeRow(model, 1, "Ybb", 42);
    assert.deepStrictEqual(model.collect().changedRows, [1]);
  });

  it("misclassifies every character once Neovim draws a gutter", () => {
    // This is why the host owns the gutter and Neovim's line numbers stay off.
    // With a two-column number, grid column N is not buffer column N, and the
    // prototype measured 132 phantom labels from exactly this.
    const model = new GridModel();
    attachedGrid(model, 20, 3);
    model.setBufferLines(["abcd"]);
    writeRow(model, 0, " 1 abcd", 0);

    assert.isAbove(model.collect().overlays.length, 1);
  });
  it("moves rows on grid_scroll, so a scrolled window is not read as virtual text", () => {
    const model = new GridModel();
    attachedGrid(model, 10, 3);
    model.setBufferLines(["one", "two", "three", "four"]);
    writeRow(model, 0, "one");
    writeRow(model, 1, "two");
    writeRow(model, 2, "three");
    assert.deepStrictEqual(model.collect().overlays, []);

    // What Neovim sends for one line of `<C-e>`: the viewport, the region moved
    // up a row, and only the row that came into view drawn.
    model.applyRedraw(
      redraw(
        ["win_viewport", [2, 1000, 1, 4, 0, 0]],
        ["grid_scroll", [2, 0, 3, 0, 10, 1, 0]],
        [
          "grid_line",
          [
            2,
            2,
            0,
            [
              ["f", 0, 1],
              ["o", 0, 1],
              ["u", 0, 1],
              ["r", 0, 1],
              [" ", 0, 6],
            ],
          ],
        ],
      ),
    );

    assert.deepStrictEqual(model.collect().overlays, []);
  });

  it("does not re-read the grid for a frame that drew nothing", () => {
    const model = new GridModel();
    attachedGrid(model, 10, 2);
    model.setBufferLines(["abc"]);
    writeRow(model, 0, "Xbc", 4);
    const first = model.collect();
    const second = model.collect();

    assert.strictEqual(second.overlays, first.overlays);
    assert.deepStrictEqual(second.changedRows, []);
  });
});

describe("classifyRow", () => {
  const notHostDrawn = () => false;
  const cellsOf = (...cells: string[]) => cells;
  const row = (text: string, cells: string[], highlights?: number[]) =>
    classifyRow({
      cells,
      highlights: highlights ?? cells.map(() => 0),
      text,
      line: 7,
      tabstop: 4,
      isHostDrawn: notHostDrawn,
    });

  it("reads a tab as the blank cells up to the next tab stop", () => {
    const result = row("\tab", cellsOf(" ", " ", " ", " ", "a", "b"));
    assert.deepStrictEqual(result.overlays, []);
  });

  it("reports a label after a tab at the UTF-16 column of the character it covers", () => {
    const result = row("\tab", cellsOf(" ", " ", " ", " ", "a", "Z"), [0, 0, 0, 0, 0, 9]);
    assert.deepStrictEqual(result.overlays, [{ line: 7, col: 3, text: "Z", hl: 9 }]);
  });

  it("walks accents and wide characters without inventing labels", () => {
    // é is one cell and one UTF-16 unit but two bytes; ⚠️ is two cells (the
    // second drawn empty) and two UTF-16 units.
    const result = row("é ⚠️ x", cellsOf("é", " ", "⚠️", "", " ", "x"));
    assert.deepStrictEqual(result.overlays, []);
  });

  it("puts a label after an emoji on the character it covers", () => {
    const result = row("⚠️ xy", cellsOf("⚠️", "", " ", "x", "Q"), [0, 0, 0, 0, 5]);
    // ⚠️ is U+26A0 U+FE0F, two units, so "y" is UTF-16 index 4 → column 5.
    assert.deepStrictEqual(result.overlays, [{ line: 7, col: 5, text: "Q", hl: 5 }]);
  });

  it("joins virtual text after the end of the line into one overlay, gap included", () => {
    const cells = cellsOf("a", "b", " ", " ", "Y", "o", "u", ",", " ", "n", "o", "w", " ", " ");
    const highlights = [0, 0, 0, 0, 3, 3, 3, 3, 3, 3, 3, 3, 0, 0];
    const result = row("ab", cells, highlights);
    assert.deepStrictEqual(result.overlays, [{ line: 7, col: 3, text: "  You, now", hl: 3 }]);
  });

  it("maps a highlight run over non-ASCII text to UTF-16 columns", () => {
    const result = row(
      "ñandú x",
      cellsOf("ñ", "a", "n", "d", "ú", " ", "x"),
      [8, 8, 8, 8, 8, 0, 0],
    );
    assert.deepStrictEqual(result.highlightRuns, [{ line: 7, startCol: 1, endCol: 6, hl: 8 }]);
  });

  it("keeps its place when a label covers half of a wide character", () => {
    // Neovim blanks the half the label did not cover. Read against the next
    // character, that blank consumed it and every label after was misplaced.
    const result = row("中文x", cellsOf("a", " ", "文", "", "Q"), [9, 0, 0, 0, 5]);
    assert.deepStrictEqual(result.overlays, [
      { line: 7, col: 1, text: "a", hl: 9 },
      { line: 7, col: 3, text: "Q", hl: 5 },
    ]);
  });

  it("keeps its place when something wide is drawn over narrow text", () => {
    const result = row("abcx", cellsOf("中", "", "c", "Q"), [9, 9, 0, 5]);
    assert.deepStrictEqual(result.overlays, [
      { line: 7, col: 1, text: "中", hl: 9 },
      { line: 7, col: 4, text: "Q", hl: 5 },
    ]);
  });

  it("reads a control or unprintable character in Neovim's spelling as the file's own", () => {
    assert.deepStrictEqual(row("a\u0001b", cellsOf("a", "^", "A", "b")).overlays, []);
    assert.deepStrictEqual(
      row("a\u200bb", cellsOf("a", "<", "2", "0", "0", "b", ">", "b")).overlays,
      [],
    );
  });

  describe("in a window scrolled sideways", () => {
    const scrolled = (text: string, cells: string[], leftColumn: number, highlights?: number[]) =>
      classifyRow({
        cells,
        highlights: highlights ?? cells.map(() => 0),
        text,
        line: 7,
        tabstop: 4,
        leftColumn,
        isHostDrawn: notHostDrawn,
      });

    it("reads the row from the screen column leftcol shows", () => {
      assert.deepStrictEqual(
        scrolled("abcdefgh", cellsOf("d", "e", "f", "g", "h"), 3).overlays,
        [],
      );
    });

    it("puts a label in a scrolled row on the character it covers", () => {
      const result = scrolled("abcdefgh", cellsOf("d", "X", "f"), 3, [0, 9, 0]);
      assert.deepStrictEqual(result.overlays, [{ line: 7, col: 5, text: "X", hl: 9 }]);
    });

    it("reads a tab the left edge cuts from the cells it still has", () => {
      // The tab spans screen columns 0 to 3; scrolled by 2, two of its cells
      // are left, then "a" and "b".
      assert.deepStrictEqual(scrolled("\tab", cellsOf(" ", " ", "a", "b"), 2).overlays, []);
      assert.deepStrictEqual(
        scrolled("\tab", cellsOf(" ", " ", "a", "Z"), 2, [0, 0, 0, 9]).overlays,
        [{ line: 7, col: 3, text: "Z", hl: 9 }],
      );
    });

    it("reads the < Neovim draws for a wide character the left edge cuts as that character", () => {
      // `中xyz` at leftcol 1, as `nvim --embed` draws it: `<xyz`.
      assert.deepStrictEqual(scrolled("中xyz", cellsOf("<", "x", "y", "z"), 1).overlays, []);
    });

    it("still reports a label drawn where the left edge cuts a wide character", () => {
      const result = scrolled("中xyz", cellsOf("Q", "x", "y", "z"), 1, [9, 0, 0, 0]);
      assert.deepStrictEqual(result.overlays, [{ line: 7, col: 1, text: "Q", hl: 9 }]);
    });

    it("counts an unprintable character before the edge as the six cells of <200b>", () => {
      // `a\u200bbcd…` at leftcol 7, as Neovim draws it: `bcd…`.
      assert.deepStrictEqual(scrolled("a\u200bbcdefg", cellsOf("b", "c", "d"), 7).overlays, []);
    });

    it("reads the rest of a spelling the left edge cuts as that character", () => {
      // `<200b>` from leftcol 3 is `00b>`, measured.
      const cells = cellsOf("0", "0", "b", ">", "b", "c");
      assert.deepStrictEqual(scrolled("a\u200bbcdefg", cells, 3).overlays, []);
    });
  });

  it("re-reads every row when only leftcol changed", () => {
    const model = new GridModel();
    attachedGrid(model, 10, 1);
    model.setBufferLines(["abcdefgh"]);
    writeRow(model, 0, "defgh");
    // Read against column 0, the shifted text is all phantom labels.
    assert.isAbove(model.collect().overlays.length, 0);
    model.setLeftColumn(3);
    const { overlays, changedRows } = model.collect();
    assert.deepStrictEqual(overlays, []);
    assert.deepStrictEqual(
      changedRows,
      [0],
      "the row is owed again, though its cells did not change",
    );
  });
});
