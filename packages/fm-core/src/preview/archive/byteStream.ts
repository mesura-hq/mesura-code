/**
 * A pull-based reader over a stream of chunks.
 *
 * Exists because a tar can only be walked, and walking means two operations
 * the raw iterable does not offer: read exactly 512 bytes, and **step over the
 * next N bytes without keeping them**. That second one is the whole point. A
 * 40 GB tarball has to cost a bounded amount of memory, so its file data is
 * discarded as it arrives rather than concatenated and sliced.
 *
 * ── The ceiling belongs HERE and not only in the caller ─────────────────────
 * `maxBytes` stops the stream pulling, which is the only place that can bound
 * it. A caller checking a budget between reads does not: one `skip` over a
 * member declaring forty gigabytes drains forty gigabytes before control comes
 * back. Review caught exactly that, and it defeated the whole point of having
 * a ceiling. Past the limit `take` answers `null` and `skip` answers `false`,
 * which every caller already treats as the end of the stream.
 *
 * The held buffer stays bounded by one block plus one chunk in ordinary use,
 * because nothing asks for more than a block at a time — but a `take` for a
 * declared metadata length is the exception, so callers bound that themselves.
 */

export interface ByteStream {
  /** Exactly `length` bytes, or `null` where the stream ended first. */
  take(length: number): Promise<Uint8Array | null>;
  /** Discard `length` bytes. `false` where the stream ended first. */
  skip(length: number): Promise<boolean>;
  /** How many bytes have been pulled from the source. The byte ceiling reads it. */
  pulled(): number;
  /** Stop pulling and release the source, so a stopped walk stops the work. */
  close(): Promise<void>;
}

export function byteStream(chunks: AsyncIterable<Uint8Array>, maxBytes: number): ByteStream {
  const iterator = chunks[Symbol.asyncIterator]();
  // Annotated, and not inferred from the initialiser. A chunk arriving from
  // the source is a `Uint8Array<ArrayBufferLike>` — its buffer could be shared —
  // while `new Uint8Array(0)` narrows to `ArrayBuffer`, so the `held = chunk`
  // in `skip` will not type-check against the narrower inference.
  let held: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let at = 0;
  let pulled = 0;
  let ended = false;

  /** The next chunk, or `null` once the source is spent or the ceiling is hit. */
  async function pull(): Promise<Uint8Array | null> {
    if (ended) return null;
    // Checked before the pull rather than after, so the ceiling bounds what is
    // read rather than merely reporting that it was exceeded.
    if (pulled >= maxBytes) return null;
    const next = await iterator.next();
    if (next.done === true) {
      ended = true;
      return null;
    }
    pulled += next.value.length;
    return next.value;
  }

  function available(): number {
    return held.length - at;
  }

  /** Hold at least `length` unread bytes, or report that the source ran out. */
  async function fill(length: number): Promise<boolean> {
    while (available() < length) {
      const chunk = await pull();
      if (chunk === null) return false;

      const rest = held.subarray(at);
      const merged = new Uint8Array(rest.length + chunk.length);
      merged.set(rest, 0);
      merged.set(chunk, rest.length);
      held = merged;
      at = 0;
    }
    return true;
  }

  return {
    pulled: () => pulled,

    async take(length: number): Promise<Uint8Array | null> {
      if (!(await fill(length))) return null;
      const out = held.subarray(at, at + length);
      at += length;
      return out;
    },

    async skip(length: number): Promise<boolean> {
      let left = length - Math.min(length, available());
      at += Math.min(length, available());

      while (left > 0) {
        const chunk = await pull();
        if (chunk === null) return false;
        if (chunk.length <= left) {
          left -= chunk.length;
          continue;
        }
        // The chunk overshoots. Keep the remainder as the new held buffer.
        held = chunk;
        at = left;
        left = 0;
      }
      return true;
    },

    async close(): Promise<void> {
      ended = true;
      // A generator that is abandoned mid-loop keeps its frame alive, and a
      // fetch body that is never cancelled keeps decompressing. Both stop here.
      await iterator.return?.(undefined);
    },
  };
}
