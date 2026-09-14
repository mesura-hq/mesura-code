import { describe, expect, it } from "vitest";

import type { FsEntry } from "../src/entry.ts";
import { compareEntries, naturalCompare, type SortMode, sortEntries } from "../src/sort.ts";

function file(name: string, over: Partial<FsEntry> = {}): FsEntry {
  return {
    name,
    kind: "file",
    size: 0,
    modifiedMs: 0,
    isSymlink: false,
    isHidden: name.startsWith("."),
    ...over,
  };
}

function dir(name: string, over: Partial<FsEntry> = {}): FsEntry {
  return { ...file(name, over), kind: "directory" };
}

const order = (entries: FsEntry[], mode: SortMode, descending = false) =>
  sortEntries(entries, mode, descending).map((e) => e.name);

describe("directories sort before files, in every mode", () => {
  // The Qt version's tree walk depended on this and so will the columns:
  // `compareEntries` in filesystemmodel.cpp put directories first regardless of
  // the active sort. Asserted per mode rather than once, because a mode added
  // later is exactly where this gets forgotten.
  const mixed = [file("a-file"), dir("z-dir"), file("b-file"), dir("y-dir")];
  const modes: SortMode[] = ["alphabetical", "modified", "size", "extension", "natural"];

  for (const mode of modes) {
    it(`holds for ${mode}`, () => {
      const names = order(mixed, mode);
      expect(names.slice(0, 2).every((n) => n.endsWith("-dir"))).toBe(true);
    });
  }

  it("still holds when the order is reversed", () => {
    const names = order(mixed, "alphabetical", true);
    expect(names.slice(0, 2).every((n) => n.endsWith("-dir"))).toBe(true);
  });
});

describe("alphabetical", () => {
  it("orders case-insensitively, so Apple sits beside apricot", () => {
    expect(order([file("banana"), file("Apple"), file("apricot")], "alphabetical")).toEqual([
      "Apple",
      "apricot",
      "banana",
    ]);
  });
});

describe("natural", () => {
  it("orders embedded numbers by value, not by digit", () => {
    // The whole reason this mode exists. Alphabetically, `file10` precedes
    // `file2`.
    expect(order([file("file10.txt"), file("file2.txt"), file("file1.txt")], "natural")).toEqual([
      "file1.txt",
      "file2.txt",
      "file10.txt",
    ]);
  });

  it("handles a number at the start of the name", () => {
    expect(order([file("10-b"), file("2-a"), file("1-c")], "natural")).toEqual([
      "1-c",
      "2-a",
      "10-b",
    ]);
  });

  it("handles several number runs in one name", () => {
    expect(order([file("v1-part10"), file("v1-part2"), file("v2-part1")], "natural")).toEqual([
      "v1-part2",
      "v1-part10",
      "v2-part1",
    ]);
  });
});

describe("size", () => {
  it("orders by byte count, largest last by default", () => {
    expect(
      order(
        [file("big", { size: 9000 }), file("small", { size: 12 }), file("mid", { size: 400 })],
        "size",
      ),
    ).toEqual(["small", "mid", "big"]);
  });
});

describe("modified", () => {
  it("orders by modification time, oldest first by default", () => {
    expect(
      order(
        [
          file("new", { modifiedMs: 3000 }),
          file("old", { modifiedMs: 1000 }),
          file("mid", { modifiedMs: 2000 }),
        ],
        "modified",
      ),
    ).toEqual(["old", "mid", "new"]);
  });
});

describe("extension", () => {
  it("groups by extension, then by name inside a group", () => {
    expect(order([file("b.ts"), file("a.md"), file("a.ts"), file("c.md")], "extension")).toEqual([
      "a.md",
      "c.md",
      "a.ts",
      "b.ts",
    ]);
  });

  it("treats a dotfile as having no extension, not as extension 'bashrc'", () => {
    // `.bashrc` is a hidden file named `.bashrc`, not a file with extension
    // `bashrc`. Getting this wrong scatters every dotfile across the listing.
    expect(order([file("z.ts"), file(".bashrc")], "extension")).toEqual([".bashrc", "z.ts"]);
  });
});

describe("compareEntries is a stable, total order", () => {
  it("returns 0 only for entries that tie on every key", () => {
    const a = file("same");
    const b = file("same");
    expect(compareEntries(a, b, "alphabetical")).toBe(0);
  });

  it("breaks a tie on the sort key by name, so the order is deterministic", () => {
    // Two files of equal size must not swap between runs.
    const entries = [file("b", { size: 100 }), file("a", { size: 100 })];
    expect(order(entries, "size")).toEqual(["a", "b"]);
  });
});

/**
 * Guards for the two defects review found in `naturalCompare`.
 */
describe("naturalCompare, exactness", () => {
  it("compares digit runs past Number.MAX_SAFE_INTEGER exactly", () => {
    // Both convert to the same double. `Number(a) - Number(b)` returns 0 and
    // the order becomes arbitrary — a real hazard for hashes and for
    // epoch-nanosecond timestamps.
    const a = "log-99999999999999999998";
    const b = "log-99999999999999999999";
    expect(naturalCompare(a, b)).toBeLessThan(0);
    expect(naturalCompare(b, a)).toBeGreaterThan(0);
  });

  it("orders fewer leading zeros first, in the function itself", () => {
    // An earlier draft claimed this in a comment and did not do it: it fell
    // through and returned 0, so the order only emerged by accident through
    // the caller's name fallback.
    expect(naturalCompare("file1", "file01")).toBeLessThan(0);
    expect(naturalCompare("file01", "file1")).toBeGreaterThan(0);
  });

  it("still treats equal values with equal text as equal", () => {
    expect(naturalCompare("file7", "file7")).toBe(0);
  });
});
