import { describe, expect, it } from "vite-plus/test";

import {
  easeOutCubic,
  READING_SCROLL_DURATION_MS,
  readingScrollDistance,
  readingScrollPositionAt,
  resolveReadingScrollTarget,
} from "./chatReadingScroll";

describe("easeOutCubic", () => {
  it("spans the full range and clamps outside it", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });

  it("decelerates, so the first half covers most of the distance", () => {
    // The reader has to see the move start immediately and settle gently. An
    // accelerating or linear curve would fail this and read as a lurch.
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.8);
    expect(easeOutCubic(0.9)).toBeGreaterThan(easeOutCubic(0.8));
  });
});

describe("readingScrollDistance", () => {
  it("travels half the readable height", () => {
    expect(readingScrollDistance(800)).toBe(400);
  });

  it("refuses to travel on a viewport that has not been measured", () => {
    expect(readingScrollDistance(0)).toBe(0);
    expect(readingScrollDistance(Number.NaN)).toBe(0);
    expect(readingScrollDistance(-100)).toBe(0);
  });
});

describe("resolveReadingScrollTarget", () => {
  const viewport = { scrollTop: 1000, visibleHeight: 600, maxScrollTop: 4000 };

  it("moves half the readable height in each direction", () => {
    expect(resolveReadingScrollTarget(viewport, "down")).toBe(1300);
    expect(resolveReadingScrollTarget(viewport, "up")).toBe(700);
  });

  it("stops at the top instead of going negative", () => {
    expect(resolveReadingScrollTarget({ ...viewport, scrollTop: 100 }, "up")).toBe(0);
  });

  it("stops at the bottom instead of overrunning the content", () => {
    expect(resolveReadingScrollTarget({ ...viewport, scrollTop: 3900 }, "down")).toBe(4000);
  });

  it("ignores the composer overlay only through the height it is given", () => {
    // The caller subtracts the floating composer, so a shorter readable height
    // means a shorter trip even though the container did not change.
    expect(resolveReadingScrollTarget({ ...viewport, visibleHeight: 400 }, "down")).toBe(1200);
  });

  it("re-targets off the pending destination so held keys keep travelling", () => {
    // Second press arrives while the first is still animating: scrollTop has
    // barely moved, but the trip must start from where the first one is going.
    const midAnimation = { ...viewport, scrollTop: 1050 };
    expect(resolveReadingScrollTarget(midAnimation, "down", 1300)).toBe(1600);
  });

  it("clamps a pending destination that already sits outside the range", () => {
    expect(resolveReadingScrollTarget(viewport, "down", 5000)).toBe(4000);
    expect(resolveReadingScrollTarget(viewport, "up", -500)).toBe(0);
  });
});

describe("readingScrollPositionAt", () => {
  it("starts at the origin and finishes on the target", () => {
    expect(readingScrollPositionAt(1000, 1300, 0)).toBe(1000);
    expect(readingScrollPositionAt(1000, 1300, READING_SCROLL_DURATION_MS)).toBe(1300);
  });

  it("never overshoots the target once the duration has elapsed", () => {
    expect(readingScrollPositionAt(1000, 1300, READING_SCROLL_DURATION_MS * 3)).toBe(1300);
  });

  it("moves upward as well as downward", () => {
    const midpoint = readingScrollPositionAt(1000, 700, READING_SCROLL_DURATION_MS / 2);
    expect(midpoint).toBeLessThan(1000);
    expect(midpoint).toBeGreaterThan(700);
  });
});
