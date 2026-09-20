import { describe, expect, it } from "vitest";

import { resolveDocumentAsset } from "../src/components/preview/markdownAssets.ts";

/**
 * The first of the two gates a document's own reference passes.
 *
 * The main process checks containment again against the real path on disk and
 * is the authority. This one exists so a hostile document does not even
 * produce a request to refuse — a browser fetches an `src` before any content
 * policy is consulted, so by the time anything else could object, a remote
 * host has already learned that the user's cursor passed over the file.
 *
 * A pure function with a table, deliberately. Every entry below is a shape
 * somebody could write into a markdown file.
 */

const GRANT = "test-grant://dir/home/jc/docs";

/** Written as escapes, so no control character sits literally in this file. */
const NUL = "\u0000";
const DELETE = "\u007f";

describe("what a document may load", () => {
  it.each([
    ["a sibling", "flow.png", `${GRANT}/flow.png`],
    ["one in a subdirectory", "assets/flow.png", `${GRANT}/assets/flow.png`],
    ["one written with a leading ./", "./assets/flow.png", `${GRANT}/assets/flow.png`],
    ["one with redundant separators", "assets//flow.png", `${GRANT}/assets/flow.png`],
    ["a name needing encoding", "a b&c.png", `${GRANT}/a%20b%26c.png`],
  ])("resolves %s", (_why, reference, expected) => {
    expect(resolveDocumentAsset(reference, GRANT)).toBe(expected);
  });
});

describe("what it may not", () => {
  it.each([
    // Naming another origin, every way there is.
    ["an http url", "http://example.com/x.png"],
    ["an https url", "https://example.com/x.png"],
    ["an uppercase scheme", "HTTPS://example.com/x.png"],
    ["a data url", "data:image/png;base64,AAAA"],
    ["a javascript url", "javascript:alert(1)"],
    ["a file url", "file:///etc/passwd"],
    ["a protocol-relative address", "//example.com/x.png"],

    // Reaching outside the document's own directory.
    ["a parent climb", "../secret.png"],
    ["a deep climb", "../../../etc/shadow"],
    ["a climb in the middle", "assets/../../secret.png"],
    ["an absolute path", "/etc/passwd"],

    // A backslash is not a separator to the split, so these survive as ONE
    // segment and pass the `..` check. Inert on this platform; not on another.
    ["a windows-style climb", "..\\..\\etc\\passwd"],
    ["a UNC share", "\\\\host\\share\\x.png"],

    // Every check below the trim is anchored at the START of the string, so
    // anything sitting in front of the scheme would slip past all of them.
    ["a leading space before a url", " http://example.com/x.png"],
    ["a tab before a url", "\thttp://example.com/x.png"],
    ["a newline before a url", "\nhttp://example.com/x.png"],
    ["a NUL byte in the name", `flow${NUL}.png`],
    ["a delete character", `flow${DELETE}.png`],

    // Nothing to fetch.
    ["an empty reference", ""],
    ["whitespace alone", "   "],
    ["a fragment", "#section"],
    ["a query", "?v=2"],
    ["a bare dot", "."],

    // ── The forms the markdown pipeline actually delivers ─────────────────
    // Verification from outside found these getting through. A reference
    // written as `..\..\etc\hostname` ARRIVES here already percent-encoded
    // as `..%5C..%5Cetc%5Chostname`, so a check for a literal backslash tests
    // a string that no longer has one. These are the shapes the component is
    // really handed, and the reason every rule now runs on the decoded form.
    ["an encoded windows climb", "..%5C..%5Cetc%5Chostname"],
    ["an encoded UNC share", "%5Chost%5Cshare%5Cx.png"],
    ["an encoded parent climb", "%2e%2e%2fsecret.png"],
    ["an encoded absolute path", "%2Fetc%2Fpasswd"],
    ["an encoded scheme", "https%3A%2F%2Fexample.com%2Fx.png"],
    ["an encoded NUL byte", "flow%00.png"],
    // These two exercise `decodedOnce`'s catch path by calling this function
    // DIRECTLY. Verification traced that neither arrives here in that shape
    // through the markdown pipeline: a literal `%` is pre-encoded to `%25`
    // upstream, so `flow%.png` reaches the component as `flow%25.png` and
    // decodes cleanly to an ordinary filename. The guard is still worth having
    // — this function has callers other than one pipeline, and an embedding
    // host may hand it anything — but nobody should read it as proof that a
    // malformed reference in a markdown file is refused. It is not reachable
    // that way.
    ["a malformed percent-sequence", "flow%.png"],
    ["invalid UTF-8 in a percent-sequence", "%E0%80%80.png"],
  ])("refuses %s", (_why, reference) => {
    expect(resolveDocumentAsset(reference, GRANT)).toBeNull();
  });

  it("refuses everything before the grant has arrived", () => {
    // The prefix is null until the main process answers. Resolving against
    // nothing would make a same-origin request to the panel itself.
    expect(resolveDocumentAsset("flow.png", null)).toBeNull();
  });

  it("refuses a reference that is absent altogether", () => {
    expect(resolveDocumentAsset(undefined, GRANT)).toBeNull();
  });

  it("tests the same string the main process will resolve", () => {
    // AMENDED, and this is the invariant the whole module rests on. It used to
    // check the RAW reference and re-encode it, so `%2e%2e%2f` survived as a
    // literal name — safe by accident, because the other side would 404 it.
    // Now the decoding happens first, so both gates examine one value and this
    // is refused outright, with no request issued at all.
    //
    // The round trip is what makes them agree: each segment is encoded once
    // here and decoded once there, so the main process resolves exactly the
    // string that was tested above.
    expect(resolveDocumentAsset("assets%2Fflow.png", GRANT)).toBe(`${GRANT}/assets/flow.png`);
    expect(resolveDocumentAsset("a%20b.png", GRANT)).toBe(`${GRANT}/a%20b.png`);
  });
});
