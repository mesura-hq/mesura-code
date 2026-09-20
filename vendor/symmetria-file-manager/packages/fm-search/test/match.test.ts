/**
 * Matched character positions, recomputed here because the engine does not
 * return them.
 *
 * Acceptance criterion 6. The engine's file-search result carries no
 * per-character positions — only its content search does — so the row
 * renderer's highlighting has nothing to draw from unless this recomputes it.
 * The Qt build does the same, with a greedy subsequence match.
 */
import { describe, expect, it } from "vitest";

import { matchIndices } from "../src/main/match.ts";

describe("matchIndices", () => {
  it("returns the position of each query character, in order", () => {
    expect(matchIndices("format.ts", "fmt")).toEqual([0, 3, 5]);
  });

  it("takes the earliest position for each character, greedily", () => {
    // Two candidate `t`s. Greedy takes the first one that still leaves the
    // rest of the query matchable.
    expect(matchIndices("stat.txt", "st")).toEqual([0, 1]);
  });

  it("takes the first viable position for each character, even across a separator", () => {
    // The greedy artifact, asserted rather than hidden. "comp" against
    // "src/components/" takes the `c` of "src" at 2, not the `c` of
    // "components" at 4, then runs on through o/m/p. A human would prefer
    // 4,5,6,7. The engine has already decided which rows match and in what
    // order; this only places the emphasis, so the cost is a little visual
    // polish. An optimal span would need a dynamic program per row per
    // keystroke. The Qt build has the same behaviour.
    expect(matchIndices("src/components/", "comp")).toEqual([2, 5, 6, 7]);
  });

  it("returns nothing when the query is not a subsequence", () => {
    // Paired with a matching query on the SAME name, so the empty result is
    // discriminating: a function that always returned [] would fail the first
    // assertion here rather than passing this test for free.
    expect(matchIndices("format.ts", "fmt")).toEqual([0, 3, 5]);
    expect(matchIndices("format.ts", "zzz")).toEqual([]);
  });

  it("returns nothing for an empty query", () => {
    expect(matchIndices("format.ts", "f")).toEqual([0]);
    expect(matchIndices("format.ts", "")).toEqual([]);
  });

  it("ignores case in both directions", () => {
    expect(matchIndices("README.md", "rme")).toEqual([0, 4, 5]);
    expect(matchIndices("readme.md", "RME")).toEqual([0, 4, 5]);
  });

  it("does not run past the end when the query is longer than the name", () => {
    expect(matchIndices("ab", "ab")).toEqual([0, 1]);
    expect(matchIndices("ab", "abc")).toEqual([]);
  });
});
