import { peakBuckets } from "@symmetria/fm-core/preview/waveform";

/**
 * Samples reduced to bars, off the interface thread.
 *
 * ── It does NOT decode, and that is not where this started ──────────────────
 * The plan had this worker fetch and decode as well. It cannot: there is no
 * `OfflineAudioContext`, no `AudioContext` and no `AudioDecoder` inside a
 * dedicated worker in this Chromium — measured, not assumed. The decode is done
 * by the caller, on the interface thread, where it is native, asynchronous and
 * measurably non-blocking. See `decodeAudio.ts`.
 *
 * ── What is left here is the part that genuinely blocks ─────────────────────
 * Measured on a 283-second recording: the decode never stalled the thread by
 * more than half a millisecond, while the loop over its 12.5 million samples
 * took 21.5 ms — more than a frame, on every audio file the cursor rests on,
 * and growing with file length. That loop is what this worker exists for.
 *
 * The samples arrive TRANSFERRED rather than copied. Copying them was measured
 * at 17 ms, which would have given back almost everything the worker saves.
 */

export interface WaveformRequest {
  readonly id: number;
  /** The decoded first channel. Transferred, so the sender loses its view. */
  readonly samples: Float32Array;
  /** How many bars the pane can draw. */
  readonly bars: number;
}

export interface WaveformResponse {
  readonly id: number;
  readonly bars: Float32Array;
}

self.addEventListener("message", (event: MessageEvent<WaveformRequest>) => {
  const request = event.data;
  const bars = peakBuckets(request.samples, request.bars);
  const answer: WaveformResponse = { id: request.id, bars };

  // Transfer back too. The options form is used for the reason
  // `tags.worker.ts` records: this file is typed against the DOM lib, where the
  // positional three-argument `postMessage` belongs to `Window`.
  self.postMessage(answer, { transfer: [answer.bars.buffer] });
});
