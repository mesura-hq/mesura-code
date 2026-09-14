import { describe, expect, it } from "vitest";

import type { FsEntry } from "../src/entry.ts";
import { filterEntries } from "../src/filter.ts";

function entry(name: string, over: Partial<FsEntry> = {}): FsEntry {
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

const listing = [
  entry("README.md"),
  entry(".bashrc"),
  entry("node_modules", { kind: "directory" }),
  entry("index.ts"),
  entry(".git", { kind: "directory" }),
];

const names = (out: FsEntry[]) => out.map((e) => e.name);

describe("filterEntries", () => {
  it("hides dotfiles by default", () => {
    expect(names(filterEntries(listing))).toEqual(["README.md", "node_modules", "index.ts"]);
  });

  it("shows them when asked", () => {
    expect(names(filterEntries(listing, { showHidden: true }))).toHaveLength(5);
  });

  it("drops what the host said to ignore, and nothing more", () => {
    // The injection seam. The file manager knows nothing about git; the host
    // hands it a set of names and that is the whole conversation.
    const out = filterEntries(listing, { ignored: new Set(["node_modules"]) });
    expect(names(out)).toEqual(["README.md", "index.ts"]);
  });

  it("treats an absent ignored set as ignoring nothing", () => {
    // `null`-safe by construction: absent is always safe is the contract the
    // IDE embedding proved, and it has to hold here too.
    expect(names(filterEntries(listing, { showHidden: true }))).toContain(".git");
  });

  it("matches a query case-insensitively, on a substring", () => {
    expect(names(filterEntries(listing, { query: "ME" }))).toEqual(["README.md"]);
  });

  it("ignores surrounding whitespace in a query", () => {
    expect(names(filterEntries(listing, { query: "  index  " }))).toEqual(["index.ts"]);
  });

  it("treats an empty query as no query, not as matching nothing", () => {
    expect(names(filterEntries(listing, { query: "   " }))).toHaveLength(3);
  });

  it("applies every rule together", () => {
    const out = filterEntries(listing, {
      showHidden: true,
      ignored: new Set([".git"]),
      query: "e",
    });
    expect(names(out)).toEqual(["README.md", "node_modules", "index.ts"]);
  });

  it("returns a new array and never mutates its input", () => {
    const before = [...listing];
    filterEntries(listing, { query: "x" });
    expect(listing).toEqual(before);
  });
});
