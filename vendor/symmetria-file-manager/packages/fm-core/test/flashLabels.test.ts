import { describe, expect, it } from "vitest";

import {
  computeFlash,
  type FlashCandidate,
  type FlashColumn,
  LABEL_CHARS,
} from "../src/flash/labels.ts";

/**
 * Labelling, as a function of characters.
 *
 * The port of `FlashLogic.js` from the Qt build, which is 173 lines of pure
 * JavaScript and the one piece of flash that never needed a window. Every
 * assertion here comes from the plan's acceptance criteria for this phase;
 * where a number is arithmetic over the label pool it is derived in the
 * comment, so a reader can check it without running anything.
 */

function candidate(name: string, column: FlashColumn, index: number): FlashCandidate {
  return { name, column, index };
}

/** A whole column's worth, indexed from zero in the order given. */
function column(names: readonly string[], which: FlashColumn): FlashCandidate[] {
  return names.map((name, index) => candidate(name, which, index));
}

/** The label each match carries, in priority order. */
function labelsOf(matches: readonly { readonly label: string }[]): string[] {
  return matches.map((match) => match.label);
}

/**
 * A listing engineered to leave exactly the named characters in the label pool.
 *
 * Every name is `a` followed by one letter, so a query of `"a"` makes that
 * letter a continuation; the query's own `a` goes too. What survives is
 * precisely the characters asked for — which is how the one- and two-character
 * boundaries are reached with twenty-odd rows instead of six hundred.
 */
function listingLeavingFree(free: readonly string[]): FlashCandidate[] {
  const excluded = new Set(["a", ...free]);
  const letters = [...LABEL_CHARS].filter((letter) => !excluded.has(letter));
  return column(
    letters.map((letter) => `a${letter}`),
    "current",
  );
}

describe("computeFlash — no matches", () => {
  const listing = column(["alpha", "beta"], "current");

  it("returns nothing at all for a query no name contains", () => {
    const result = computeFlash("zz", listing, 0);

    expect(result.matches).toEqual([]);
    expect([...result.labelChars]).toEqual([]);
    expect([...result.continuations]).toEqual([]);
    // The emptiness is a property of the query and not of the listing: the
    // same names under a query they do contain come back labelled.
    expect(computeFlash("al", listing, 0).matches).toHaveLength(1);
  });

  it("returns nothing at all for an empty query", () => {
    // "No session is narrowing yet" and "every row matches" must not be the
    // same state — the second one labels the whole column.
    const result = computeFlash("", listing, 0);

    expect(result.matches).toEqual([]);
    expect([...result.labelChars]).toEqual([]);
    expect([...result.continuations]).toEqual([]);
    expect(computeFlash("a", listing, 0).matches).toHaveLength(2);
  });
});

describe("computeFlash — continuation characters", () => {
  it("never hands out the character that follows the query as a label", () => {
    // "banana" holds "a" at 1, 3 and 5. The characters after are n, n, and
    // nothing — so `n` is a continuation and cannot be a label. With `a` (the
    // query) and `n` removed, the pool's first free character is `s`.
    const result = computeFlash("a", column(["banana"], "current"), 0);

    expect(result.continuations.has("n")).toBe(true);
    expect(result.labelChars.has("n")).toBe(false);
    expect(labelsOf(result.matches)).toEqual(["s"]);
  });

  it("inspects every occurrence in a name, not only the first", () => {
    // "asad" holds "a" at 0 and 2, followed by `s` and `d`. Reading only the
    // first occurrence would leave `d` free and hand it out as the label; both
    // occurrences leaves `f`, which is what this asserts.
    const result = computeFlash("a", column(["asad"], "current"), 0);

    expect(result.continuations.has("s")).toBe(true);
    expect(result.continuations.has("d")).toBe(true);
    expect(labelsOf(result.matches)).toEqual(["f"]);
  });

  it("excludes every character of the query itself", () => {
    // "usable" holds "sa" at 1, followed by `b`. Excluding b, s and a leaves
    // `d` as the pool's first free character.
    const result = computeFlash("sa", column(["usable"], "current"), 0);

    expect(result.continuations.has("s")).toBe(true);
    expect(result.continuations.has("a")).toBe(true);
    expect(result.continuations.has("b")).toBe(true);
    expect(labelsOf(result.matches)).toEqual(["d"]);
  });
});

describe("computeFlash — the label pool", () => {
  it("draws from the home-row pool in order, so the first match gets `a`", () => {
    expect(LABEL_CHARS).toBe("asdfghjklqwertyuiopzxcvbnm");

    // "zip" holds "z" at 0, followed by `i`. Neither z nor i is `a`, so the
    // single match takes the head of the pool.
    const result = computeFlash("z", column(["zip"], "current"), 0);

    expect(labelsOf(result.matches)).toEqual(["a"]);
  });
});

describe("computeFlash — priority", () => {
  // Every name ends in `x`, so the query has no following character anywhere
  // and the pool loses only `x` itself. Labels are then the pool in order.
  const listing: FlashCandidate[] = [
    ...column(["c0", "c1", "c2", "c3x", "c4", "c5x", "c6", "c7", "c8x"], "current"),
    ...column(["p0x", "p1", "p2x"], "preview"),
    ...column(["n0", "n1x"], "parent"),
  ];

  it("orders the current column by distance from the cursor, then preview, then parent", () => {
    const result = computeFlash("x", listing, 5);

    // current at distance 0, 2 and 3 from the cursor; then preview by index;
    // then parent by index.
    expect(result.matches.map((match) => match.name)).toEqual([
      "c5x",
      "c3x",
      "c8x",
      "p0x",
      "p2x",
      "n1x",
    ]);
    expect(labelsOf(result.matches)).toEqual(["a", "s", "d", "f", "g", "h"]);
  });

  it("records where the query sits inside each name", () => {
    const result = computeFlash("x", listing, 5);

    // Every fixture name is three characters with `x` last.
    expect(result.matches.map((match) => match.matchStart)).toEqual([2, 2, 2, 2, 2, 2]);
  });
});

describe("computeFlash — two-character labels", () => {
  // Thirty names ending in `x`: more matches than the 25 characters the pool
  // holds once `x` is excluded, so single labels cannot cover them.
  const many = column(
    Array.from({ length: 30 }, (_, index) => `f${String(index).padStart(2, "0")}x`),
    "current",
  );

  it("issues them once the single-character pool cannot cover every match", () => {
    const result = computeFlash("x", many, 0);

    expect(result.matches).toHaveLength(30);
    expect(result.matches.every((match) => match.label !== "")).toBe(true);
    expect(result.matches.some((match) => match.label.length === 2)).toBe(true);
  });

  it("never starts a two-character label with a character that is also a single label", () => {
    // The rule the Qt source calls CRITICAL: a one-character label resolves
    // first, so a two-character label sharing its first character can never be
    // reached.
    const result = computeFlash("x", many, 0);

    const singles = new Set(
      result.matches.filter((match) => match.label.length === 1).map((match) => match.label),
    );
    const prefixes = result.matches
      .filter((match) => match.label.length === 2)
      .map((match) => match.label.charAt(0));

    expect(prefixes.length).toBeGreaterThan(0);
    for (const prefix of prefixes) expect(singles.has(prefix)).toBe(false);
  });

  it("gives every match a label no other match shares", () => {
    const result = computeFlash("x", many, 0);
    const labels = labelsOf(result.matches);

    expect(labels).toHaveLength(30);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("computeFlash — running out of labels", () => {
  // Twenty-two names of the form "a<letter>" put twenty-two distinct
  // characters into the continuation set; the query's own `a` makes
  // twenty-three. Three characters survive — z, v and m — which reach at most
  // six two-character labels between them.
  const crowded = listingLeavingFree(["z", "v", "m"]);

  it("leaves the lowest-priority matches with no label rather than an unreachable one", () => {
    const result = computeFlash("a", crowded, 0);

    expect(result.matches).toHaveLength(22);
    expect(result.matches.filter((match) => match.label === "")).toHaveLength(16);
  });

  it("labels in priority order, so every unlabelled match sits after every labelled one", () => {
    const result = computeFlash("a", crowded, 0);
    const labels = labelsOf(result.matches);
    const firstEmpty = labels.indexOf("");

    expect(firstEmpty).toBe(6);
    expect(labels.slice(firstEmpty).every((label) => label === "")).toBe(true);
  });
});

describe("computeFlash — the reported label characters", () => {
  it("lists every character used in any label, including both of a pair", () => {
    const many = column(
      Array.from({ length: 30 }, (_, index) => `f${String(index).padStart(2, "0")}x`),
      "current",
    );
    const result = computeFlash("x", many, 0);

    const used = new Set<string>();
    for (const match of result.matches) for (const char of match.label) used.add(char);

    expect([...result.labelChars].sort()).toEqual([...used].sort());
    // A pair contributes both of its characters, so the set is larger than the
    // count of one-character labels.
    expect(result.labelChars.size).toBeGreaterThan(
      result.matches.filter((match) => match.label.length === 1).length,
    );
  });
});

// ── Guards ─────────────────────────────────────────────────────────────────
// Durable tests, written after the phase's review. The first three pin the
// boundaries of `planLabels`, where review found a real defect: with exactly
// two characters left, spending both as prefixes reaches no further than one
// single plus one pair and costs the top match its one-key label.

describe("computeFlash — a pool of exactly two characters", () => {
  const listing = listingLeavingFree(["z", "m"]);

  it("keeps the highest-priority match on a single-character label", () => {
    // Reach is flat here: one single plus one pair, or two pairs, both label
    // two matches. Taking the split with fewer prefixes is therefore free, and
    // it is what puts the nearest row one keystroke away.
    const result = computeFlash("a", listing, 0);

    expect(labelsOf(result.matches).slice(0, 2)).toEqual(["z", "mz"]);
  });

  it("labels as many matches as the pool can reach and no more", () => {
    const result = computeFlash("a", listing, 0);

    expect(result.matches).toHaveLength(23);
    expect(result.matches.filter((match) => match.label !== "")).toHaveLength(2);
  });
});

describe("computeFlash — a pool of exactly one character", () => {
  it("labels one match, because a lone character has nothing to pair with", () => {
    const result = computeFlash("a", listingLeavingFree(["m"]), 0);

    expect(labelsOf(result.matches).slice(0, 1)).toEqual(["m"]);
    expect(result.matches.filter((match) => match.label !== "")).toHaveLength(1);
  });
});

describe("computeFlash — an empty pool", () => {
  it("labels nothing at all when every character could continue the query", () => {
    const result = computeFlash("a", listingLeavingFree([]), 0);

    expect(result.matches).toHaveLength(25);
    expect(result.matches.every((match) => match.label === "")).toBe(true);
    expect([...result.labelChars]).toEqual([]);
  });
});

describe("computeFlash — the empty result", () => {
  it("hands each caller its own sets, so one caller cannot corrupt the next", () => {
    // The empty result was a shared module constant. `ReadonlySet` stops a
    // consumer at compile time and not at runtime, and one `add` would have
    // poisoned every later empty result for the life of the process.
    const listing = column(["alpha"], "current");
    const first = computeFlash("zz", listing, 0);
    const second = computeFlash("zz", listing, 0);

    expect(first.continuations).not.toBe(second.continuations);
    expect(first.labelChars).not.toBe(second.labelChars);
    expect(first.matches).not.toBe(second.matches);
  });
});

describe("computeFlash — the case of the query", () => {
  it("matches without regard to case, so an uppercase query behaves as its lowercase", () => {
    // Two listings rather than one, because a single listing holding both
    // "Alpha" and "beta" matches BOTH on a query of "a" — "beta" has one too.
    const upper = column(["Alpha", "grub"], "current");
    const lower = column(["beta", "grub"], "current");

    expect(computeFlash("A", upper, 0).matches.map((match) => match.name)).toEqual(["Alpha"]);
    expect(computeFlash("BE", lower, 0).matches.map((match) => match.name)).toEqual(["beta"]);
  });
});
