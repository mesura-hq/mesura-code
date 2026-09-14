import { describe, expect, it } from "vitest";

import { globToRegExp, specificity } from "../src/glob.ts";

const matches = (pattern: string, name: string, cs = false) => globToRegExp(pattern, cs).test(name);

/**
 * Guards for the defect review found: the first implementation handled only a
 * LEADING `*`, so real database rows like `*.tar.*` and `vgcore.*` could never
 * match. The failure was silent — the type resolved to the next-best row, or to
 * nothing, with no error anywhere.
 */
describe("globToRegExp", () => {
  it("matches a leading wildcard", () => {
    expect(matches("*.txt", "notes.txt")).toBe(true);
    expect(matches("*.txt", "notes.md")).toBe(false);
  });

  it("matches a wildcard that is not at the start", () => {
    // Real rows. The first implementation matched neither.
    expect(matches("*.tar.*", "backup.tar.gz")).toBe(true);
    expect(matches("vgcore.*", "vgcore.12345")).toBe(true);
    expect(matches("core.*", "core.999")).toBe(true);
  });

  it("matches a whole name with no wildcard at all", () => {
    expect(matches("Makefile", "Makefile")).toBe(true);
    expect(matches("Makefile", "Makefile.am")).toBe(false);
  });

  it("folds case by default, which is why photo.JPG resolves", () => {
    expect(matches("*.jpg", "photo.JPG")).toBe(true);
    expect(matches("*.txt", "README.TXT")).toBe(true);
  });

  it("respects the case-sensitive flag when the database sets it", () => {
    expect(matches("*.C", "main.C", true)).toBe(true);
    expect(matches("*.C", "main.c", true)).toBe(false);
  });

  it("matches a character class, which the database uses to split C from C++", () => {
    expect(matches("*.[Cc]", "main.C", true)).toBe(true);
    expect(matches("*.[Cc]", "main.c", true)).toBe(true);
    expect(matches("*.[Cc]", "main.h", true)).toBe(false);
  });

  it("matches a negated class", () => {
    expect(matches("file[!0-9]", "filea")).toBe(true);
    expect(matches("file[!0-9]", "file5")).toBe(false);
  });

  it("matches a single-character wildcard", () => {
    expect(matches("file?.txt", "file1.txt")).toBe(true);
    expect(matches("file?.txt", "file12.txt")).toBe(false);
  });

  it("treats regular-expression metacharacters as literals", () => {
    // A pattern is a glob, not an expression. `a+b.txt` must not mean "one or
    // more a".
    expect(matches("a+b.txt", "a+b.txt")).toBe(true);
    expect(matches("a+b.txt", "aab.txt")).toBe(false);
  });

  it("treats an unterminated class as a literal bracket, not an error", () => {
    // The database is user-extensible; a malformed row must not throw.
    expect(() => globToRegExp("file[abc")).not.toThrow();
    expect(matches("file[abc", "file[abc")).toBe(true);
  });

  it("anchors at both ends", () => {
    expect(matches("*.txt", "notes.txt.bak")).toBe(false);
  });
});

describe("specificity", () => {
  it("ranks a literal name above every glob", () => {
    // `Makefile` must beat `*`, however long the glob is.
    expect(specificity("Makefile")).toBeGreaterThan(specificity("*.reallylongextension"));
  });

  it("ranks a longer glob above a shorter one", () => {
    expect(specificity("*.tar.gz")).toBeGreaterThan(specificity("*.gz"));
  });
});
