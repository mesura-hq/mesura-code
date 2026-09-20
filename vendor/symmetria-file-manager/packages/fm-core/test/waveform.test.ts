import { describe, expect, it } from "vitest";

import { peakBuckets } from "../src/preview/waveform.ts";

/**
 * Samples reduced to the bars a pane can draw.
 *
 * Pure arithmetic, so every case here is a constructed array rather than a
 * decoded file: `packages/fm-core` compiles against no environment at all and
 * has no audio context to decode with. What the browser does with real bytes is
 * the worker's problem and the verifier's.
 */

/** A signal that is the same everywhere. */
function constant(value: number, length: number): Float32Array {
  return Float32Array.from({ length }, () => value);
}

describe("reducing samples to bars", () => {
  it("returns exactly the number of bars asked for", () => {
    expect(peakBuckets(constant(0.5, 1000), 40)).toHaveLength(40);
  });

  it("reports the peak of each bucket, not its average", () => {
    // A waveform drawn from averages is a flat grey band: music averages close
    // to zero over any window long enough to be a bar. The peak is what gives
    // the shape a reader recognises.
    const samples = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 0]);

    const [first, second] = peakBuckets(samples, 2);

    expect(first).toBe(1);
    expect(second).toBe(0);
  });

  it("takes the magnitude, so a trough counts as much as a crest", () => {
    // Audio swings both ways around zero and the negative half is not quieter.
    // Reading the raw value would draw silence for a waveform that is loud.
    const samples = Float32Array.from([-0.8, -0.2, 0.1, 0.05]);

    expect(peakBuckets(samples, 2)[0]).toBeCloseTo(0.8);
  });

  it("draws silence as silence rather than as nothing", () => {
    const bars = peakBuckets(constant(0, 100), 10);

    expect(bars).toHaveLength(10);
    expect([...bars].every((bar) => bar === 0)).toBe(true);
  });

  it("covers every sample when the count does not divide evenly", () => {
    // 10 samples into 3 buckets. The last bucket must reach the end: a naive
    // `floor(i * size)` stride leaves the tail unread, and a file's last
    // moments are exactly where a fade-out lives.
    const samples = Float32Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);

    const bars = peakBuckets(samples, 3);

    expect(bars).toHaveLength(3);
    expect(bars[2]).toBe(1);
  });

  it("asks for more bars than there are samples without inventing any", () => {
    // A very short file in a wide pane. Every bar must still be a real
    // measurement or empty; none may be undefined.
    const bars = peakBuckets(Float32Array.from([1, 0.5]), 8);

    expect(bars).toHaveLength(8);
    expect([...bars].every((bar) => Number.isFinite(bar))).toBe(true);
  });

  it("reports a peak above full scale rather than normalising it away", () => {
    // Decoded PCM carries inter-sample peaks above 1.0 on a hotly mastered
    // track. This function reports what it FINDS; clamping is the drawing's
    // job, and review caught the drawing not doing it — an unclamped bar was
    // painted past the canvas's top edge, where the canvas hid it silently.
    // Pinned here so the two halves cannot both stop clamping.
    expect(peakBuckets(Float32Array.from([1.4, 0.2]), 1)[0]).toBeCloseTo(1.4);
  });

  it("returns nothing for no samples", () => {
    expect(peakBuckets(new Float32Array(0), 10)).toHaveLength(0);
  });

  it("returns nothing when asked for no bars", () => {
    expect(peakBuckets(constant(1, 100), 0)).toHaveLength(0);
  });
});
