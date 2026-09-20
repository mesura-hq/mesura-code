import { expect, it } from "vitest";
import { moveSelection } from "../src/overview/navigation.ts";
import { panTarget, zoomScroll } from "../src/overview/viewport.ts";

const entry = (name: string) => ({
  name,
  kind: "directory" as const,
  isHidden: false,
  isSymlink: false,
});
const folders = new Map([
  ["/root", { path: "/root", depth: 0, entries: [entry("a"), entry("b")], status: "Loaded" }],
  ["/root/a", { path: "/root/a", depth: 1, entries: [entry("child")], status: "Loaded" }],
]);
it("navigates siblings, parent and first child without wrapping", () => {
  expect(moveSelection(folders, "/root", "/root/a", "down")).toBe("/root/b");
  expect(moveSelection(folders, "/root", "/root/b", "down")).toBe("/root/b");
  expect(moveSelection(folders, "/root", "/root/a", "right")).toBe("/root/a/child");
  expect(moveSelection(folders, "/root", "/root/a/child", "left")).toBe("/root/a");
});
it("pans half the measured viewport independent of zoom", () => {
  expect(
    panTarget({ x: 1000, y: 1000 }, { width: 800, height: 600 }, "right", 0.5, {
      width: 5000,
      height: 5000,
    }),
  ).toEqual({ x: 1400, y: 1000 });
});
it("pans the full measured viewport and clamps at boundaries", () => {
  expect(
    panTarget({ x: 1000, y: 1000 }, { width: 800, height: 600 }, "up", 1, {
      width: 5000,
      height: 5000,
    }),
  ).toEqual({ x: 1000, y: 400 });
  expect(
    panTarget({ x: 0, y: 0 }, { width: 800, height: 600 }, "left", 1, { width: 5000, height: 5000 })
      .x,
  ).toBe(0);
});
it("keeps a visible anchor fixed across keyboard zoom", () => {
  expect(zoomScroll({ x: 400, y: 200 }, { x: 100, y: 50 }, 1, 2)).toEqual({ x: 900, y: 450 });
});
