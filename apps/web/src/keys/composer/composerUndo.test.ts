import { freshTestId } from "~/test/freshTestId";
import { describe, expect, it } from "vite-plus/test";

import { ComposerTextBuffer, recordComposerUndoState, undoComposerChange } from "./composerUndo";

describe("composer undo fence: bounded history", () => {
  // P2-1: the composer's history is the only one, and it is bounded.
  it("composer undo fence regression: the session buffer keeps no undo snapshots of its own", () => {
    const buffer = new ComposerTextBuffer("abc");
    for (let step = 0; step < 500; step += 1) {
      buffer.saveUndoPoint({ line: 0, col: 0 });
      buffer.insertAt(0, 0, "x");
    }
    expect(buffer.undo({ line: 0, col: 0 })).toBeNull();
  });

  it("composer undo fence regression: a draft's history keeps at most 200 states", () => {
    const draftKey = `composer-undo-bound-${freshTestId("composer-draft")}`;
    for (let step = 0; step <= 300; step += 1) recordComposerUndoState(draftKey, `${step}`, 0);
    let prompt = "300";
    let steps = 0;
    for (let next = undoComposerChange(draftKey, prompt, 0); next;) {
      prompt = next.prompt;
      steps += 1;
      next = undoComposerChange(draftKey, prompt, 0);
    }
    expect(steps).toBe(199);
    expect(prompt).toBe("101");
  });
});
