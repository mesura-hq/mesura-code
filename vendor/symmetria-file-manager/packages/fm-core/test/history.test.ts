import { describe, expect, it } from "vitest";

import { emptyHistory, type HistoryStep, stepBack, stepForward, visit } from "../src/history.ts";

/**
 * A step that must have happened.
 *
 * Every operation here returns `null` for "nowhere to go", which is the right
 * shape for the caller and a poor one for a test: threading `?.` and `??`
 * through a four-step walk buries the assertion under fallbacks that can never
 * fire, and the complexity gate said so.
 */
function must(step: HistoryStep | null): HistoryStep {
  if (step === null) throw new Error("expected a step, but the history reported nowhere to go");
  return step;
}

/**
 * The browser model: two stacks, and a new visit throws the forward one away.
 *
 * The current path is NOT held in the history. It lives in the pane, and
 * passing it in at each step is what keeps one copy of it — a history that also
 * remembered where you are could disagree with the pane about it, and the two
 * would drift in exactly the situation nobody tests: a listing that failed and
 * sent the pane back on its own.
 */
describe("walking backward", () => {
  it("returns to where you came from", () => {
    const history = visit(emptyHistory(), "/home/jc");

    const step = must(stepBack(history, "/home/jc/projects"));

    expect(step.path).toBe("/home/jc");
  });

  it("keeps going back, one directory per step", () => {
    // The property criterion 6 is really about: two presses move two
    // directories, rather than oscillating between the last two.
    let history = visit(emptyHistory(), "/");
    history = visit(history, "/home");
    history = visit(history, "/home/jc");

    const first = must(stepBack(history, "/home/jc/projects"));
    expect(first.path).toBe("/home/jc");

    const second = must(stepBack(first.history, first.path));
    expect(second.path).toBe("/home");

    const third = must(stepBack(second.history, second.path));
    expect(third.path).toBe("/");
  });

  it("reports nowhere to go at the start of the trail", () => {
    expect(stepBack(emptyHistory(), "/home/jc")).toBeNull();
  });
});

describe("walking forward", () => {
  it("returns to the directory a step back left", () => {
    const history = visit(emptyHistory(), "/home/jc");
    const back = must(stepBack(history, "/home/jc/projects"));

    const forward = must(stepForward(back.history, back.path));

    expect(forward.path).toBe("/home/jc/projects");
  });

  it("reports nowhere to go at the end of the trail", () => {
    const history = visit(emptyHistory(), "/home/jc");
    expect(stepForward(history, "/home/jc/projects")).toBeNull();
  });

  it("walks the whole trail back and then forward again", () => {
    let history = visit(emptyHistory(), "/");
    history = visit(history, "/home");

    const backOnce = must(stepBack(history, "/home/jc"));
    const backTwice = must(stepBack(backOnce.history, backOnce.path));
    expect(backTwice.path).toBe("/");

    const forwardOnce = must(stepForward(backTwice.history, backTwice.path));
    expect(forwardOnce.path).toBe("/home");

    const forwardTwice = must(stepForward(forwardOnce.history, forwardOnce.path));
    expect(forwardTwice.path).toBe("/home/jc");
  });
});

describe("a new visit after stepping back", () => {
  it("throws the forward trail away", () => {
    // The branch you did not take is gone. Keeping it would make `=` go
    // somewhere you never chose, which is the one thing forward must not do.
    const history = visit(emptyHistory(), "/home/jc");
    const back = must(stepBack(history, "/home/jc/projects"));
    expect(stepForward(back.history, "/home/jc")).not.toBeNull();

    const elsewhere = visit(back.history, "/home/jc");

    expect(stepForward(elsewhere, "/tmp")).toBeNull();
  });
});

describe("the history is a value", () => {
  it("never mutates what it was given", () => {
    const original = visit(emptyHistory(), "/home/jc");
    const snapshot = JSON.stringify(original);

    visit(original, "/tmp");
    stepBack(original, "/home/jc/projects");

    expect(JSON.stringify(original)).toBe(snapshot);
  });
});
