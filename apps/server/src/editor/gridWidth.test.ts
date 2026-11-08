import { assert, describe, it } from "@effect/vitest";

import { displayWidth } from "./GridModel.ts";

import {
  GROW_HEADROOM,
  mayExpandUnpredictably,
  gridColumnsForViewport,
  grownGridColumns,
  MAX_GRID_COLUMNS,
  SPARE_COLUMNS,
} from "./gridWidth.ts";

const linesWith = (widths: Record<number, number>, count = 300) =>
  Array.from({ length: count }, (_, index) => "x".repeat(widths[index + 1] ?? 40));

describe("gridColumnsForViewport", () => {
  it("leaves spare columns past the widest line in the window", () => {
    const lines = linesWith({ 101: 940 });
    const cols = gridColumnsForViewport(940, { lines, topline: 98, rows: 7, tabstop: 8 }, 120);
    assert.strictEqual(cols, 940 + SPARE_COLUMNS);
  });

  it("counts the lines a window's worth either side, which j and k bring in", () => {
    const lines = linesWith({ 120: 700 });
    const cols = gridColumnsForViewport(200, { lines, topline: 110, rows: 7, tabstop: 8 }, 120);
    assert.strictEqual(cols, 700 + SPARE_COLUMNS);
  });

  it("measures a tab as the cells it takes", () => {
    const lines = ["\t".repeat(100)];
    const cols = gridColumnsForViewport(200, { lines, topline: 1, rows: 1, tabstop: 8 }, 120);
    assert.strictEqual(cols, 800 + SPARE_COLUMNS);
  });

  it("keeps the client's request as a floor", () => {
    const cols = gridColumnsForViewport(
      200,
      { lines: ["short"], topline: 1, rows: 1, tabstop: 8 },
      120,
    );
    assert.strictEqual(cols, 200);
  });

  it("keeps a grid that already fits as the window scrolls", () => {
    // A resize redraws every row, so a width that still fits is kept.
    const lines = linesWith({ 20: 90 });
    const window = { lines, topline: 15, rows: 7, tabstop: 8 };
    assert.strictEqual(gridColumnsForViewport(200, window, 260), 260);
    assert.strictEqual(gridColumnsForViewport(200, window, 200 + 3 * SPARE_COLUMNS), 218);
  });

  it("keeps a reserved grid however much wider than needed while the reservation lasts", () => {
    const window = { lines: linesWith({}), topline: 15, rows: 7, tabstop: 8 };
    assert.strictEqual(
      gridColumnsForViewport(200, window, MAX_GRID_COLUMNS, true),
      MAX_GRID_COLUMNS,
    );
    assert.strictEqual(gridColumnsForViewport(200, window, MAX_GRID_COLUMNS, false), 200);
  });

  it("never gives a grid more than the bound, however long the line", () => {
    const lines = linesWith({ 1: 1_000_000 });
    const cols = gridColumnsForViewport(1000, { lines, topline: 1, rows: 7, tabstop: 8 }, 120);
    assert.strictEqual(cols, MAX_GRID_COLUMNS);
  });
});

describe("grownGridColumns", () => {
  const window = { topline: 1, rows: 7, tabstop: 8, cursorLine: 1 };

  it("leaves a grid alone while the cursor's line stays clear of the edge", () => {
    const lines = linesWith({ 1: 100 });
    const current = 100 + SPARE_COLUMNS;
    assert.isNull(grownGridColumns(current, { ...window, lines, pendingCells: 1 }));
  });

  it("grows the grid before typing brings the line within the headroom of the edge", () => {
    const current = 100 + SPARE_COLUMNS;
    const lines = linesWith({ 1: current - GROW_HEADROOM });
    assert.strictEqual(
      grownGridColumns(current, { ...window, lines, pendingCells: 1 }),
      current - GROW_HEADROOM + 1 + SPARE_COLUMNS,
    );
  });

  it("stops growing at the bound", () => {
    const lines = linesWith({ 1: 5000 });
    assert.isNull(grownGridColumns(MAX_GRID_COLUMNS, { ...window, lines, pendingCells: 1 }));
    assert.strictEqual(
      grownGridColumns(1000, { ...window, lines, pendingCells: 1 }),
      MAX_GRID_COLUMNS,
    );
  });
});

describe("mayExpandUnpredictably", () => {
  it("reserves for puts, repeats, macros, joins, counts and Ex commands in normal mode", () => {
    for (const keys of ['"ap', "P", ".", "@q", "J", "5ix<Esc>", "3o", ":s/a/b<CR>"]) {
      assert.isTrue(mayExpandUnpredictably(keys, "n"), keys);
    }
  });

  it("reserves nothing for motions and counted motions or operators, 0 among them", () => {
    for (const keys of ["j", "k", "0", "$", "w", "<C-d>", "3j", "10k", "d2w", "2w"]) {
      assert.isFalse(mayExpandUnpredictably(keys, "n"), keys);
    }
  });

  it("reads typed text as its own width in insert mode, and <C-r> as a put", () => {
    assert.isFalse(mayExpandUnpredictably("apple 3.", "i"));
    assert.isTrue(mayExpandUnpredictably("<C-r>a", "i"));
  });

  it("reserves the whole bound for such keys", () => {
    const lines = ["x".repeat(300)];
    const input = { lines, topline: 1, rows: 3, tabstop: 8, cursorLine: 1, pendingCells: 3 };
    assert.strictEqual(grownGridColumns(428, { ...input, unpredictable: true }), MAX_GRID_COLUMNS);
    assert.isNull(grownGridColumns(428, input));
  });
});

describe("the cost of measuring before every key batch", () => {
  it("stops counting a line's width at the limit it is asked for", () => {
    const width = displayWidth(`é${"x".repeat(100_000)}`, 8, MAX_GRID_COLUMNS);
    assert.isAtLeast(width, MAX_GRID_COLUMNS);
    assert.isBelow(width, 100_000);
  });

  it("measures unchanged non-ASCII lines once, not on every batch", () => {
    // The reviewer's case: seven rows of 1,100-character lines, one accent
    // each. Measured line by line on every batch this cost 90 ms a batch; a
    // hundred batches here must take a small fraction of one such batch's
    // old cost each, which only remembered widths can give.
    const lines = Array.from({ length: 300 }, (_, index) => `é${"x".repeat(1099 - (index % 7))}`);
    const input = { lines, topline: 100, rows: 7, tabstop: 8, cursorLine: 103, pendingCells: 1 };
    grownGridColumns(1228, input);
    // oxlint-disable-next-line t3code/no-wall-clock-in-tests -- This CPU regression measures the cost of 100 real width calculations; virtual time cannot detect repeated work.
    const started = performance.now();
    for (let batch = 0; batch < 100; batch += 1) grownGridColumns(1228, input);
    // oxlint-disable-next-line t3code/no-wall-clock-in-tests -- This CPU regression measures the cost of 100 real width calculations; virtual time cannot detect repeated work.
    assert.isBelow(performance.now() - started, 1000, "ms for 100 batches");
  });
});
