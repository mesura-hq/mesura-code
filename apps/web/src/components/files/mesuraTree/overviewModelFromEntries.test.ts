import type { ProjectEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  entryKindAt,
  foldersForListing,
  overviewFoldersFromEntries,
  relativeToCwd,
} from "./overviewModelFromEntries";

const CWD = "/home/jc/project";

const entries: ReadonlyArray<ProjectEntry> = [
  { path: "src", kind: "directory" },
  { path: "src/main.ts", kind: "file" },
  { path: "README.md", kind: "file" },
  { path: ".github/workflows/ci.yml", kind: "file" },
  { path: "src/lib/util.ts", kind: "file" },
  { path: ".env", kind: "file" },
];

describe("overviewFoldersFromEntries", () => {
  const folders = overviewFoldersFromEntries(CWD, entries);

  it("keys every folder by its absolute path, the root included", () => {
    expect([...folders.keys()].sort()).toEqual(
      [CWD, `${CWD}/.github`, `${CWD}/.github/workflows`, `${CWD}/src`, `${CWD}/src/lib`].sort(),
    );
  });

  it("creates the intermediate folders a file path implies", () => {
    const workflows = folders.get(`${CWD}/.github/workflows`);
    expect(workflows?.depth).toBe(2);
    expect(workflows?.entries.map((entry) => entry.name)).toEqual(["ci.yml"]);
    expect(folders.get(`${CWD}/src/lib`)?.entries.map((entry) => entry.name)).toEqual(["util.ts"]);
  });

  it("sorts directories first, then by name, and marks dot-names hidden", () => {
    const root = folders.get(CWD);
    expect(root?.depth).toBe(0);
    expect(root?.entries.map((entry) => [entry.name, entry.kind, entry.isHidden])).toEqual([
      [".github", "directory", true],
      ["src", "directory", false],
      [".env", "file", true],
      ["README.md", "file", false],
    ]);
  });

  it("reports every folder as Loaded and no entry as a symlink", () => {
    for (const folder of folders.values()) {
      expect(folder.status).toBe("Loaded");
      for (const entry of folder.entries) expect(entry.isSymlink).toBe(false);
    }
  });

  it("keys a trailing-slash root the same way as a bare one", () => {
    const slashed = overviewFoldersFromEntries(`${CWD}/`, entries);
    expect([...slashed.keys()].sort()).toEqual([...folders.keys()].sort());
    expect(slashed.get(`${CWD}/src/lib`)?.depth).toBe(2);
    expect(relativeToCwd(`${CWD}/`, `${CWD}/src/main.ts`)).toBe("src/main.ts");
  });

  it("yields only the root folder for an empty listing", () => {
    const empty = overviewFoldersFromEntries(CWD, []);
    expect([...empty.keys()]).toEqual([CWD]);
    expect(empty.get(CWD)?.entries).toEqual([]);
  });
});

describe("relativeToCwd", () => {
  it("strips the root and its separator", () => {
    expect(relativeToCwd(CWD, `${CWD}/src/main.ts`)).toBe("src/main.ts");
  });

  it("returns null for the root itself and for a path outside it", () => {
    expect(relativeToCwd(CWD, CWD)).toBeNull();
    expect(relativeToCwd(CWD, "/home/jc/projectile/x")).toBeNull();
    expect(relativeToCwd(CWD, "/tmp/other")).toBeNull();
  });
});

describe("foldersForListing", () => {
  it("has no folders, not even the root, until the server has answered", () => {
    expect(foldersForListing(CWD, null).size).toBe(0);
  });

  it("builds the map once a listing exists, an empty one included", () => {
    expect([...foldersForListing(CWD, { entries: [], truncated: false }).keys()]).toEqual([CWD]);
    expect(foldersForListing(CWD, { entries, truncated: false }).get(`${CWD}/src`)).toBeTruthy();
  });

  it("tells a file from a directory by its parent's listing", () => {
    const folders = overviewFoldersFromEntries(CWD, entries);
    expect(entryKindAt(folders, `${CWD}/src`)).toBe("directory");
    expect(entryKindAt(folders, `${CWD}/src/main.ts`)).toBe("file");
    // The root is nobody's entry.
    expect(entryKindAt(folders, CWD)).toBeNull();
    expect(entryKindAt(folders, `${CWD}/src/missing.ts`)).toBeNull();
    expect(entryKindAt(folders, `${CWD}/nowhere/deep.ts`)).toBeNull();
    expect(entryKindAt(folders, "/")).toBeNull();
    // A top-level path's parent is the root itself, and the name is whole.
    const top = overviewFoldersFromEntries("/", [{ path: "top.txt", kind: "file" }]);
    expect(entryKindAt(top, "/top.txt")).toBe("file");
  });
});
