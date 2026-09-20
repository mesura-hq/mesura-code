/**
 * Which of a document's own references may be loaded, and as what URL.
 *
 * A previewed markdown file is somebody else's data, and every reference in it
 * is an instruction to fetch something. This module is the whole of what the
 * panel is willing to fetch: a path that stays inside the document's own
 * directory, and nothing else.
 *
 * **Refusing to write a `src` is the only reliable refusal.** A browser fetches
 * an `src` before any content policy is consulted, so an `<img>` pointing at a
 * remote host has already announced the user's cursor position to that host by
 * the time anything else could object. That is why a refused reference renders
 * as text rather than as an image with a blocked source.
 *
 * The main process checks containment again, against the real path on disk,
 * and it is the authority. This is the first of the two gates and exists so a
 * hostile document does not even produce a request to refuse.
 */

/** Anything of the form `scheme:`, which is every way to name another origin. */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Does the reference contain a control character anywhere?
 *
 * Refused outright rather than stripped. The checks further down are anchored
 * at the start of the string, so a control character in front of `http://…`
 * would slip past every one of them and the reference would then be treated as
 * a relative path. Nothing legitimate contains one.
 *
 * Written as a code-point test rather than a regular expression on purpose:
 * `noControlCharactersInRegex` fails the build for a control character in a
 * pattern, and the rule is right in general — it is wrong only here, where
 * FINDING them is the whole job. Testing the code points needs no suppression
 * and says what it means.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The reference as the OTHER SIDE will read it, or `null` if it will not decode.
 *
 * ── Decoding first is the whole correctness argument of this module ─────────
 * Verification caught this from outside, and the finding is worth stating in
 * full because it looks like a detail and is not. The markdown pipeline
 * percent-encodes a URL before the image component ever sees it, so a
 * reference written in the file as `..\..\etc\hostname` ARRIVES here as the
 * literal characters `..%5C..%5Cetc%5Chostname`. A check for a backslash then
 * tests a string that no longer contains one, finds nothing, and the reference
 * loads.
 *
 * The general defect was worse than the backslash: this function was checking
 * a DIFFERENT STRING from the one the main process would go on to resolve.
 * `resolveWithinRoot` decodes once on the other side, so a guard that runs
 * before decoding is guarding the wrong value, and every rule below inherits
 * that mistake.
 *
 * So: decode exactly once, test the decoded form, and re-encode each segment.
 * The main process decodes once and gets back precisely what was tested here,
 * which is the invariant that makes two gates agree instead of merely both
 * existing.
 */
function decodedOnce(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    // A malformed percent-sequence — a bare `%`, or invalid UTF-8 such as
    // `%E0%80%80`. The main process refuses these too; refusing here means no
    // request is issued for one at all.
    return null;
  }
}

/**
 * The URL for a reference inside `prefix`, or `null` where it may not load.
 *
 * `null` for: a reference naming any scheme, a protocol-relative `//host/…`,
 * an absolute path, an empty reference, one that climbs out with `..`, one
 * carrying a backslash or a control character, one that will not decode, and
 * any reference at all before the directory grant has arrived.
 */
export function resolveDocumentAsset(
  raw: string | undefined,
  prefix: string | null,
): string | null {
  if (prefix === null || raw === undefined) return null;

  // Before every check below. See `decodedOnce`.
  const decoded = decodedOnce(raw);
  if (decoded === null) return null;
  if (hasControlCharacter(decoded)) return null;

  // Trimmed BEFORE the anchored checks below, not after. Every one of them
  // tests the start of the string, so ` http://evil.example/x.png` would
  // otherwise pass all three and be treated as a relative path.
  const reference = decoded.trim();
  if (reference === "") return null;

  // A fragment or a query with no path names this document, not a file.
  if (reference.startsWith("#") || reference.startsWith("?")) return null;
  if (HAS_SCHEME.test(reference)) return null;
  // `//host/path` inherits the current scheme and is therefore remote.
  if (reference.startsWith("//")) return null;
  if (reference.startsWith("/")) return null;
  // A backslash is not a separator to the split below, so `..\..\etc\passwd`
  // survives as ONE segment and passes the `..` check. It is inert on this
  // platform and would not be on another, and this module is documented as the
  // whole of what the panel is willing to fetch — so it is refused here rather
  // than left to the second gate to interpret.
  if (reference.includes("\\")) return null;

  const segments = reference.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) return null;
  // Checked here as well as in the main process, and now on the DECODED form,
  // so `%2e%2e%2f` is caught as the climb it is rather than passed along as a
  // literal name. A `..` this side lets through is a request the user's
  // machine still made, even when the other side answers 404.
  if (segments.includes("..")) return null;

  return `${prefix}/${segments.map(encodeURIComponent).join("/")}`;
}
