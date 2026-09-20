/**
 * HTTP byte ranges, as the preview scheme needs them.
 *
 * ── Why this exists at all ──────────────────────────────────────────────────
 * Every preview before video was a whole-file consumer: an image decodes from
 * the bytes it is given and Chromium's document viewer fetches the lot. A media
 * element is the first consumer that will not accept that. It asks for a range,
 * and before it asks for anything it wants to know how long the resource is and
 * whether it may seek at all.
 *
 * Measured on Electron 41 / Chromium 146 with a real 1 MB H.264 file: served by
 * `net.fetch` on a `file://` URL — which carries neither `content-length` nor
 * `accept-ranges` — the element raised `MEDIA_ELEMENT_ERROR: Format error`,
 * code 4. The identical file served with those two headers played, reaching
 * `readyState 4` at 1920×1080. **The failure looks exactly like a corrupt
 * file**, which is what makes it worth this comment: a valid video and a lying
 * `.mp4` produce the same error code and the same message.
 *
 * Pure and free of both Electron and Node, so the whole grammar below is
 * testable without a window and without a filesystem.
 */

/** A resolved, inclusive byte range. `end` is the last byte, not one past it. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

export type RangeRequest =
  /** No range asked for, or a form this server does not implement. Send it all. */
  | { readonly kind: "whole" }
  /** A single satisfiable range. Answer 206 with `content-range`. */
  | { readonly kind: "partial"; readonly range: ByteRange }
  /** Asked for bytes that are not there. Answer 416. */
  | { readonly kind: "unsatisfiable" };

/**
 * One `bytes=` range against a known size.
 *
 * Deliberately narrow. **A multi-range request answers `whole`, not an error**:
 * a client that asked for two ranges and is handed the entire resource has
 * received a correct, if unhelpful, answer, whereas a 416 would fail a request
 * that was never unsatisfiable. No media element this serves asks for more than
 * one range.
 *
 * A zero-length file is `unsatisfiable` for every range, because the only
 * offset a caller could name is one that does not exist.
 */
export function parseRange(header: string | null, size: number): RangeRequest {
  if (header === null) return { kind: "whole" };

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return { kind: "whole" };

  const [, rawStart, rawEnd] = match;
  // `bytes=-N` is the LAST n bytes, not "from the start to n". Reading it the
  // other way returns the wrong end of the file, and for a media container that
  // is the difference between finding the index and not.
  if (rawStart === "") {
    const suffix = rawEnd === "" ? 0 : Number(rawEnd);
    if (suffix <= 0 || size === 0) return { kind: "unsatisfiable" };
    return { kind: "partial", range: { start: Math.max(0, size - suffix), end: size - 1 } };
  }

  const start = Number(rawStart);
  if (start >= size) return { kind: "unsatisfiable" };

  // An end past the last byte is clamped rather than refused: `bytes=0-` is the
  // ordinary opening request of every media element, and it names no end at all.
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return { kind: "unsatisfiable" };

  return { kind: "partial", range: { start, end } };
}

/** The headers a whole-resource answer needs for a media element to accept it. */
export function wholeHeaders(size: number, contentType: string) {
  return {
    "content-type": contentType,
    "content-length": String(size),
    // Without this the element will not seek, and Chromium's pipeline treats a
    // resource it cannot seek in as one it cannot play.
    "accept-ranges": "bytes",
  };
}

/** The headers for a 206. */
export function partialHeaders(range: ByteRange, size: number, contentType: string) {
  return {
    "content-type": contentType,
    "content-length": String(range.end - range.start + 1),
    "accept-ranges": "bytes",
    "content-range": `bytes ${range.start}-${range.end}/${size}`,
  };
}

/** The headers for a 416, which must still say how long the resource really is. */
export function unsatisfiableHeaders(size: number) {
  return { "content-range": `bytes */${size}` };
}
