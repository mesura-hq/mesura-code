/**
 * Samples reduced to the bars a pane can draw.
 *
 * The arithmetic half of the waveform, kept away from the browser half so it
 * can be checked against constructed arrays rather than against a decoder.
 * `packages/fm-core` compiles against NO environment — no DOM, no Node — and
 * `Float32Array` is an ES built-in, so it is available where an `AudioBuffer`
 * would not be.
 */

/**
 * The peak magnitude within each of `count` equal slices of `samples`.
 *
 * **Peak and not average, and this is the whole visual decision.** Music
 * averages close to zero over any window wide enough to be one bar, so a
 * waveform drawn from averages is a flat grey band with no shape in it. The
 * peak is what produces the outline a reader recognises as sound.
 *
 * **Magnitude, so a trough counts as much as a crest.** A signal swings both
 * ways around zero and the negative half is not the quiet half; reading raw
 * values would draw silence over a loud passage.
 *
 * Every sample is read exactly once. The bucket edges are computed from the
 * bucket INDEX rather than by stepping a stride, because a stride rounded per
 * step accumulates and leaves the tail of the file unread — which is precisely
 * where a fade-out lives.
 */
export function peakBuckets(samples: Float32Array, count: number): Float32Array {
  if (count <= 0 || samples.length === 0) return new Float32Array(0);

  const bars = new Float32Array(count);

  for (let bucket = 0; bucket < count; bucket++) {
    const start = Math.floor((bucket * samples.length) / count);
    const end = Math.floor(((bucket + 1) * samples.length) / count);

    let peak = 0;
    // `subarray` is a VIEW, not a copy, so this reads each sample once without
    // allocating per bucket. Iterating it also yields `number` rather than
    // `number | undefined`, which indexing would under `noUncheckedIndexedAccess`
    // — so the obvious loop needs a type assertion and this one does not.
    //
    // A bucket can be empty when there are more bars than samples — a very
    // short file in a wide pane. Its peak stays zero, which is a real reading
    // of "nothing here" rather than a gap in the array.
    for (const sample of samples.subarray(start, end)) {
      const magnitude = Math.abs(sample);
      if (magnitude > peak) peak = magnitude;
    }
    bars[bucket] = peak;
  }

  return bars;
}
