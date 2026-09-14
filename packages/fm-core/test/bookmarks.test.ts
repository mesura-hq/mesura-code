import { describe, expect, it } from "vitest";
import {
  decodeBookmarks,
  isReservedLetter,
  labelFor,
  RESERVED_LETTERS,
  resolveBookmarks,
  seedBookmarks,
} from "../src/bookmarks.ts";
import { goGroupWith } from "../src/keys/chords.ts";

/**
 * Bookmarks, as data.
 *
 * The store's shape, the seed, and what a hand-edited file is allowed to say.
 * Nothing here knows where a home directory is or that a file exists — the host
 * supplies the one and owns the other.
 */

describe("the seed", () => {
  const seed = seedBookmarks("/home/jc");

  it("binds the eight directories a person actually visits", () => {
    expect([...seed.keys()].sort()).toEqual(["c", "d", "h", "m", "o", "p", "r", "v"]);
  });

  it("puts home itself on h, without a trailing separator", () => {
    expect(seed.get("h")?.path).toBe("/home/jc");
  });

  it("resolves the rest against the home it was given", () => {
    expect(seed.get("d")?.path).toBe("/home/jc/Downloads");
    expect(seed.get("p")?.path).toBe("/home/jc/Pictures");
    expect(seed.get("v")?.path).toBe("/home/jc/Videos");
    expect(seed.get("c")?.path).toBe("/home/jc/.config");
  });

  it("takes the home it is given rather than knowing one", () => {
    // The package compiles with no environment at all, so it cannot read
    // `$HOME` even if it wanted to. That is the seam, not an inconvenience.
    expect(seedBookmarks("/root").get("d")?.path).toBe("/root/Downloads");
  });

  it("labels each one by its directory name", () => {
    expect(seed.get("d")?.label).toBe("Downloads");
    expect(seed.get("h")?.label).toBe("jc");
  });

  it("binds no reserved letter", () => {
    for (const letter of RESERVED_LETTERS) expect(seed.has(letter)).toBe(false);
  });
});

describe("the reserved letters", () => {
  it("are the three the go chord already spends", () => {
    // `gg` is jump-to-top, `gn` opens the create sub-mode, `gx` the delete one.
    // A bookmark on any of them would be unreachable by construction.
    expect([...RESERVED_LETTERS].sort()).toEqual(["g", "n", "x"]);
  });

  it("are recognised whatever their case", () => {
    expect(isReservedLetter("g")).toBe(true);
    expect(isReservedLetter("G")).toBe(true);
    expect(isReservedLetter("p")).toBe(false);
  });
});

describe("labelling a path", () => {
  it("uses the last segment", () => {
    expect(labelFor("/home/jc/Downloads")).toBe("Downloads");
  });

  it("ignores a trailing separator", () => {
    expect(labelFor("/home/jc/Downloads/")).toBe("Downloads");
  });

  it("falls back to the whole path when there is no last segment", () => {
    // The filesystem root has no basename, and a bookmark labelled with an
    // empty string is a blank row in the which-key overlay.
    expect(labelFor("/")).toBe("/");
  });
});

describe("decoding a stored file", () => {
  it("reads a well-formed map", () => {
    const stored = decodeBookmarks({
      w: { path: "/work", label: "work" },
      z: { path: "/tmp/z", label: "z" },
    });

    expect(stored.get("w")?.path).toBe("/work");
    expect(stored.get("z")?.label).toBe("z");
  });

  it("supplies a label when the file omits one", () => {
    expect(decodeBookmarks({ w: { path: "/work" } }).get("w")?.label).toBe("work");
  });

  it("returns nothing at all for a value that is not an object", () => {
    // A hand-edited file that is a list, a string or null is not a partly
    // usable store — it is not a store.
    expect(decodeBookmarks(null).size).toBe(0);
    expect(decodeBookmarks([]).size).toBe(0);
    expect(decodeBookmarks("h=/home").size).toBe(0);
    expect(decodeBookmarks(42).size).toBe(0);
  });

  it("drops a malformed entry and keeps the rest", () => {
    // One bad line must not cost the user their other seven bookmarks.
    const stored = decodeBookmarks({
      w: { path: "/work" },
      b: "not an object",
      c: { label: "no path here" },
      d: { path: 7 },
      e: { path: "" },
    });

    expect([...stored.keys()]).toEqual(["w"]);
  });

  it("drops a key that is not a single letter", () => {
    const stored = decodeBookmarks({
      w: { path: "/work" },
      ww: { path: "/two" },
      "1": { path: "/digit" },
      "": { path: "/empty" },
    });

    expect([...stored.keys()]).toEqual(["w"]);
  });

  it("drops a reserved key, however it got into the file", () => {
    const stored = decodeBookmarks({
      g: { path: "/nope" },
      n: { path: "/nope" },
      x: { path: "/nope" },
      w: { path: "/work" },
    });

    expect([...stored.keys()]).toEqual(["w"]);
  });

  it("drops a relative path", () => {
    // Every other path in this application is absolute, and a bookmark that
    // resolves against a working directory the renderer never learns is a
    // bookmark that lands somewhere different each run.
    expect(decodeBookmarks({ w: { path: "work/here" } }).size).toBe(0);
  });
});

describe("what the store answers with", () => {
  /**
   * ── The seed is written once, and the file is the truth afterwards ────────
   * The plan's criterion says a stored file "overrides the seed by letter",
   * which reads as a merge. A merge cannot work: `gx` deletes a bookmark, and a
   * seed re-merged on every start would put Pictures back on the next launch
   * with no way for the user to say no.
   *
   * Qt settles it the same way — its defaults are "seeded on first run,
   * deletable by the user". So: no file means the seed, and it is written; a
   * file means the file. `resolveBookmarks` is that rule, and it reports
   * whether the caller owes the disk a write.
   */
  const seed = seedBookmarks("/home/jc");

  it("answers with the seed when nothing is stored, and asks to be written", () => {
    const resolved = resolveBookmarks(seed, null);

    expect([...resolved.bookmarks.keys()].sort()).toEqual([...seed.keys()].sort());
    expect(resolved.shouldWrite).toBe(true);
  });

  it("answers with the file when there is one, and writes nothing", () => {
    const resolved = resolveBookmarks(seed, decodeBookmarks({ w: { path: "/work" } }));

    expect([...resolved.bookmarks.keys()]).toEqual(["w"]);
    expect(resolved.shouldWrite).toBe(false);
  });

  it("honours a deletion, because the file is the whole answer", () => {
    // The user pressed `gx p`. The file that came back has seven letters and
    // `p` is not among them; it must stay gone.
    const withoutPictures = new Map(seed);
    withoutPictures.delete("p");
    const resolved = resolveBookmarks(seed, withoutPictures);

    expect(resolved.bookmarks.has("p")).toBe(false);
    expect(resolved.bookmarks.has("d")).toBe(true);
  });

  it("treats an empty stored file as an empty store, not as a missing one", () => {
    // A user who deleted every bookmark gets none back. `null` means "no file";
    // an empty map means "a file that says nothing is bound".
    const resolved = resolveBookmarks(seed, new Map());

    expect(resolved.bookmarks.size).toBe(0);
    expect(resolved.shouldWrite).toBe(false);
  });

  it("falls back to the seed for an unreadable file WITHOUT offering to write", () => {
    // A malformed file is the user's data. Overwriting it with the seed would
    // destroy whatever they were part-way through editing, so the seed is used
    // in memory and the file is left alone for them to fix.
    const resolved = resolveBookmarks(seed, "unreadable");

    expect([...resolved.bookmarks.keys()].sort()).toEqual([...seed.keys()].sort());
    expect(resolved.shouldWrite).toBe(false);
  });
});

describe("the go group as the overlays draw it", () => {
  it("appends every bookmark after the prefix's own row", () => {
    const group = goGroupWith(
      new Map([
        ["d", { path: "/home/jc/Downloads", label: "Downloads" }],
        ["p", { path: "/home/jc/Pictures", label: "Pictures" }],
      ]),
    );

    expect(group.binds.map((bind) => bind.key)).toEqual(["g", "d", "p"]);
    expect(group.binds[1]?.label).toBe("Downloads");
  });

  it("orders the bookmarks by letter, so the overlay does not reshuffle", () => {
    // A map iterates in insertion order, which is the order the file happened
    // to be written in. Sorting makes the list the same every time it is drawn.
    const group = goGroupWith(
      new Map([
        ["v", { path: "/v", label: "Videos" }],
        ["d", { path: "/d", label: "Downloads" }],
        ["m", { path: "/m", label: "Music" }],
      ]),
    );

    expect(group.binds.map((bind) => bind.key)).toEqual(["g", "d", "m", "v"]);
  });

  it("is the bare prefix group when nothing is bound", () => {
    const group = goGroupWith(new Map());

    expect(group.binds.map((bind) => bind.key)).toEqual(["g"]);
  });

  it("does not mutate the table it reads", () => {
    // `copyGroupFor` next door has the same property and the same reason: the
    // chord table is module state, and two overlays read it on every render.
    const first = goGroupWith(new Map([["d", { path: "/d", label: "Downloads" }]]));
    const second = goGroupWith(new Map());

    expect(first.binds).toHaveLength(2);
    expect(second.binds).toHaveLength(1);
  });
});
