import type { OverviewFolder } from "@symmetria/fm-core/overview/model";
import { expect, it } from "vitest";
import { projectTree } from "../src/tree/model.ts";

it("projects unknown sibling totals and refuses to recurse through a symlink", () => {
  const folders = new Map<string, OverviewFolder>([
    [
      "/repo",
      {
        path: "/repo",
        depth: 0,
        status: "Partial: directory limit reached",
        entries: [
          { name: "link", kind: "directory", isHidden: false, isSymlink: true },
          { name: "empty", kind: "directory", isHidden: false, isSymlink: false },
        ],
      },
    ],
    [
      "/repo/link",
      {
        path: "/repo/link",
        depth: 1,
        status: "Loaded",
        entries: [{ name: "outside", kind: "file", isHidden: false, isSymlink: false }],
      },
    ],
    ["/repo/empty", { path: "/repo/empty", depth: 1, status: "Loaded", entries: [] }],
  ]);
  const rows = projectTree("/repo", folders, new Set());
  expect(rows.map((row) => row.path)).toEqual(["/repo", "/repo/link", "/repo/empty"]);
  expect(rows.slice(1).map((row) => [row.position, row.siblings])).toEqual([
    [1, -1],
    [2, -1],
  ]);
  expect(rows[1]?.expanded).toBe(false);
  expect(rows[2]?.expanded).toBe(true);
  expect(projectTree("/repo", folders, new Set(["/repo"]))).toHaveLength(1);
});
