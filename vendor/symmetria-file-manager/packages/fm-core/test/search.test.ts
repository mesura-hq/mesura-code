import { describe, expect, it } from "vitest";

import type { FsEntry } from "../src/entry.ts";
import { computeMatches, matchAfterReload, nextMatch, previousMatch } from "../src/search.ts";

/**
 * Searching, as index arithmetic.
 *
 * The whole algorithm, and none of the cursor. `SearchHandler.js` in the Qt
 * build is 49 lines and does exactly this: turn a query and a listing into the
 * indices that match, then step through them. Keeping it free of a pane means
 * the wrapping and the reload case are testable without a window.
 */

function entry(name: string): FsEntry {
  return { name, kind: "file", size: 0, modifiedMs: 0, isSymlink: false, isHidden: false };
}

const listing = ["alpha.txt", "Beta.md", "gamma.rs", "delta.txt", "BETAMAX"].map(entry);

describe("computeMatches", () => {
  it("returns the indices whose name contains the query", () => {
    expect(computeMatches(listing, "txt")).toEqual([0, 3]);
  });

  it("compares without regard to case, in both directions", () => {
    // The query is lowercased and so is the name: an uppercase query must find
    // a lowercase name, and the reverse.
    expect(computeMatches(listing, "beta")).toEqual([1, 4]);
    expect(computeMatches(listing, "BETA")).toEqual([1, 4]);
    expect(computeMatches(listing, "ALPHA")).toEqual([0]);
  });

  it("matches anywhere in the name, not only at the start", () => {
    expect(computeMatches(listing, "amma")).toEqual([2]);
  });

  it("returns nothing for an empty query", () => {
    // Not "everything". An empty query means no search is running, and matching
    // every row would light the whole column up.
    expect(computeMatches(listing, "")).toEqual([]);
    expect(computeMatches(listing, "   ")).toEqual([]);
  });

  it("returns nothing when the query matches nothing", () => {
    expect(computeMatches(listing, "zzz")).toEqual([]);
  });

  it("returns nothing for an empty listing", () => {
    expect(computeMatches([], "a")).toEqual([]);
  });
});

describe("stepping through the matches", () => {
  const matches = [1, 4, 7];

  it("goes forward, and wraps at the end", () => {
    expect(nextMatch(matches, 0)).toBe(1);
    expect(nextMatch(matches, 1)).toBe(2);
    expect(nextMatch(matches, 2)).toBe(0);
  });

  it("goes backward, and wraps at the start", () => {
    expect(previousMatch(matches, 2)).toBe(1);
    expect(previousMatch(matches, 1)).toBe(0);
    expect(previousMatch(matches, 0)).toBe(2);
  });

  it("stays put when there is nothing to step through", () => {
    expect(nextMatch([], 0)).toBe(-1);
    expect(previousMatch([], 0)).toBe(-1);
  });

  it("lands on the first match from a position that is not one", () => {
    // -1 is "no current match", which is where a fresh search starts.
    expect(nextMatch(matches, -1)).toBe(0);
    expect(previousMatch(matches, -1)).toBe(matches.length - 1);
  });
});

describe("recomputing after the listing reloads", () => {
  /**
   * The Qt behaviour worth carrying: a watcher refresh or a re-sort must not
   * throw the search back to its first match.
   */
  it("keeps the position when the cursor's row is still a match", () => {
    // Matches at 1, 4, 7; the cursor sits on 4, which is the second of them.
    expect(matchAfterReload([1, 4, 7], 4)).toBe(1);
  });

  it("falls back to the first match when the cursor's row no longer matches", () => {
    expect(matchAfterReload([1, 4, 7], 5)).toBe(0);
  });

  it("reports no match at all when the listing lost every one", () => {
    expect(matchAfterReload([], 4)).toBe(-1);
  });
});
