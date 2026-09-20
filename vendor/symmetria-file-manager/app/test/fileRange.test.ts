import { describe, expect, it } from "vitest";

import {
  parseRange,
  partialHeaders,
  unsatisfiableHeaders,
  wholeHeaders,
} from "../src/main/fileRange.ts";

/**
 * The byte-range grammar the preview scheme answers.
 *
 * Written after verification found that a real, valid H.264 file would not play
 * in the running application: `net.fetch` on a `file://` URL carries neither
 * `content-length` nor `accept-ranges`, and Chromium's media pipeline rejects
 * such a resource with `MEDIA_ELEMENT_ERROR: Format error` — the same code and
 * the same message a genuinely corrupt file produces. No unit test could have
 * seen it, because the mocked bridge never serves a byte and happy-dom has no
 * decoder.
 */

const SIZE = 1000;

describe("what a client asked for", () => {
  it("treats no range header as a request for everything", () => {
    expect(parseRange(null, SIZE)).toEqual({ kind: "whole" });
  });

  it("reads the opening request every media element makes", () => {
    // `bytes=0-` names no end. It is the first thing Chromium sends, and
    // refusing it refuses playback entirely.
    expect(parseRange("bytes=0-", SIZE)).toEqual({
      kind: "partial",
      range: { start: 0, end: 999 },
    });
  });

  it("reads an explicit closed range", () => {
    expect(parseRange("bytes=100-199", SIZE)).toEqual({
      kind: "partial",
      range: { start: 100, end: 199 },
    });
  });

  it("reads a suffix range as the LAST bytes, not the first", () => {
    // `bytes=-500` means the final 500 bytes. Reading it as "up to 500" returns
    // the wrong end of the file, and for a media container that is the
    // difference between finding the index and not finding it.
    expect(parseRange("bytes=-500", SIZE)).toEqual({
      kind: "partial",
      range: { start: 500, end: 999 },
    });
  });

  it("clamps an end that runs past the last byte rather than refusing it", () => {
    expect(parseRange("bytes=900-99999", SIZE)).toEqual({
      kind: "partial",
      range: { start: 900, end: 999 },
    });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseRange("  bytes=0-9  ", SIZE)).toEqual({
      kind: "partial",
      range: { start: 0, end: 9 },
    });
  });
});

describe("what it refuses and what it merely does not implement", () => {
  it("calls a start past the end unsatisfiable", () => {
    expect(parseRange("bytes=1000-", SIZE)).toEqual({ kind: "unsatisfiable" });
  });

  it("calls a backwards range unsatisfiable", () => {
    expect(parseRange("bytes=500-100", SIZE)).toEqual({ kind: "unsatisfiable" });
  });

  it("calls any range on an empty file unsatisfiable", () => {
    expect(parseRange("bytes=0-", 0)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=-10", 0)).toEqual({ kind: "unsatisfiable" });
  });

  it("calls a zero-length suffix unsatisfiable", () => {
    expect(parseRange("bytes=-0", SIZE)).toEqual({ kind: "unsatisfiable" });
  });

  it("sends the whole resource for a multi-range request rather than failing it", () => {
    // A client handed everything it asked for and more has a correct answer; a
    // 416 would fail a request that was never unsatisfiable. Nothing this
    // serves asks for two ranges.
    expect(parseRange("bytes=0-99,200-299", SIZE)).toEqual({ kind: "whole" });
  });

  it("sends the whole resource for a unit it does not speak", () => {
    expect(parseRange("items=0-9", SIZE)).toEqual({ kind: "whole" });
    expect(parseRange("nonsense", SIZE)).toEqual({ kind: "whole" });
  });
});

describe("the headers each answer carries", () => {
  it("declares length and seekability on a whole-resource answer", () => {
    // These two are the entire defect. Without them a valid video reports a
    // format error, so they are asserted by name rather than by shape.
    expect(wholeHeaders(SIZE, "video/mp4")).toEqual({
      "content-type": "video/mp4",
      "content-length": "1000",
      "accept-ranges": "bytes",
    });
  });

  it("declares the served slice and the true total on a partial answer", () => {
    expect(partialHeaders({ start: 100, end: 199 }, SIZE, "video/mp4")).toEqual({
      "content-type": "video/mp4",
      "content-length": "100",
      "accept-ranges": "bytes",
      "content-range": "bytes 100-199/1000",
    });
  });

  it("still states the real length when refusing", () => {
    // A 416 that does not say how long the resource is leaves the client with
    // no way to ask a satisfiable question next.
    expect(unsatisfiableHeaders(SIZE)).toEqual({ "content-range": "bytes */1000" });
  });

  it("counts an inclusive range's length correctly at its smallest", () => {
    // One byte is length one. The off-by-one here would truncate every
    // response by a byte, which a decoder notices and a reader does not.
    expect(partialHeaders({ start: 0, end: 0 }, SIZE, "text/plain")["content-length"]).toBe("1");
  });
});
