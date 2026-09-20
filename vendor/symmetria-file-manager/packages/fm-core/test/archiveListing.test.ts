import { describe, expect, it } from "vitest";

import { buildArchiveListing } from "../src/preview/archive/listing.ts";
import type { ArchiveEntry } from "../src/preview/archive/types.ts";
import { MAX_ARCHIVE_ENTRIES } from "../src/preview/archive/types.ts";

/**
 * A flat list of archive paths, shaped into the rows the pane draws.
 *
 * Why the folders have to be invented and why the counts outrun the rows is in
 * `listing.ts`'s own header. Restating it here would be a second copy to keep
 * in step.
 */

function file(path: string, size: number): ArchiveEntry {
  return { path, size, isDirectory: false };
}

function folder(path: string): ArchiveEntry {
  return { path, size: 0, isDirectory: true };
}

describe("buildArchiveListing", () => {
  it("invents the folders a writer was allowed to leave out", () => {
    // A zip is a flat list of paths and NOTHING requires an entry for a
    // directory. So one file can be the only mention of two folders, and rows
    // built straight from the entries would have holes where they should be.
    const listing = buildArchiveListing([file("game/cache/build_info.json", 89)]);

    expect(listing.rows).toEqual([
      { path: "game", name: "game", depth: 0, isDirectory: true, size: 0 },
      { path: "game/cache", name: "cache", depth: 1, isDirectory: true, size: 0 },
      {
        path: "game/cache/build_info.json",
        name: "build_info.json",
        depth: 2,
        isDirectory: false,
        size: 89,
      },
    ]);
  });

  it("orders depth-first, folders before files, and carries each row's depth", () => {
    // **Every folder here is named to sort AFTER the files beside it.** The
    // first version of this fixture used `alpha/` next to `beta.txt`, where
    // the folder sorts first alphabetically anyway — so removing the
    // folders-before-files rule entirely changed nothing and the test passed
    // against both. Mutating the sort is how that came out.
    const listing = buildArchiveListing([
      file("aardvark.txt", 1),
      folder("zoo/"),
      file("zoo/apple.txt", 2),
      folder("zoo/zebra/"),
      file("zoo/zebra/deep.bin", 3),
      file("beta.txt", 4),
    ]);

    expect(listing.rows.map((row) => [row.path, row.depth])).toEqual([
      ["zoo", 0],
      ["zoo/zebra", 1],
      ["zoo/zebra/deep.bin", 2],
      ["zoo/apple.txt", 1],
      ["aardvark.txt", 0],
      ["beta.txt", 0],
    ]);
  });

  it("caps the rows and reports the total it did not show", () => {
    const entries: ArchiveEntry[] = [];
    for (let i = 0; i < 6000; i++) entries.push(file(`bulk/f${i}.bin`, i));

    const listing = buildArchiveListing(entries);

    expect(listing.rows).toHaveLength(MAX_ARCHIVE_ENTRIES);
    expect(listing.truncated).toBe(true);
    // One folder row plus six thousand files. The total is what the archive
    // holds, not what survived the cap.
    expect(listing.totalRows).toBe(6001);
  });

  it("counts every folder and every file, including past the cap", () => {
    const entries: ArchiveEntry[] = [];
    for (let i = 0; i < 6000; i++) entries.push(file(`d${i % 120}/f${i}.bin`, i));

    const listing = buildArchiveListing(entries);

    // The screenshot this pane is copied from reads "120 dirs, 1369 files" for
    // an archive whose listing IS truncated. A count of only the visible rows
    // would be a wrong number presented as a fact about the archive.
    expect(listing.dirCount).toBe(120);
    expect(listing.fileCount).toBe(6000);
    expect(listing.truncated).toBe(true);
  });

  it("says an empty archive is empty rather than truncated", () => {
    const listing = buildArchiveListing([]);

    expect(listing).toEqual({
      rows: [],
      truncated: false,
      totalRows: 0,
      dirCount: 0,
      fileCount: 0,
    });
  });
});

/**
 * Shapes real archives turn out to have.
 *
 * The first came from this phase's review and is the one worth naming: a
 * folder that used to be a file kept the size it had while it was one. It is
 * order-dependent, so neither reader guarantees you meet it — and
 * `/opt/android-studio/lib/app.jar` has fourteen entries with that shape.
 */
describe("buildArchiveListing, on archives that are not tidy", () => {
  it("zeroes the size of a file that later turns out to be a folder", () => {
    // File FIRST, then its descendant. The reverse order already worked: the
    // last-segment branch computes the kind from the children, so it saw a
    // folder from the start and never wrote a size.
    const listing = buildArchiveListing([file("a/b", 100), file("a/b/c", 5)]);

    expect(listing.rows).toEqual([
      { path: "a", name: "a", depth: 0, isDirectory: true, size: 0 },
      { path: "a/b", name: "b", depth: 1, isDirectory: true, size: 0 },
      { path: "a/b/c", name: "c", depth: 2, isDirectory: false, size: 5 },
    ]);
    expect(listing.dirCount).toBe(2);
    expect(listing.fileCount).toBe(1);
  });

  it("gives the same answer whichever order the two entries arrive in", () => {
    const forwards = buildArchiveListing([file("a/b", 100), file("a/b/c", 5)]);
    const backwards = buildArchiveListing([file("a/b/c", 5), file("a/b", 100)]);

    expect(forwards).toEqual(backwards);
  });

  it("drops the leading dot a tar writes on every member", () => {
    // `tar -cf x.tar .` names everything `./name`. Left alone, the empty and
    // `.` segments become rows with no name at all.
    const listing = buildArchiveListing([folder("./docs/"), file("./docs/read.me", 12)]);

    expect(listing.rows.map((row) => row.path)).toEqual(["docs", "docs/read.me"]);
  });

  it("does not double a folder that appears both with and without its slash", () => {
    // A zip may carry `game/` as its own entry AND as the prefix of its
    // members. They are one folder, and two rows for it would be visible.
    const listing = buildArchiveListing([
      folder("game/"),
      file("game/data.rpa", 7),
      folder("game/"),
    ]);

    expect(listing.rows.map((row) => row.path)).toEqual(["game", "game/data.rpa"]);
    expect(listing.dirCount).toBe(1);
  });

  it("survives a nesting depth that would exhaust the call stack", () => {
    // An archive path may hold 65535 bytes, so a file can nominate a depth
    // deep enough to blow a recursive walk. A preview must not be able to
    // crash the panel because of what a file claims about itself.
    const deep = new Array<string>(20000).fill("d").join("/");
    const listing = buildArchiveListing([file(`${deep}/leaf.txt`, 1)]);

    expect(listing.totalRows).toBe(20001);
    expect(listing.rows).toHaveLength(MAX_ARCHIVE_ENTRIES);
    expect(listing.truncated).toBe(true);
  });
});
