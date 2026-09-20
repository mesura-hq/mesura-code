import { realpath } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";

/**
 * Resolve a request path to a file inside `root`, or `null` when it escapes.
 *
 * Lives apart from `protocol.ts` deliberately: that module imports Electron at
 * load time, and these must stay testable in plain Node. The same reasoning
 * keeps `buildWindowOptions` free of a runtime Electron import.
 *
 * Returning `null` rather than throwing keeps the handler's failure path a
 * plain 403, and the containment check is what stops
 * `symmetria-fm://app/../../etc/passwd` from becoming the `file://` hole in a
 * new costume.
 *
 * **This is string math and it does not touch the disk**, which means it does
 * not follow symlinks. It is the first of two gates; `containedRealPath` below
 * is the second, and the handler must use that one.
 */
export function resolveWithinRoot(root: string, requestPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    // A malformed percent-sequence — a bare `%`, or invalid UTF-8 such as
    // `%E0%80%80` — makes `decodeURIComponent` throw a `URIError`. Thrown from
    // inside the async protocol handler that becomes an opaque network error
    // instead of the intended fail-closed reply, so it is caught here and
    // turned into the same rejection every other bad input gets.
    return null;
  }

  const relative = decoded.replace(/^\/+/, "");
  // A NUL byte terminates a path at the syscall boundary, so `a\0../../etc` can
  // pass a string check and open something else entirely.
  if (relative.includes("\0")) return null;

  // Test the raw value, not the normalised one: `normalize("")` returns `"."`,
  // which is truthy, so a `|| "index.html"` fallback placed after normalisation
  // never fires and a bare-root request resolves to the directory itself.
  const target = relative === "" ? "index.html" : normalize(relative);
  const candidate = resolve(join(root, target));
  return contains(resolve(root), candidate) ? candidate : null;
}

/** True when `candidate` is `bounded` itself or lies beneath it. */
function contains(bounded: string, candidate: string): boolean {
  return candidate === bounded || candidate.startsWith(bounded + sep);
}

/**
 * The gate the handler must use: containment that survives symlinks.
 *
 * `resolveWithinRoot` alone is not enough. It is pure string arithmetic, so a
 * symlink planted inside the served directory and pointing outside it passes
 * the prefix check, and the operating system then follows it when the file is
 * read — reopening exactly the hole the custom scheme was introduced to close.
 * Resolving both sides to their real paths is what closes it.
 *
 * Returns `null` for an escape, a malformed path, or a file that does not
 * exist, so the caller has one failure path instead of three.
 */
export async function containedRealPath(root: string, requestPath: string): Promise<string | null> {
  const candidate = resolveWithinRoot(root, requestPath);
  if (candidate === null) return null;

  try {
    const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
    return contains(realRoot, realCandidate) ? realCandidate : null;
  } catch {
    // `ENOENT` from either side, or a broken link. Absent is not an error here.
    return null;
  }
}
