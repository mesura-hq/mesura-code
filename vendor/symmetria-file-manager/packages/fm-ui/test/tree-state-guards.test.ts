import type { OverviewFolder } from "@symmetria/fm-core/overview/model";
import { expect, it } from "vitest";
import { pruneTreeShape } from "../src/tree/prune.ts";
import { type TreeShape, TreeStateCache } from "../src/tree/state.ts";

it("prunes deleted folder overrides only when complete parent data proves removal", () => {
  const path = "/root/gone/nested";
  const shape: TreeShape = {
    selected: path,
    collapsed: new Set([path]),
    preset: null,
    checkpoint: new Set([path]),
  };
  const parent: OverviewFolder = { path: "/root", depth: 0, status: "Not loaded", entries: [] };
  for (const status of ["Not loaded", "Partial", "Unreadable"]) {
    expect(pruneTreeShape(shape, "/root", new Map([["/root", { ...parent, status }]]))).toBe(shape);
  }
  const pruned = pruneTreeShape(
    shape,
    "/root",
    new Map([["/root", { ...parent, status: "Loaded" }]]),
  );
  expect(pruned.collapsed.size).toBe(0);
  expect(pruned.checkpoint?.size).toBe(0);
  const recreated = {
    ...parent,
    status: "Loaded",
    entries: [{ name: "gone", kind: "directory" as const, isHidden: false, isSymlink: false }],
  };
  expect(pruneTreeShape(pruned, "/root", new Map([["/root", recreated]]))).toBe(pruned);
});

it("retains three recent root scopes per tab and releases closed tabs", () => {
  const cache = new TreeStateCache();
  const initial = cache.get("one", "/a", false);
  cache.get("one", "/b", false);
  cache.get("one", "/c", false);
  expect(cache.get("one", "/a", false)).toBe(initial);
  cache.get("one", "/a", true);
  expect(cache.get("one", "/a", false)).toBe(initial);
  cache.retain(["two"]);
  expect(cache.get("one", "/a", false)).not.toBe(initial);
});
