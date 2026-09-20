import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";

import { containedRealPath } from "./appPath.ts";

/**
 * Paths the renderer has been given permission to load directly.
 *
 * ── Why a token rather than bytes over the bridge ───────────────────────────
 * An image and a document both need a URL the browser can load. Sending their
 * bytes across the process boundary and building a blob URL works for an image
 * and does NOT work for a document: Chromium's PDF viewer refuses a `blob:` URL
 * whose origin is a custom scheme, and the `<embed>` resolves to
 * `chrome-error://chromewebdata` — a failure invisible from the DOM and silent
 * at the console. Verification found it only in the frame tree.
 *
 * A token turns each file into an ordinary same-origin URL the viewer accepts,
 * and it also removes a copy of up to 64 megabytes per preview.
 *
 * ── What it does and does not protect ───────────────────────────────────────
 * It does NOT narrow what the renderer may read: the renderer may still ask for
 * any path, exactly as the byte-reading channel allowed. What it preserves is
 * the property phase 2 established — that the renderer cannot reach the disk
 * WITHOUT the main process handing it something. Every path served this way was
 * named in a request the main process answered, so policy has one place to live
 * if it is ever needed.
 *
 * ── The DIRECTORY grant is the exception, and it is deliberately stronger ───
 * `authorisePreviewDirectory` below names a root and refuses everything
 * outside it, once symbolic links are followed. It exists for the rendered
 * document previews: a markdown file references its images and an HTML file
 * references its stylesheet by RELATIVE path, and a file grant cannot serve
 * either — a relative reference resolves against the token URL and finds
 * nothing there. So the sentence above is true of the file grant and is not
 * true of this one; that is the whole difference between them.
 */

/**
 * How many paths stay loadable at once.
 *
 * Bounded because a resident application previews thousands of files in a
 * session, and an unbounded map would keep every one of them addressable for
 * the lifetime of the process. Generous enough that a token cannot expire while
 * the image it belongs to is still on screen.
 */
const MAX_TOKENS = 64;

const paths = new Map<string, string>();

/**
 * Directory roots, kept apart from the files above.
 *
 * Two maps rather than one with a flag, and the separation is the safety
 * property: a file token must never resolve as a directory root, or a grant
 * over one file would quietly become a grant over everything beside it. The
 * bound applies to each separately so neither can starve the other.
 */
const directories = new Map<string, string>();

/**
 * Put `value` in `into`, reusing an existing token and evicting the oldest.
 *
 * Shared by both kinds of grant. The reuse scan is what stops a component that
 * re-renders from leaking a token per render, and the eviction is what stops a
 * resident session keeping every path it ever previewed addressable.
 */
function grant(into: Map<string, string>, value: string): string {
  for (const [token, existing] of into) {
    if (existing === value) return token;
  }

  const token = randomUUID();
  into.set(token, value);

  // Oldest first: insertion order is the eviction order, and the oldest token
  // belongs to whatever the user looked at longest ago.
  while (into.size > MAX_TOKENS) {
    const oldest = into.keys().next().value;
    if (oldest === undefined) break;
    into.delete(oldest);
  }

  return token;
}

/** The URL path prefix these are served under. */
export const TOKEN_PREFIX = "/__preview/";

/**
 * Make a path loadable, and return the token that addresses it.
 *
 * Asking twice for the same path returns the same token, so a component that
 * re-renders does not leak a token per render.
 */
export function authorisePreview(path: string): string {
  return grant(paths, path);
}

/**
 * Make a directory's contents reachable, and return the token that roots them.
 *
 * For a rendered document's own neighbours, and nothing else. What comes back
 * addresses a ROOT rather than a file: the served URL is the token followed by
 * a relative path, and `resolvePreviewDirectoryPath` is the only way to turn
 * that pair into something on disk.
 */
export function authorisePreviewDirectory(directory: string): string {
  return grant(directories, directory);
}

/** The path a token addresses, or `null` for one that was never issued. */
export function resolveToken(token: string): string | null {
  return paths.get(token) ?? null;
}

/** The directory a token roots, or `null` for one that was never issued. */
export function resolveDirectoryToken(token: string): string | null {
  return directories.get(token) ?? null;
}

/**
 * The file a directory token and a relative path name, or `null`.
 *
 * **`containedRealPath` and not a check written here**, because it resolves
 * both sides to their real location before comparing — so a symbolic link
 * planted inside the granted directory and pointing out of it is refused,
 * which string arithmetic alone accepts. Read its header before touching this.
 * A second containment check is how the two come to disagree about a link.
 *
 * One `null` for every failure — an escape, a malformed percent-sequence, a
 * NUL byte, an absent file, or a DIRECTORY — so the caller has one status to
 * answer with instead of five. The directory case is not hypothetical: a
 * reference to `assets/` passes containment and stats fine, and handing that
 * to a read stream raises `EISDIR` asynchronously, AFTER the 200 and its
 * headers have already gone out. The client then sees a broken success rather
 * than the clean refusal every other bad input gets.
 *
 * ── A literal `..` never arrives here, and that is worth knowing ────────────
 * Measured against a real Electron: Chromium's own URL parser collapses an
 * unencoded `../` before the request leaves the process, so such a reference
 * lands on the ASSET route instead and is refused there by its own
 * containment check. What reaches this function is the PERCENT-ENCODED form,
 * `%2e%2e%2f`, which the parser leaves alone. So a test that feeds this
 * function a literal `"../x"` exercises the guard in isolation and says
 * nothing about live traffic — and anyone checking the traversal defence
 * through a browser must use the encoded form or they will be watching URL
 * normalisation and believing it is this.
 */
export async function resolvePreviewDirectoryPath(
  token: string,
  relative: string,
): Promise<string | null> {
  const root = resolveDirectoryToken(token);
  if (root === null) return null;

  // Stated rather than inherited: `resolveWithinRoot` turns an empty request
  // into `index.html`, which is right for serving the application's own assets
  // and wrong here. A document's neighbour always has a name.
  if (relative === "") return null;

  const file = await containedRealPath(root, relative);
  if (file === null) return null;

  // A regular file or nothing. See the `EISDIR` note above: a directory gets
  // past containment and past `stat`, and only fails once the bytes are being
  // read, by which time the status has been sent.
  return await stat(file)
    .then((stats) => (stats.isFile() ? file : null))
    .catch(() => null);
}

/** Drop every token. For tests, which must not inherit another test's grants. */
export function forgetPreviewTokens(): void {
  paths.clear();
  directories.clear();
}
