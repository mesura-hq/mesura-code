import { vi } from "vitest";
import * as flashTypography from "../../src/overview/flashTypography.ts";

/** Happy DOM has no text layout; supply glyph widths while preserving Range offsets. */
export function mockTextRanges(widthOf: (character: string) => number = () => 8) {
  vi.spyOn(flashTypography, "measureFlashTypography").mockImplementation((_name, label, zoom) => ({
    fontFamily: "sans-serif",
    fontSize: `${14 * zoom}px`,
    fontWeight: "400",
    fontStyle: "normal",
    letterSpacing: "normal",
    lineHeight: `${24 * zoom}px`,
    height: 24 * zoom,
    width: [...label].reduce((sum, character) => sum + widthOf(character), 0) * zoom + 4 * zoom,
    padding: 2 * zoom,
  }));
  vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (this: Range) {
    const rectangles = [this.getBoundingClientRect()];
    return Object.assign(rectangles, { item: (index: number) => rectangles[index] ?? null });
  });
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
    const rect = this.startContainer.parentElement?.getBoundingClientRect() ?? new DOMRect();
    const text = this.startContainer.textContent ?? "";
    const width = (part: string) =>
      [...part].reduce((sum, character) => sum + widthOf(character), 0);
    return new DOMRect(
      rect.left + width(text.slice(0, this.startOffset)),
      rect.top,
      width(text.slice(this.startOffset, this.endOffset)),
      rect.height,
    );
  });
}
