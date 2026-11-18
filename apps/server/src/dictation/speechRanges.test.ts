import { describe, expect, it } from "vite-plus/test";

import { boundRanges, speechRanges, speechSeconds } from "./speechRanges.ts";

const FRAME_SECONDS = 512 / 16_000;
/** `seconds` of frames at one probability. */
const frames = (seconds: number, probability: number) =>
  Array.from({ length: Math.round(seconds / FRAME_SECONDS) }, () => probability);

describe("speechRanges", () => {
  it("keeps speech with 450 ms before and after it, and drops the silence between", () => {
    const probs = [...frames(10, 0.02), ...frames(3, 0.9), ...frames(20, 0.05), ...frames(2, 0.8)];
    const ranges = speechRanges(probs);
    expect(ranges).toHaveLength(2);
    expect(ranges[0]!.startSeconds).toBeCloseTo(10 - 0.45, 1);
    // The tail is whole frames: 15 of 32 ms, 480 ms.
    expect(ranges[0]!.endSeconds).toBeCloseTo(13 + 0.48, 1);
    expect(ranges[1]!.startSeconds).toBeCloseTo(33 - 0.45, 1);
    expect(speechSeconds(ranges)).toBeLessThan(7);
  });

  it("finds nothing in a silent recording", () => {
    expect(speechRanges(frames(60, 0.1))).toEqual([]);
  });

  it("ignores a single voiced frame, which is noise, but keeps a syllable cut off at the end", () => {
    expect(speechRanges([...frames(5, 0), 0.9, ...frames(5, 0)])).toEqual([]);
    const probs = [...frames(5, 0), 0.9];
    const tail = speechRanges(probs);
    expect(tail).toHaveLength(1);
    expect(tail[0]!.endSeconds).toBeCloseTo(probs.length * FRAME_SECONDS, 5);
  });

  it("bridges a pause shorter than the 450 ms tail", () => {
    const probs = [...frames(2, 0.9), ...frames(0.3, 0.1), ...frames(2, 0.9)];
    expect(speechRanges(probs)).toHaveLength(1);
  });
});

describe("boundRanges", () => {
  it("joins across the shortest gaps until the limit holds", () => {
    const ranges = [
      { startSeconds: 0, endSeconds: 1 },
      { startSeconds: 1.5, endSeconds: 2 },
      { startSeconds: 10, endSeconds: 11 },
      { startSeconds: 11.2, endSeconds: 12 },
    ];
    expect(boundRanges(ranges, 2)).toEqual([
      { startSeconds: 0, endSeconds: 2 },
      { startSeconds: 10, endSeconds: 12 },
    ]);
    expect(boundRanges(ranges, 4)).toBe(ranges);
  });
});
