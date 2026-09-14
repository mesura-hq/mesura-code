import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bookmarksFilePath, loadBookmarks, saveBookmarks } from "../src/bookmarks.ts";

/**
 * The bookmark file, on disk.
 *
 * `fm-core/bookmarks` decides what a store MEANS; this owns where it lives and
 * what happens when the disk disagrees. Every test here points the store at a
 * scratch directory — **the operator's real `~/.config/symmetria-fm/` must
 * never be read or written by a test run**, which is why the path is injectable
 * rather than derived at import time.
 */

let scratch: string;
let file: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "symfm-marks-"));
  file = join(scratch, "bookmarks.json");
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("where the file lives", () => {
  it("defaults under the config directory, using the Qt build's name", () => {
    // The same path the Qt build uses, so the two can share a file on a machine
    // that runs both while the rewrite is being compared against the original.
    expect(bookmarksFilePath({ home: "/home/jc" })).toBe(
      "/home/jc/.config/symmetria-fm/bookmarks.json",
    );
  });

  it("can be pointed somewhere else", () => {
    expect(bookmarksFilePath({ home: "/home/jc", override: "/tmp/x/marks.json" })).toBe(
      "/tmp/x/marks.json",
    );
  });
});

describe("loading", () => {
  it("reports nothing stored when the file is not there", async () => {
    // Distinct from an empty store: nothing stored means "seed me", and an
    // empty store means "the user deleted everything".
    expect(await loadBookmarks(file)).toBeNull();
  });

  it("reads a stored map back", async () => {
    await writeFile(file, JSON.stringify({ w: { path: "/work", label: "work" } }));

    const stored = await loadBookmarks(file);

    expect(stored).not.toBeNull();
    expect(stored).not.toBe("unreadable");
    if (stored === null || stored === "unreadable") return;
    expect(stored.get("w")?.path).toBe("/work");
  });

  it("reports a file of invalid JSON as unreadable, not as absent", async () => {
    // Absent would mean "seed and write", which would destroy the file the user
    // is part-way through editing.
    await writeFile(file, "{ this is not json");

    expect(await loadBookmarks(file)).toBe("unreadable");
  });

  it("reports an empty file as unreadable rather than as an empty store", async () => {
    await writeFile(file, "");

    expect(await loadBookmarks(file)).toBe("unreadable");
  });

  it("reports valid JSON that is not an object as unreadable", async () => {
    // The criterion lists "not an object" beside missing and malformed, all
    // falling back to the seed. An earlier draft of this test asserted the
    // opposite — that `[]` is an empty store — which would have meant a file
    // holding a stray list silently bound nothing and was never repaired.
    await writeFile(file, "[]");
    expect(await loadBookmarks(file)).toBe("unreadable");

    await writeFile(file, '"h=/home"');
    expect(await loadBookmarks(file)).toBe("unreadable");

    await writeFile(file, "null");
    expect(await loadBookmarks(file)).toBe("unreadable");
  });

  it("still reads an empty object as a store that binds nothing", async () => {
    // Distinct from the above: `{}` IS a store. A user who deleted every
    // bookmark must not have them seeded back.
    await writeFile(file, "{}");

    const stored = await loadBookmarks(file);
    expect(stored).not.toBe("unreadable");
    expect(stored).not.toBeNull();
    if (stored === null || stored === "unreadable") return;
    expect(stored.size).toBe(0);
  });

  it("survives a directory where the file should be", async () => {
    await mkdir(file);

    expect(await loadBookmarks(file)).toBe("unreadable");
  });
});

describe("saving", () => {
  it("creates the directory it needs", async () => {
    const nested = join(scratch, "config", "symmetria-fm", "bookmarks.json");

    await saveBookmarks(nested, new Map([["w", { path: "/work", label: "work" }]]));

    expect(await loadBookmarks(nested)).not.toBeNull();
  });

  it("round-trips through the decoder", async () => {
    const marks = new Map([
      ["w", { path: "/work", label: "work" }],
      ["z", { path: "/tmp/z", label: "z" }],
    ]);

    await saveBookmarks(file, marks);
    const back = await loadBookmarks(file);

    expect(back).not.toBeNull();
    expect(back).not.toBe("unreadable");
    if (back === null || back === "unreadable") return;
    expect([...back.keys()].sort()).toEqual(["w", "z"]);
    expect(back.get("w")?.path).toBe("/work");
  });

  it("writes through a temporary file, so a crash cannot leave a half-file", async () => {
    // A partly-written bookmarks file is a start with no jumps at all. The
    // project's own convention is write-then-rename, and `rename` is the only
    // step that is atomic.
    await saveBookmarks(file, new Map([["w", { path: "/work", label: "work" }]]));

    const text = await readFile(file, "utf8");
    expect(() => JSON.parse(text)).not.toThrow();
    // Nothing left behind.
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(scratch)).toEqual(["bookmarks.json"]);
  });

  it("writes something a person can read and edit", async () => {
    await saveBookmarks(file, new Map([["w", { path: "/work", label: "work" }]]));

    const text = await readFile(file, "utf8");
    expect(text).toContain("\n");
    expect(text.endsWith("\n")).toBe(true);
  });
});
