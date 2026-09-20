/**
 * The search reply, as it crosses the boundary.
 *
 * Acceptance criteria 6, 7 and 8. Every reply on this boundary is parsed rather
 * than trusted, and this one is no different: the rows arrive from a separate
 * process that itself talks to a native library, which is exactly the kind of
 * sender whose output should not be believed on sight.
 */
import { describe, expect, it } from "vitest";

import { decodeSearchDirectoryRequest, decodeSearchReply } from "../src/contract.ts";

const row = {
  relativePath: "src/format.ts",
  name: "format.ts",
  fullPath: "/home/jc/app/src/format.ts",
  isDir: false,
  score: 142,
  size: 4096,
  modifiedMs: 1_700_000_000_000,
  gitStatus: "modified",
  matchIndices: [4, 7, 9],
};

const reply = { rows: [row], matchedQuery: "fmt", truncated: false, cap: 200 };

describe("decodeSearchReply, on a well-formed reply", () => {
  it("returns the rows it was given", () => {
    const decoded = decodeSearchReply(reply);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.rows).toHaveLength(1);
    expect(decoded.value.rows[0]?.fullPath).toBe("/home/jc/app/src/format.ts");
  });

  it("carries the query the rows answer", () => {
    // Criterion 7. Without it the highlighter draws a reply for "fo" against a
    // query the user has already extended to "form".
    const decoded = decodeSearchReply(reply);
    expect(decoded.ok && decoded.value.matchedQuery).toBe("fmt");
  });

  it("carries the truncation flag and the cap", () => {
    // Criterion 8. The Qt finder says "200 results" whether there are 200 or
    // 20,000, which is the thing this replaces.
    const decoded = decodeSearchReply({ ...reply, truncated: true });
    expect(decoded.ok && decoded.value.truncated).toBe(true);
    expect(decoded.ok && decoded.value.cap).toBe(200);
  });
});

describe("decodeSearchReply, on a malformed reply", () => {
  it("fails rather than throwing when the reply is not an object", () => {
    // Criterion 6: a malformed reply is a FAILURE, not a crash. A throw here
    // reaches the renderer as an unhandled rejection and takes the overlay
    // with it.
    expect(decodeSearchReply(null).ok).toBe(false);
    expect(decodeSearchReply("rows").ok).toBe(false);
  });

  it("fails when rows is not an array", () => {
    expect(decodeSearchReply({ ...reply, rows: {} }).ok).toBe(false);
  });

  it("fails when the answered query is missing", () => {
    const { matchedQuery: _drop, ...without } = reply;
    expect(decodeSearchReply(without).ok).toBe(false);
  });

  it("drops one unreadable row rather than failing the whole list", () => {
    // The same judgement the frecent decoder makes: one bad entry should not
    // cost the user the other forty.
    const decoded = decodeSearchReply({ ...reply, rows: [row, { name: 7 }, row] });
    expect(decoded.ok).toBe(true);
    expect(decoded.ok && decoded.value.rows).toHaveLength(2);
  });

  it("drops a row whose absolute path is not absolute", () => {
    // A relative path here would be resolved against whatever the renderer
    // thinks its working directory is, which is not a decision this boundary
    // gets to leave open.
    // Paired with a good row in the SAME array, so a decoder that returned an
    // empty list for everything could not pass this.
    const decoded = decodeSearchReply({
      ...reply,
      rows: [{ ...row, fullPath: "src/format.ts" }, row],
    });
    expect(decoded.ok && decoded.value.rows).toHaveLength(1);
    expect(decoded.ok && decoded.value.rows[0]?.fullPath).toBe("/home/jc/app/src/format.ts");
  });

  it("drops a row whose score is not a finite number", () => {
    // `typeof NaN === "number"`, and a NaN score sorts unpredictably and
    // renders as nothing — the same trap the frecent decoder records.
    const decoded = decodeSearchReply({ ...reply, rows: [{ ...row, score: Number.NaN }, row] });
    expect(decoded.ok && decoded.value.rows).toHaveLength(1);
    expect(decoded.ok && decoded.value.rows[0]?.score).toBe(142);
  });

  it("keeps a good row alongside the ones it drops", () => {
    // Paired, so a decoder that dropped EVERY row could not pass the drop
    // assertions above for free.
    const decoded = decodeSearchReply({
      ...reply,
      rows: [{ ...row, score: Number.NaN }, row],
    });
    expect(decoded.ok && decoded.value.rows).toHaveLength(1);
  });
});

describe("decodeSearchDirectoryRequest", () => {
  it("accepts an absolute directory", () => {
    const decoded = decodeSearchDirectoryRequest({ directory: "/home/jc/app" });
    expect(decoded.ok && decoded.value.directory).toBe("/home/jc/app");
  });

  it("refuses a relative directory", () => {
    // The index root is the key the whole pool is keyed on, and the renderer
    // never learns a working directory — so a relative one can only be a
    // mistake or an attempt to reach somewhere it was not given.
    expect(decodeSearchDirectoryRequest({ directory: "app" }).ok).toBe(false);
  });

  it("refuses a directory containing a NUL byte", () => {
    // This string is handed to a forked process as an `argv` entry. A NUL
    // terminates it at the exec boundary, so a check that approves the whole
    // string can have the kernel act on a prefix of it.
    expect(decodeSearchDirectoryRequest({ directory: "/home/jc\0/etc" }).ok).toBe(false);
  });

  it("refuses a directory longer than a path can be", () => {
    expect(decodeSearchDirectoryRequest({ directory: `/${"a".repeat(4096)}` }).ok).toBe(false);
  });

  it("refuses a request that is not an object", () => {
    expect(decodeSearchDirectoryRequest(null).ok).toBe(false);
  });
});
