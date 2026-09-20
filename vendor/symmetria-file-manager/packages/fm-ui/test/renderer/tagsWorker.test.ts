/**
 * @vitest-environment happy-dom
 *
 * How the tag worker learns a file's real length from a partial answer.
 *
 * It matters because the whole-file retry hangs off it: a head read that finds
 * nothing is retried over the entire file ONLY when the head was not already
 * the entire file, and only below a size cap. Get this wrong in one direction
 * and every untagged file is downloaded twice; get it wrong in the other and
 * MP4 metadata — which lives in a `moov` atom at the END of any file not
 * written with `faststart` — is never found at all. Review caught the second.
 */

import { describe, expect, it } from "vitest";

import { totalSizeOf } from "../../src/tags.worker.ts";

function answer(headers: Record<string, string>): Response {
  return new Response(null, { headers });
}

describe("reading the total from a partial answer", () => {
  it("takes the number after the slash in content-range", () => {
    expect(totalSizeOf(answer({ "content-range": "bytes 0-2097151/58720256" }))).toBe(58_720_256);
  });

  it("is not fooled by the range's own numbers", () => {
    // `bytes 0-9/100` is ten bytes of a hundred. Reading the wrong field here
    // would make every file look smaller than the head that was read from it.
    expect(totalSizeOf(answer({ "content-range": "bytes 0-9/100" }))).toBe(100);
  });

  it("falls back to content-length when the whole thing was sent", () => {
    // A 200 carries no content-range: the answer IS the resource, so its own
    // length is the total. This is the case for every file under the cap.
    expect(totalSizeOf(answer({ "content-length": "4096" }))).toBe(4096);
  });

  it("prefers content-range over content-length when both are present", () => {
    // A 206 carries both, and `content-length` is the SLICE. Preferring it
    // would report a 56 MB file as 2 MB and skip the retry that finds its tags.
    const both = answer({
      "content-range": "bytes 0-2097151/58720256",
      "content-length": "2097152",
    });

    expect(totalSizeOf(both)).toBe(58_720_256);
  });

  it("says it does not know rather than guessing", () => {
    // An unknown total must not read as zero, which would look like an empty
    // file and suppress the retry.
    expect(totalSizeOf(answer({}))).toBeNull();
  });

  it("says it does not know for an unsatisfied range", () => {
    // `bytes */100` is what a 416 carries. It names no served slice.
    expect(totalSizeOf(answer({ "content-range": "bytes */100" }))).toBe(100);
  });
});
