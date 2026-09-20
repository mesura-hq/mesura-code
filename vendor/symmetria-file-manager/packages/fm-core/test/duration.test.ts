import { describe, expect, it } from "vitest";

import { formatDuration, playedFraction } from "../src/preview/duration.ts";

/**
 * A length a person reads at a glance, and how far into one we are.
 *
 * In `packages/fm-core` rather than inside the audio pane: a formatter that
 * lives inside its one consumer is the shape that gets copied when a second
 * arrives rather than imported. The second consumer exists — the waveform reads
 * `playedFraction` from here — so the "only caller today" this header used to
 * claim is no longer true of either export.
 */

describe("formatDuration", () => {
  it("writes a short track as minutes and seconds", () => {
    expect(formatDuration(215)).toBe("3:35");
  });

  it("pads the seconds so the width does not jump", () => {
    // A pane whose duration is sometimes four characters and sometimes five
    // shifts everything beside it as the cursor moves.
    expect(formatDuration(65)).toBe("1:05");
  });

  it("does not pad the minutes", () => {
    // `3:35`, not `03:35`. The leading zero buys nothing and reads like a clock.
    expect(formatDuration(215).startsWith("3")).toBe(true);
  });

  it("shows zero as a real value rather than as nothing", () => {
    expect(formatDuration(0)).toBe("0:00");
  });

  it("drops the fraction rather than rounding up", () => {
    // A 9.9 second file that reads 0:10 has been rounded past its own end.
    expect(formatDuration(9.9)).toBe("0:09");
  });

  it("adds an hours field only once there are hours", () => {
    expect(formatDuration(3600)).toBe("1:00:00");
    expect(formatDuration(3599)).toBe("59:59");
  });

  it("pads the minutes once they follow an hours field", () => {
    // `1:05:00`, not `1:5:00`. The rule for minutes flips when they stop being
    // the leading field, which is the one place this is easy to get wrong.
    expect(formatDuration(3900)).toBe("1:05:00");
  });

  it("says nothing rather than guessing when the length is unknown", () => {
    // A media element reports `NaN` until it has metadata, and `Infinity` for a
    // stream. Neither is a duration, and "NaN:aN" on screen is worse than a
    // blank.
    expect(formatDuration(Number.NaN)).toBe("");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("");
    expect(formatDuration(-1)).toBe("");
  });
});

/**
 * The played fraction, which two things draw from.
 *
 * The audio pane's seek fill and the waveform canvas are six pixels apart and
 * both size themselves from this, so every guard below is the difference
 * between two drawings agreeing and two drawings contradicting each other.
 */
describe("playedFraction", () => {
  it("reports the ordinary case as a plain fraction", () => {
    expect(playedFraction(50, 100)).toBe(0.5);
    expect(playedFraction(43, 215)).toBe(0.2);
  });

  it("is zero at the start and one at the end", () => {
    expect(playedFraction(0, 100)).toBe(0);
    expect(playedFraction(100, 100)).toBe(1);
  });

  it("clamps a position past the end", () => {
    // The reason the expression was worth extracting. A media element reports a
    // `currentTime` a hair past its own `duration` at the very end of a file,
    // and an unclamped fraction sizes the fill past the width of its groove.
    expect(playedFraction(101, 100)).toBe(1);
    expect(playedFraction(1e6, 100)).toBe(1);
  });

  it("is zero while the length is unknown", () => {
    // `null` until the element reports metadata. Not an error and not a guess:
    // the control is disabled and the fill has nothing to span.
    expect(playedFraction(5, null)).toBe(0);
  });

  it("does not divide by a length of zero or less", () => {
    expect(playedFraction(5, 0)).toBe(0);
    expect(playedFraction(5, -1)).toBe(0);
  });

  it("refuses a position that is not a number", () => {
    // `useMediaProgress` filters a non-finite DURATION and deliberately does not
    // filter a position, so `NaN` reaches here. Unguarded it propagates: the
    // fill renders `width: NaN%`, which the browser drops silently, and the
    // waveform's `i < boundary` is false for every bar — so a file that is
    // playing draws as entirely unplayed.
    expect(playedFraction(Number.NaN, 100)).toBe(0);
    expect(playedFraction(Number.POSITIVE_INFINITY, 100)).toBe(0);
    expect(playedFraction(-1, 100)).toBe(0);
  });
});
