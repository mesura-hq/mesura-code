import { describe, expect, it } from "vite-plus/test";

import { occurrenceKeys } from "./occurrenceKeys";

describe("occurrenceKeys", () => {
  it("gives repeated strings distinct keys and keeps the first occurrence bare", () => {
    expect(occurrenceKeys(["a.ts", "b.ts", "a.ts", "a.ts"])).toEqual([
      "a.ts",
      "b.ts",
      "a.ts#1",
      "a.ts#2",
    ]);
  });

  it("returns the same occurrence keys for the same list, so rows keep their identity", () => {
    const list = ["Why.", "Why.", "Because."];
    expect(occurrenceKeys([...list])).toEqual(occurrenceKeys(list));
    expect(new Set(occurrenceKeys(list)).size).toBe(list.length);
  });
});
