/** @vitest-environment happy-dom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type FlashScene,
  positionFlashLabels as placeLabels,
  readFlashScene,
} from "../../src/overview/flashTargets.ts";
import { measureFlashMatches } from "../../src/overview/flashTextGeometry.ts";
import { mockTextRanges } from "./flash-text-geometry.ts";

beforeEach(() => mockTextRanges((character) => (character === "l" ? 4 : 9)));
afterEach(() => vi.restoreAllMocks());
function scene(occluders: FlashScene["occluders"] = []): FlashScene {
  const name = document.createElement("span");
  name.textContent = "pull";
  name.className = "overview-name";
  vi.spyOn(name, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 26, 24));
  return {
    zoom: 1,
    typographyCache: new Map(),
    left: 0,
    top: 0,
    right: 800,
    bottom: 600,
    token: "fixture",
    occluders,
    names: new Map([["/pull", name]]),
    targets: [{ path: "/pull", name: "pull", left: 100, right: 126, top: 100, bottom: 124 }],
  };
}
function positionFlashLabels(
  captured: FlashScene,
  matches: Parameters<typeof placeLabels>[1],
  query: string,
) {
  return placeLabels(captured, matches, measureFlashMatches(captured, matches, query));
}
const match = { path: "/pull", name: "pull", label: "s" };
it("places labels over the suffix after the actual matched glyphs", () => {
  const captured = scene();
  const labels = positionFlashLabels(captured, [match], "pu");
  expect(labels?.[0]?.x).toBe(118);
  expect(measureFlashMatches(captured, [match], "pu")[0]?.clipPath).toBe(
    'path("M 0 0 H 18 V 24 H 0 Z")',
  );
  expect(positionFlashLabels(captured, [match], "ul")?.[0]?.x).toBe(122);
  expect(positionFlashLabels(captured, [match], "pull")?.[0]?.x).toBe(126);
});
it("refuses a label hidden by a minimap, status, or viewport edge instead of moving it before the query", () => {
  const captured = scene([{ left: 117, right: 140, top: 95, bottom: 130 }]);
  expect(positionFlashLabels(captured, [match], "pu")).toBeNull();
  expect(positionFlashLabels({ ...scene(), right: 120 }, [match], "pu")).toBeNull();
});
it("allows replacement of the target suffix but protects nearby names and other labels", () => {
  const captured = scene();
  const neighbor = { path: "/other", name: "other", left: 127, right: 180, top: 100, bottom: 124 };
  expect(
    positionFlashLabels({ ...captured, targets: [...captured.targets, neighbor] }, [match], "pu"),
  ).toBeNull();
  expect(positionFlashLabels(captured, [match, { ...match, label: "d" }], "pu")).toBeNull();
});

it("excludes only open popovers when capturing visible names", () => {
  const panel = document.createElement("div");
  panel.setAttribute("role", "dialog");
  const viewport = document.createElement("div");
  const row = document.createElement("button");
  row.dataset.entry = "/pull";
  const name = document.createElement("span");
  name.textContent = "pull";
  name.className = "overview-name";
  row.append(name);
  viewport.append(row);
  const details = document.createElement("details");
  const popover = document.createElement("div");
  popover.className = "overview-popover";
  details.append(popover);
  panel.append(viewport, details);
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 600));
  vi.spyOn(name, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 26, 24));
  vi.spyOn(popover, "getBoundingClientRect").mockReturnValue(new DOMRect(90, 90, 100, 100));
  expect(readFlashScene(viewport).targets.map((target) => target.path)).toEqual(["/pull"]);
  details.open = true;
  expect(readFlashScene(viewport).targets).toEqual([]);
});

it("scales jump typography with the graph and preserves the matched filename case", () => {
  const captured = scene();
  const name = captured.names.get("/pull");
  if (!name) throw new Error("Missing fixture name");
  name.textContent = "Pull";
  const label = positionFlashLabels({ ...captured, zoom: 2 }, [match], "pu")?.[0];
  expect(label?.typography).toMatchObject({ fontSize: "28px", lineHeight: "48px", height: 48 });
  expect(measureFlashMatches(captured, [match], "pu")[0]?.text).toBe("Pull");
  expect(label?.y).toBe(100);
});

it.each([
  ["İabc", "ab", 127],
  ["İİa", "a", 127],
])("maps normalized offsets to original glyphs for %s", (filename, query, endpoint) => {
  const captured = scene();
  const name = captured.names.get("/pull");
  if (!name) throw new Error("Missing fixture name");
  name.textContent = filename;
  const queries = measureFlashMatches(captured, [match], query);
  expect(queries[0]?.endpoint.left).toBe(endpoint);
  expect(positionFlashLabels(captured, [match], query)?.[0]?.x).toBe(endpoint);
});
it("keeps query geometry when a label is obstructed", () => {
  const captured = scene([{ left: 117, right: 140, top: 95, bottom: 130 }]);
  const queries = measureFlashMatches(captured, [match], "pu");
  expect(queries).toHaveLength(1);
  expect(placeLabels(captured, [match], queries)).toBeNull();
});
it("clips wrapped matches to each line and places the label on the last line", () => {
  const captured = scene();
  const name = captured.names.get("/pull");
  if (!name) throw new Error("Missing fixture name");
  name.textContent = "abcd";
  vi.spyOn(Range.prototype, "getClientRects").mockImplementation(() => {
    const rectangles = [new DOMRect(109, 100, 9, 24), new DOMRect(100, 124, 9, 24)];
    return Object.assign(rectangles, { item: (index: number) => rectangles[index] ?? null });
  });
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
    return new DOMRect(
      100 + (this.startOffset % 2) * 9,
      100 + Math.floor(this.startOffset / 2) * 24,
      9,
      24,
    );
  });
  const queries = measureFlashMatches(captured, [match], "bc");
  expect(queries[0]?.clipPath).toBe('path("M 9 0 H 18 V 24 H 9 Z M 0 24 H 9 V 48 H 0 Z")');
  expect(placeLabels(captured, [match], queries)?.[0]).toMatchObject({ x: 109, y: 124 });
});
