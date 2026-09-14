import { describe, expect, it } from "vitest";

import { computeFlash, type FlashCandidate, type FlashLabelling } from "../src/flash/labels.ts";
import { type FlashState, flashKey, newFlashState } from "../src/flash/session.ts";

/**
 * One key, one decision.
 *
 * The port of `FlashHandler.handleKey` from the Qt build, as a reducer. The Qt
 * version writes straight into `WindowState` as it goes; here every branch
 * returns what should happen and the host applies it, which is what lets the
 * whole key table be exercised without a window.
 *
 * `relabel` is a parameter of the reducer rather than a call it makes, because
 * the candidate list belongs to the host and changes as columns scroll. These
 * tests build theirs from the real engine, so a labelling asserted here is the
 * labelling the application would have.
 */

function column(names: readonly string[]): FlashCandidate[] {
  return names.map((name, index) => ({ name, column: "current" as const, index }));
}

/** Four names, all holding an `a`, labelled s · d · f · g in cursor order. */
const NEAR = column(["alpha", "beta", "gamma", "delta"]);
const relabelNear = (query: string): FlashLabelling => computeFlash(query, NEAR, 0);

/** Thirty names: more than the pool covers, so two-character labels appear. */
const MANY = column(Array.from({ length: 30 }, (_, i) => `f${String(i).padStart(2, "0")}x`));
const relabelMany = (query: string): FlashLabelling => computeFlash(query, MANY, 0);

/** A session already narrowed to `query`, with nothing pending. */
function narrowed(query: string, relabel: (query: string) => FlashLabelling): FlashState {
  return { query, pendingLabel: "", labelling: relabel(query) };
}

/** The label the engine gave a name, so a test never hard-codes the pool. */
function labelFor(labelling: FlashLabelling, name: string): string {
  return labelling.matches.find((match) => match.name === name)?.label ?? "";
}

describe("flashKey — cancelling", () => {
  it("reports a cancellation on Escape", () => {
    const state = narrowed("a", relabelNear);

    expect(flashKey(state, { key: "Escape" }, relabelNear).kind).toBe("cancel");
    // Cancelling is a property of the key: another key from the same state
    // does not cancel.
    expect(flashKey(state, { key: "l" }, relabelNear).kind).toBe("state");
  });

  it("reports a cancellation on Backspace with an empty query", () => {
    expect(flashKey(newFlashState(), { key: "Backspace" }, relabelNear).kind).toBe("cancel");
    // The same key over a query that has something to drop does not cancel.
    expect(flashKey(narrowed("a", relabelNear), { key: "Backspace" }, relabelNear).kind).toBe(
      "state",
    );
  });
});

describe("flashKey — Backspace", () => {
  it("clears a pending two-character label and leaves the query alone", () => {
    const pending: FlashState = { ...narrowed("x", relabelMany), pendingLabel: "m" };

    const outcome = flashKey(pending, { key: "Backspace" }, relabelMany);

    expect(outcome.kind).toBe("state");
    if (outcome.kind !== "state") return;
    expect(outcome.state.pendingLabel).toBe("");
    expect(outcome.state.query).toBe("x");
  });

  it("drops the last character of a non-empty query and relabels", () => {
    const outcome = flashKey(narrowed("al", relabelNear), { key: "Backspace" }, relabelNear);

    expect(outcome.kind).toBe("state");
    if (outcome.kind !== "state") return;
    expect(outcome.state.query).toBe("a");
    // "al" reaches only alpha; "a" reaches all four, and the labelling that
    // comes back has to be the wider one rather than the one it started with.
    expect(outcome.state.labelling.matches).toHaveLength(4);
  });
});

describe("flashKey — jumping", () => {
  it("jumps on a character that is an exact single-character label", () => {
    const state = narrowed("a", relabelNear);
    const outcome = flashKey(state, { key: labelFor(state.labelling, "gamma") }, relabelNear);

    expect(outcome.kind).toBe("jump");
    if (outcome.kind !== "jump") return;
    expect(outcome.match.name).toBe("gamma");
    expect(outcome.match.column).toBe("current");
    expect(outcome.match.index).toBe(2);
  });

  it("holds a two-character prefix, then jumps on the character that completes it", () => {
    const state = narrowed("x", relabelMany);
    const pair = state.labelling.matches.find((match) => match.label.length === 2);
    expect(pair).toBeDefined();
    if (pair === undefined) return;

    const held = flashKey(state, { key: pair.label.charAt(0) }, relabelMany);
    expect(held.kind).toBe("state");
    if (held.kind !== "state") return;
    expect(held.state.pendingLabel).toBe(pair.label.charAt(0));
    expect(held.state.query).toBe("x");

    const jumped = flashKey(held.state, { key: pair.label.charAt(1) }, relabelMany);
    expect(jumped.kind).toBe("jump");
    if (jumped.kind !== "jump") return;
    expect(jumped.match.name).toBe(pair.name);
  });

  it("ignores a second character that completes no pair, and clears what was held", () => {
    const state = narrowed("x", relabelMany);
    const pair = state.labelling.matches.find((match) => match.label.length === 2);
    if (pair === undefined) return;

    const held = flashKey(state, { key: pair.label.charAt(0) }, relabelMany);
    expect(held.kind).toBe("state");
    if (held.kind !== "state") return;

    // The query's own character can never be the second half of a pair: it is
    // a continuation, so it never entered the pool.
    const outcome = flashKey(held.state, { key: "x" }, relabelMany);

    expect(outcome.kind).toBe("state");
    if (outcome.kind !== "state") return;
    expect(outcome.state.pendingLabel).toBe("");
    expect(outcome.state.query).toBe("x");
  });
});

describe("flashKey — extending the query", () => {
  it("extends on a character that could continue a match", () => {
    const state = narrowed("a", relabelNear);
    expect(state.labelling.continuations.has("l")).toBe(true);

    const outcome = flashKey(state, { key: "l" }, relabelNear);

    expect(outcome.kind).toBe("state");
    if (outcome.kind !== "state") return;
    expect(outcome.state.query).toBe("al");
    expect(outcome.state.labelling.matches.map((match) => match.name)).toEqual(["alpha"]);
  });

  it("extends on the first character typed, whatever it is", () => {
    // A fresh session has no labels and no continuations, so the branch that
    // would otherwise drop an unknown character must not run yet.
    const outcome = flashKey(newFlashState(), { key: "a" }, relabelNear);

    expect(outcome.kind).toBe("state");
    if (outcome.kind !== "state") return;
    expect(outcome.state.query).toBe("a");
    expect(outcome.state.labelling.matches).toHaveLength(4);
  });

  it("lowers the character, so a capital extends the query as its lowercase", () => {
    const outcome = flashKey(narrowed("a", relabelNear), { key: "L" }, relabelNear);

    expect(outcome.kind).toBe("state");
    if (outcome.kind !== "state") return;
    expect(outcome.state.query).toBe("al");
  });
});

describe("flashKey — keys that change nothing", () => {
  const state = narrowed("a", relabelNear);

  it("leaves the state untouched for a bare modifier", () => {
    for (const key of ["Shift", "Control", "Alt", "Meta"]) {
      const outcome = flashKey(state, { key }, relabelNear);

      expect(outcome.kind).toBe("state");
      if (outcome.kind !== "state") continue;
      // The very same object: nothing was rebuilt and nothing was relabelled.
      expect(outcome.state).toBe(state);
    }
  });

  it("leaves the state untouched for a key that produces no character", () => {
    for (const key of ["F5", "ArrowLeft", "PageDown", "Tab"]) {
      const outcome = flashKey(state, { key }, relabelNear);

      expect(outcome.kind).toBe("state");
      if (outcome.kind !== "state") continue;
      expect(outcome.state).toBe(state);
    }
  });

  it("leaves the state untouched for a character that is neither a label nor a continuation", () => {
    // `q` is not among the labels s · d · f · g and not among the
    // continuations l · m · a, so there is nothing it could mean.
    expect(state.labelling.labelChars.has("q")).toBe(false);
    expect(state.labelling.continuations.has("q")).toBe(false);

    const outcome = flashKey(state, { key: "q" }, relabelNear);

    expect(outcome.kind).toBe("state");
    if (outcome.kind !== "state") return;
    expect(outcome.state).toBe(state);
  });
});

// ── Guards ─────────────────────────────────────────────────────────────────
// Reclassified from specs during the spec step: both passed on their first run,
// because `newFlashState` is not part of any acceptance criterion and was real
// from the start. They pin it rather than drive it.

describe("newFlashState", () => {
  it("starts with no query, nothing pending and nothing labelled", () => {
    const state = newFlashState();

    expect(state.query).toBe("");
    expect(state.pendingLabel).toBe("");
    expect(state.labelling.matches).toEqual([]);
  });

  it("hands each session its own labelling", () => {
    expect(newFlashState().labelling).not.toBe(newFlashState().labelling);
  });
});

describe("flashKey — a character outside the basic plane", () => {
  it("extends the query rather than being swallowed as a named key", () => {
    // Review read this branch backwards and reported the opposite defect, but
    // the divergence underneath was real: a surrogate pair reports `.length`
    // 2, so counting units rather than code points would have swallowed a
    // character the Qt build lets through.
    const listing = column(["🙂 notes", "plain"]);
    const relabel = (query: string): FlashLabelling => computeFlash(query, listing, 0);

    const outcome = flashKey(newFlashState(), { key: "🙂" }, relabel);

    expect(outcome.kind).toBe("state");
    if (outcome.kind !== "state") return;
    expect(outcome.state.query).toBe("🙂");
    expect(outcome.state.labelling.matches.map((match) => match.name)).toEqual(["🙂 notes"]);
  });
});

describe("flashKey — what holds a pending label", () => {
  it("keeps it through a key that produces no character", () => {
    // There is no timer and nothing incidental releases a held prefix: it
    // waits for the next character, an Escape, or a Backspace.
    const held: FlashState = { ...narrowed("x", relabelMany), pendingLabel: "m" };

    for (const key of ["F5", "ArrowDown", "Shift"]) {
      const outcome = flashKey(held, { key }, relabelMany);

      expect(outcome.kind).toBe("state");
      if (outcome.kind !== "state") continue;
      expect(outcome.state.pendingLabel).toBe("m");
    }
  });
});

describe("flashKey — a jump outside the current column", () => {
  it("reports the column it came from, not the one the cursor is in", () => {
    // What the two cross-column jumps are built on: the outcome has to say
    // WHERE, because navigating is the host's job and it cannot ask twice.
    const spread = [
      { name: "here-x", column: "current" as const, index: 4 },
      { name: "over-x", column: "preview" as const, index: 1 },
      { name: "back-x", column: "parent" as const, index: 7 },
    ];
    const relabel = (query: string): FlashLabelling => computeFlash(query, spread, 4);
    const state = narrowed("x", relabel);

    const outcome = flashKey(state, { key: labelFor(state.labelling, "back-x") }, relabel);

    expect(outcome.kind).toBe("jump");
    if (outcome.kind !== "jump") return;
    expect(outcome.match.column).toBe("parent");
    expect(outcome.match.index).toBe(7);
  });
});
