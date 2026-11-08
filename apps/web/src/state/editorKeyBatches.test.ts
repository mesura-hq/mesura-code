import { describe, expect, it } from "vite-plus/test";

import { batchLength, EDITOR_INPUT_KEYS_LIMIT, splitKeysToLimit } from "./editorKeyBatches.ts";

describe("editor key batches", () => {
  it("splits composed text longer than the keys bound in order, never inside a key", () => {
    // Composed text as the driver sends it: every literal `<` escaped as
    // `<lt>`, plus characters outside the basic plane. 3,000 characters.
    const composed = "a<lt>ñ😀b".repeat(300);
    const pieces = splitKeysToLimit(composed);

    expect(pieces.join("")).toBe(composed);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(EDITOR_INPUT_KEYS_LIMIT);
      // Each piece starts and ends on a whole key: no torn `<lt>`, no half
      // of a surrogate pair.
      expect(piece).toMatch(/^(?:<lt>|a|ñ|😀|b)+$/u);
    }
  });

  it("keeps a key string within the bound whole", () => {
    expect(splitKeysToLimit("<C-w>v")).toEqual(["<C-w>v"]);
  });

  it("takes keys from the front of the queue up to the bound, and at least one", () => {
    const units = ["x".repeat(600), "y".repeat(400), "z".repeat(100)];
    expect(batchLength(units)).toBe(2);
    expect(batchLength(units.slice(2))).toBe(1);
    expect(batchLength([])).toBe(0);
  });
});
