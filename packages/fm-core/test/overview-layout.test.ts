import { expect, it } from "vitest";
import { intersects, layoutGroups, visibleGroups } from "../src/overview/layout.ts";

const folders = [
  {
    path: "/root",
    depth: 0,
    entries: [{ name: "child", kind: "directory", isHidden: false, isSymlink: false }],
    status: "Loaded",
  },
  { path: "/root/child", depth: 1, entries: [], status: "Loaded" },
] as const;
it("assigns each loaded entry to its parent exactly once", () => {
  const groups = layoutGroups(folders, new Map());
  expect(
    groups.flatMap((group) => group.entries.map((entry) => `${group.path}/${entry.name}`)),
  ).toEqual(["/root/child"]);
});
it("connects each non-root group to its immediate parent", () => {
  const groups = layoutGroups(folders, new Map());
  expect(groups.map((group) => group.parent)).toEqual([null, "/root"]);
});
it("preserves assigned coordinates when collapse hides descendants", () => {
  const groups = layoutGroups(folders, new Map());
  const before = groups.map((group) => [group.path, group.x, group.y]);
  expect(visibleGroups(groups, new Set(["/root"]))).toHaveLength(1);
  expect(groups.map((group) => [group.path, group.x, group.y])).toEqual(before);
});
it("culls groups using transformed viewport bounds and overscan", () => {
  expect(
    intersects(
      { x: 100, y: 100, width: 240, height: 100 },
      { x: 0, y: 0, width: 50, height: 50 },
      0,
    ),
  ).toBe(false);
  expect(
    intersects(
      { x: 100, y: 100, width: 240, height: 100 },
      { x: 0, y: 0, width: 50, height: 50 },
      200,
    ),
  ).toBe(true);
});

it("prevents mixed-width groups from overlapping across depths", () => {
  const file = { name: "f", kind: "file" as const, isHidden: false, isSymlink: false };
  const groups = layoutGroups(
    [
      { path: "/root", depth: 0, entries: [], status: "Loaded" },
      { path: "/root/a", depth: 1, entries: [], status: "Loaded" },
      {
        path: "/root/b",
        depth: 1,
        entries: Array.from({ length: 24 }, (_, i) => ({ ...file, name: String(i) })),
        status: "Loaded",
      },
      {
        path: "/root/a/child",
        depth: 2,
        entries: Array.from({ length: 12 }, (_, i) => ({ ...file, name: String(i) })),
        status: "Loaded",
      },
    ],
    new Map(),
  );
  for (const group of groups)
    for (const other of groups)
      if (group !== other) expect(intersects(group, other, 0)).toBe(false);
});
it("retains unrelated boxes when measured group height grows", () => {
  const first = layoutGroups(folders, new Map());
  const second = layoutGroups(
    folders,
    new Map(first.map((group) => [group.path, group])),
    new Map([["/root/child", { width: 240, height: 400 }]]),
  );
  expect(second[0]).toEqual(first[0]);
  expect(second[1]?.height).toBe(400);
});
