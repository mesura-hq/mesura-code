import { describe, expect, it } from "vite-plus/test";

import { locateChange } from "./composerEdits";

const at = (start: number, cursorAfter = start, linewise = false) => ({
  start,
  cursorAfter,
  linewise,
});

describe("locateChange", () => {
  it("deletes the line the operation was on when two lines read the same", () => {
    expect(locateChange("same\nsame", "same", at(0, 0, true))).toEqual({
      from: 0,
      to: 5,
      inserted: "",
    });
    expect(locateChange("same\nsame", "same", at(5, 0, true))).toEqual({
      from: 4,
      to: 9,
      inserted: "",
    });
  });

  it("deletes the character under the cursor in a run of equal characters", () => {
    expect(locateChange("aa", "a", at(0))).toEqual({ from: 0, to: 1, inserted: "" });
    expect(locateChange("aa", "a", at(1))).toEqual({ from: 1, to: 2, inserted: "" });
  });

  it("inserts a paste where the cursor ends, on its last character", () => {
    expect(locateChange("ab", "aab", at(0, 1))).toEqual({ from: 1, to: 1, inserted: "a" });
    expect(locateChange("ab", "aab", at(0, 0))).toEqual({ from: 0, to: 0, inserted: "a" });
  });

  it("keeps a replacement as the one differing span", () => {
    expect(locateChange("Read alpha", "NEW alpha", at(0))).toEqual({
      from: 0,
      to: 4,
      inserted: "NEW",
    });
  });
});
