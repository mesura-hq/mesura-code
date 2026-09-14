import { describe, expect, it } from "vitest";

import { filterFrecent, parseFrecent } from "../src/zoxide.ts";

/**
 * Reading what `zoxide query --list --score` prints.
 *
 * Measured on the real command rather than assumed. Two things the shape gets
 * wrong if you write the parser from memory:
 *
 * - **the score is right-aligned**, so every line but the widest begins with
 *   spaces;
 * - **a path may contain spaces**, so the split is on the FIRST run of
 *   whitespace and never on all of them.
 */
const REAL = ` 4536.0 /home/jc/Downloads
  446.0 /home/jc/work/sales/bambin
  278.0 /home/jc/.dotfiles
`;

describe("reading the frecent list", () => {
  it("reads a score and a path from each line", () => {
    expect(parseFrecent(REAL)).toEqual([
      { score: 4536, path: "/home/jc/Downloads" },
      { score: 446, path: "/home/jc/work/sales/bambin" },
      { score: 278, path: "/home/jc/.dotfiles" },
    ]);
  });

  it("keeps a path that contains spaces whole", () => {
    // The reason the split is on the first run of whitespace. A directory
    // called `My Documents` is ordinary, and splitting on every space would
    // silently truncate it to `My`.
    expect(parseFrecent(" 12.0 /home/jc/My Documents/Tax 2026\n")).toEqual([
      { score: 12, path: "/home/jc/My Documents/Tax 2026" },
    ]);
  });

  it("gives an empty list for empty output", () => {
    // A database with nothing in it is not an error. It is what a fresh
    // install looks like, and the popup should say so rather than fail.
    expect(parseFrecent("")).toEqual([]);
    expect(parseFrecent("\n")).toEqual([]);
  });

  it("skips a line it cannot read rather than yielding a NaN score", () => {
    // One unreadable line must not take the whole list with it, and must not
    // arrive as a row with a score of NaN that sorts unpredictably.
    const mixed = " 10.0 /home/jc/a\nnonsense\n 5.0 /home/jc/b\n";
    expect(parseFrecent(mixed)).toEqual([
      { score: 10, path: "/home/jc/a" },
      { score: 5, path: "/home/jc/b" },
    ]);
  });

  it("keeps a trailing space that is part of the directory's name", () => {
    // Review found a `trimEnd()` here that could not tell a legitimate trailing
    // space from a carriage return. A directory whose name ends in a space is
    // unusual and entirely legal, and trimming it hands back a different path
    // that most likely does not exist — a wrong row rather than a skipped one,
    // which is the failure this parser exists to avoid.
    expect(parseFrecent(" 12.0 /home/jc/trailing \n")).toEqual([
      { score: 12, path: "/home/jc/trailing " },
    ]);
  });

  it("drops a carriage return without dropping anything else", () => {
    expect(parseFrecent(" 12.0 /home/jc/a\r\n")).toEqual([{ score: 12, path: "/home/jc/a" }]);
  });

  it("skips a line whose path is not absolute", () => {
    expect(parseFrecent(" 10.0 relative/path\n")).toEqual([]);
  });

  it("keeps the order zoxide gave, which is by score", () => {
    // zoxide sorts by frecency and that ordering is the whole value of asking
    // it. Re-sorting here would throw away the one thing it knows.
    const listed = parseFrecent(" 1.0 /a\n 900.0 /b\n 50.0 /c\n");
    expect(listed.map((e) => e.path)).toEqual(["/a", "/b", "/c"]);
  });
});

describe("narrowing the list as the user types", () => {
  const entries = parseFrecent(REAL);

  it("gives everything for an empty query", () => {
    expect(filterFrecent(entries, "")).toHaveLength(3);
  });

  it("keeps the paths that contain what was typed", () => {
    expect(filterFrecent(entries, "sales").map((e) => e.path)).toEqual([
      "/home/jc/work/sales/bambin",
    ]);
  });

  it("ignores the case of what was typed", () => {
    expect(filterFrecent(entries, "DOWNLOADS").map((e) => e.path)).toEqual(["/home/jc/Downloads"]);
  });

  it("matches anywhere in the path, not only the last segment", () => {
    expect(filterFrecent(entries, "/home/jc/w").map((e) => e.path)).toEqual([
      "/home/jc/work/sales/bambin",
    ]);
  });

  it("gives nothing when nothing matches", () => {
    expect(filterFrecent(entries, "zzzz")).toEqual([]);
  });

  it("ignores the spaces around what was typed", () => {
    expect(filterFrecent(entries, "  sales  ")).toHaveLength(1);
  });

  it("matches on a plain substring, deliberately, and not fuzzily", () => {
    // `dtflies` would match `.dotfiles` under a subsequence match. It does not
    // here: the fuzzy finder is a run of its own, designed with Mesura Code,
    // and a second half-built matcher living here is what that run would have
    // to delete first.
    expect(filterFrecent(entries, "dtfl")).toEqual([]);
  });
});
