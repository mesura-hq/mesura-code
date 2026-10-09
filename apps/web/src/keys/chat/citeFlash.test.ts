// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { flashCitedRange } from "./citeFlash";

function rangeWithRects(rects: Array<Partial<DOMRect>>): Range {
  const range = document.createRange();
  range.getClientRects = () => rects as unknown as DOMRectList;
  return range;
}

describe("cite flash", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("draws one box per line of the cited text, inside the row", () => {
    const row = document.createElement("div");
    document.body.append(row);
    flashCitedRange(
      rangeWithRects([
        { left: 10, top: 20, width: 100, height: 16 },
        { left: 0, top: 0, width: 0, height: 0 },
        { left: 10, top: 40, width: 60, height: 16 },
      ]),
      row,
    );
    const flash = row.querySelector("[data-mesura-cite-flash]");
    expect(flash?.getAttribute("aria-hidden")).toBe("true");
    expect(flash?.children).toHaveLength(2);
  });

  it("removes itself when its animation ends, or after its length when none runs", () => {
    vi.useFakeTimers();
    const row = document.createElement("div");
    document.body.append(row);
    const range = rangeWithRects([{ left: 0, top: 0, width: 10, height: 10 }]);

    flashCitedRange(range, row);
    row.querySelector("[data-mesura-cite-flash]")!.dispatchEvent(new Event("animationend"));
    expect(row.querySelector("[data-mesura-cite-flash]")).toBeNull();

    flashCitedRange(range, row);
    vi.advanceTimersByTime(1100);
    expect(row.querySelector("[data-mesura-cite-flash]")).toBeNull();
  });

  it("draws nothing for text with no box on screen", () => {
    const row = document.createElement("div");
    flashCitedRange(rangeWithRects([]), row);
    expect(row.children).toHaveLength(0);
  });
});
