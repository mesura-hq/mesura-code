/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from "vitest";
import { measureFlashTypography } from "../../src/overview/flashTypography.ts";

afterEach(() => vi.restoreAllMocks());
it("reuses font measurements across query refinements and scales cached metrics", () => {
  const measure = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 0, 8, 18));
  const font = {
    fontFamily: "sans-serif",
    fontSize: "14px",
    fontWeight: "400",
    fontStyle: "normal",
    lineHeight: "18px",
    letterSpacing: "normal",
  };
  const cache = new Map<string, { width: number; height: number }>();
  const normal = measureFlashTypography(font, "s", 1, cache);
  const zoomed = measureFlashTypography(font, "s", 2, cache);
  expect(measure).toHaveBeenCalledTimes(1);
  expect(zoomed.width).toBe(normal.width * 2);
  expect(zoomed.height).toBe(normal.height * 2);
  measureFlashTypography({ ...font, fontWeight: "600" }, "s", 1, cache);
  expect(measure).toHaveBeenCalledTimes(2);
  expect(document.body.children).toHaveLength(0);
});
