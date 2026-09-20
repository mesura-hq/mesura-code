/**
 * Turning a previewed file into samples.
 *
 * ── This runs on the interface thread, and that is not a compromise ─────────
 * The plan for this work said to decode inside a worker, because
 * `OfflineAudioContext` "works in a worker and needs no output device". Half of
 * that is true. Verification found the other half is not, and a direct probe on
 * Electron 41 / Chromium 146 confirmed it:
 *
 *     main thread   OfflineAudioContext: function   AudioContext: function
 *     worker        OfflineAudioContext: undefined  AudioContext: undefined
 *                   AudioDecoder: undefined         (no WebCodecs either)
 *
 * There is no audio decoder of any kind inside a dedicated worker here. The
 * worker's `decodeAudioData` therefore threw a `ReferenceError` for every file,
 * which the catch turned into "undecodable" — so every waveform silently failed
 * and looked exactly like a file that simply has no shape to draw.
 *
 * ── Why running it here costs nothing measurable ────────────────────────────
 * `decodeAudioData` is native and asynchronous: Chromium does the work off the
 * interface thread and resolves a promise. Measured on a real 283-second Opus
 * recording — 12.5 million samples — the decode took 407 ms while a 10 ms timer
 * on this thread never missed by more than 0.5 ms. The thread was free
 * throughout.
 *
 * What DOES block is the arithmetic afterwards, which is why that half still
 * goes to a worker. See `Waveform.tsx`.
 */

/**
 * The largest COMPRESSED file this will read.
 *
 * A cheap first gate. It bounds the download and the buffer held while
 * decoding, and it is the only gate that applies when nothing is known about
 * the file's length yet.
 */
export const MAX_DECODE_BYTES = 24 * 1024 * 1024;

/**
 * The largest DECODED size this will produce.
 *
 * **The compressed cap alone is the wrong thing to bound, and review caught
 * it.** Decoding expands audio to 32-bit floats, and the expansion depends
 * entirely on the codec: measured on this operator's own files, a 650 kB Opus
 * recording became 12.5 million samples — 50 MB, an expansion of 77 times. At
 * that ratio a file that just squeaks under the compressed cap would decode to
 * roughly 1.8 GB, which is precisely the outcome the cap exists to prevent.
 *
 * So the real bound is on the result, estimated before any decoding happens
 * from the length the media element already reports. At the assumed rate below,
 * 256 MB of samples is a little over twenty-three minutes of mono audio — well
 * past what a preview pane has anything to say about.
 */
const MAX_DECODED_BYTES = 256 * 1024 * 1024;

/** Bytes per sample of the decoded signal. `Float32Array`, one channel. */
const BYTES_PER_SAMPLE = 4;

/**
 * The sample rate this ESTIMATE assumes, which is not the same as a bound.
 *
 * 48 kHz is what the overwhelming majority of files this meets are recorded at.
 * A 96 kHz file would use twice the budget — 512 MB rather than 256 — and that
 * is accepted rather than guarded against, for two reasons: assuming the higher
 * rate would halve the allowed length for every ordinary file to buy safety
 * against a rare one, and the compressed cap above still applies to both.
 *
 * Stating it as an estimate matters. An earlier version of this comment claimed
 * twenty-two minutes while the constant said 96 kHz, which allows under twelve — the
 * numbers and the prose disagreed and only the prose was read.
 */
const ASSUMED_SAMPLE_RATE = 48_000;

/**
 * Would this file's decoded samples fit in the budget?
 *
 * `null` seconds means the length is not known yet — the media element has not
 * reported it — and the answer is then `true`, because the compressed cap is
 * still in force and refusing every file until metadata arrives would refuse
 * most of them forever.
 */
export function fitsDecodedBudget(seconds: number | null): boolean {
  if (seconds === null || !Number.isFinite(seconds)) return true;
  return seconds * ASSUMED_SAMPLE_RATE * BYTES_PER_SAMPLE <= MAX_DECODED_BYTES;
}

export type DecodedAudio =
  | { readonly kind: "samples"; readonly samples: Float32Array }
  /**
   * Refused before decoding, and the refusal is mandatory rather than cautious.
   * Decoding expands compressed audio to 32-bit floats — the 650 kB recording
   * above became 50 MB of them — so an hour of stereo is well over a gigabyte
   * held at once. The operator's own Downloads folder has a 144 MB recording.
   */
  | { readonly kind: "too-large" }
  /**
   * Nothing to draw, for any of three reasons that look the same from outside:
   * no decoder for these bytes, bytes that are not sound at all, or a fetch
   * that failed. The pane does the same thing for all three.
   */
  | { readonly kind: "undecodable" };

/**
 * A scratch context, only ever used to decode.
 *
 * Its own rate and length are irrelevant: `decodeAudioData` returns a buffer at
 * the FILE's rate regardless. One is reused because constructing one per file
 * is measurable and buys nothing.
 */
let context: OfflineAudioContext | null = null;

function decoder(): OfflineAudioContext | null {
  if (typeof OfflineAudioContext === "undefined") return null;
  context ??= new OfflineAudioContext(1, 1, 44100);
  return context;
}

/** Drop the shared context. For tests, which must not inherit another's. */
export function forgetAudioDecoder(): void {
  context = null;
}

/**
 * Fetch a previewed file and decode its first channel.
 *
 * Channel zero alone: mixing every channel doubles the work for a difference
 * nobody can see at the width of a preview pane.
 */
export async function decodeAudio(
  url: string,
  seconds: number | null,
  signal: AbortSignal,
): Promise<DecodedAudio> {
  if (!fitsDecodedBudget(seconds)) return { kind: "too-large" };

  try {
    // Inside the `try`, because constructing a context can itself throw and
    // this function's whole contract is that it never rejects — its only caller
    // treats a rejection as an unhandled one.
    const available = decoder();
    if (available === null) return { kind: "undecodable" };

    const response = await fetch(url, { signal });
    if (!response.ok) return { kind: "undecodable" };

    // Refuse BEFORE reading the body where the length is declared. The preview
    // scheme always declares it — see `app/src/main/fileRange.ts` — so a 144 MB
    // recording is never pulled into memory only to be discarded.
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_DECODE_BYTES) {
      await response.body?.cancel();
      return { kind: "too-large" };
    }

    const bytes = await response.arrayBuffer();
    // And again from the buffer's own length, because the header is advisory
    // and this number is what the decode will actually cost.
    if (bytes.byteLength > MAX_DECODE_BYTES) return { kind: "too-large" };

    const audio = await available.decodeAudioData(bytes);
    return { kind: "samples", samples: audio.getChannelData(0) };
  } catch {
    // `decodeAudioData` rejects for a format with no decoder and for bytes that
    // are not sound; `fetch` rejects when the request is aborted or the network
    // fails. All of them are the same answer to a preview pane.
    return { kind: "undecodable" };
  }
}
