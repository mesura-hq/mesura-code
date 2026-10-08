/**
 * Entry point: `widenedCursorBox` in `blockCursor.ts`, the pure decision both
 * key surfaces (`chat/chatSurface.ts`, `composer/composerSurface.ts`) take for
 * the block cursor on a glyph: paint the CSS highlight as it is, or draw the
 * widened overlay in a box this function returns.
 *
 * Phase 7 of the modal keys production cycle (a readable block cursor on
 * narrow glyphs):
 * - Criterion 1: on a glyph narrower than 0.5em the cursor block is 0.5em
 *   wide and centred on the glyph.
 * - Criterion 3: on a glyph 0.5em or wider there is no box, so the highlight
 *   paints the cursor exactly as in the baseline.
 *
 * happy-dom has no layout, so the geometry is decided here from a glyph box
 * and the glyph's computed font size in px; the app-level fence
 * (`AppRoot.narrowGlyphCursor.fence.test.tsx`) proves the surfaces use it.
 */
import { describe, expect, it } from "vite-plus/test";

import { widenedCursorBox, type GlyphBox } from "./blockCursor";

const FONT_SIZE_PX = 20;
const HALF_EM_PX = FONT_SIZE_PX / 2;

function glyph(width: number, overrides: Partial<GlyphBox> = {}): GlyphBox {
  return { left: 100, top: 40, width, height: 24, ...overrides };
}

const centreOf = (box: GlyphBox) => box.left + box.width / 2;

describe("block cursor geometry: narrow glyphs", () => {
  it("block cursor geometry spec: a glyph narrower than half an em gets a box half an em wide", () => {
    const box = widenedCursorBox(glyph(4), FONT_SIZE_PX);
    expect(box).not.toBeNull();
    expect(box!.width).toBeCloseTo(HALF_EM_PX, 6);
  });

  it("block cursor geometry spec: the widened box is centred on the glyph", () => {
    const narrow = glyph(4);
    const box = widenedCursorBox(narrow, FONT_SIZE_PX)!;
    expect(box.left).toBeCloseTo(97, 6);
    expect(centreOf(box)).toBeCloseTo(centreOf(narrow), 6);
  });

  it("block cursor geometry spec: the widened box keeps the glyph's top and height", () => {
    const narrow = glyph(3, { top: 312.5, height: 19.25 });
    const box = widenedCursorBox(narrow, FONT_SIZE_PX)!;
    expect(box.top).toBe(312.5);
    expect(box.height).toBe(19.25);
  });

  it("block cursor geometry spec: a glyph just under half an em is still widened", () => {
    const box = widenedCursorBox(glyph(HALF_EM_PX - 0.01), FONT_SIZE_PX);
    expect(box?.width).toBeCloseTo(HALF_EM_PX, 6);
  });

  it("block cursor geometry spec: a zero-width glyph gets a half-em box centred on its position", () => {
    const box = widenedCursorBox(glyph(0, { left: 50 }), FONT_SIZE_PX)!;
    expect(box.width).toBeCloseTo(HALF_EM_PX, 6);
    expect(centreOf(box)).toBeCloseTo(50, 6);
  });

  it("block cursor geometry spec: half an em follows the glyph's own font size, fractional sizes included", () => {
    const narrow = glyph(3, { left: 10.25 });
    const box = widenedCursorBox(narrow, 13)!;
    expect(box.width).toBeCloseTo(6.5, 6);
    expect(centreOf(box)).toBeCloseTo(centreOf(narrow), 6);
  });

  it("block cursor geometry spec: across every width from zero to one em, only glyphs under half an em are widened, centred", () => {
    for (let step = 0; step <= 40; step += 1) {
      const width = (step / 40) * FONT_SIZE_PX;
      const source = glyph(width, { left: 200 + step });
      const box = widenedCursorBox(source, FONT_SIZE_PX);
      if (width < HALF_EM_PX) {
        expect(box, `a ${width}px glyph is widened`).not.toBeNull();
        expect(box!.width, `a ${width}px glyph's box width`).toBeCloseTo(HALF_EM_PX, 6);
        expect(centreOf(box!), `a ${width}px glyph's box centre`).toBeCloseTo(centreOf(source), 6);
        expect(box!.top).toBe(source.top);
        expect(box!.height).toBe(source.height);
      } else {
        expect(box, `a ${width}px glyph keeps the highlight`).toBeNull();
      }
    }
  });
});

describe("block cursor geometry: glyphs half an em or wider", () => {
  it("block cursor geometry spec: a glyph exactly half an em wide keeps the highlight", () => {
    expect(widenedCursorBox(glyph(HALF_EM_PX), FONT_SIZE_PX)).toBeNull();
  });

  it("block cursor geometry spec: a glyph wider than half an em keeps the highlight", () => {
    expect(widenedCursorBox(glyph(13), FONT_SIZE_PX)).toBeNull();
    expect(widenedCursorBox(glyph(FONT_SIZE_PX * 1.2), FONT_SIZE_PX)).toBeNull();
  });

  // A glyph that is not laid out has an all-zero box, as every glyph does in
  // happy-dom: widening it drew an overlay for nothing on screen.
  it("block cursor geometry regression: a glyph with no height keeps the highlight", () => {
    expect(widenedCursorBox(glyph(0, { height: 0 }), FONT_SIZE_PX)).toBeNull();
    expect(widenedCursorBox(glyph(4, { height: 0 }), FONT_SIZE_PX)).toBeNull();
  });

  it("block cursor geometry spec: a font size that cannot give an em keeps the highlight", () => {
    for (const fontSize of [0, -4, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(widenedCursorBox(glyph(2), fontSize), `font size ${fontSize}`).toBeNull();
    }
  });
});
