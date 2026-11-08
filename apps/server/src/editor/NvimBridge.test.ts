import { assert, describe, it } from "@effect/vitest";

import { shouldReadCursor, type CursorReadTrigger } from "./NvimBridge.ts";

/**
 * Which frames are worth a round trip for the cursor, one trigger per case: a real Neovim fires
 * several triggers per frame, so behavioural tests pass with three of the four deleted.
 * A missed trigger freezes the caret for a class of keys; firing on idle frames costs a round
 * trip about 230 times a second.
 */

const QUIET: CursorReadTrigger = {
  hasModeChange: false,
  hasViewport: false,
  changedRows: 0,
  cursorMoves: 7,
  lastCursorMoves: 7,
};

describe("shouldReadCursor", () => {
  it("says no to a frame where nothing happened", () => {
    // The common case by a wide margin, and the one that has to be free.
    assert.isFalse(shouldReadCursor(QUIET));
  });

  it("says yes when the drawn cursor moved", () => {
    // `h`, `j`, `k`, `l` and the arrows: the caret moves, nothing else does.
    assert.isTrue(shouldReadCursor({ ...QUIET, cursorMoves: 8 }));
  });

  it("says yes when the mode changed and nothing moved", () => {
    // `i` at the first column. No caret movement, no new rows, no scroll.
    assert.isTrue(shouldReadCursor({ ...QUIET, hasModeChange: true }));
  });

  it("says yes when the viewport moved and the drawn cursor did not", () => {
    // `<C-d>` scrolls the text under a cursor that stays on the same screen
    // row, so Neovim sends no `grid_cursor_goto` at all while the buffer
    // cursor moves half a page. Measured: topline 0 to 11, move count
    // unchanged.
    assert.isTrue(shouldReadCursor({ ...QUIET, hasViewport: true }));
  });

  it("says yes when rows were redrawn and nothing else changed", () => {
    // A long line scrolling sideways under a cursor parked at the last
    // column: no new screen position, no new topline, new text.
    assert.isTrue(shouldReadCursor({ ...QUIET, changedRows: 1 }));
  });

  it("does not confuse a smaller move count with no move", () => {
    // The comparison is inequality, not growth. A session that re-attached
    // and reset its grid counts backwards, and a `>` would go quiet for good.
    assert.isTrue(shouldReadCursor({ ...QUIET, cursorMoves: 6 }));
  });
});
