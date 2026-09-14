/**
 * The finder's four calls into the privileged half.
 *
 * They live here rather than in the panel's own bridge because the finder is
 * the only caller and because a host must be able to mount the finder without
 * taking the panel with it. A host that does so has to expose the same global
 * with the same four methods — that is the whole of the contract, and it is
 * what "a host runs the privileged half itself" means in practice.
 *
 * **`getBridge` is a second copy, and it has to be.** The panel has one too.
 * The natural home for it is `@symmetria/fm-core`, beside `BRIDGE_KEY` and the
 * `Bridge` type — but that package compiles against NO environment at all, by
 * design, so it cannot so much as name `window`. The duplicated part is a
 * property read; the part worth not duplicating is the decoding below it, and
 * that exists once.
 */
import { BRIDGE_KEY, type Bridge } from "@symmetria/fm-core/bridge";
import {
  decodeSearchReply,
  failure,
  isFailure,
  type Result,
  type SearchReply,
  success,
} from "@symmetria/fm-core/contract";

declare global {
  interface Window {
    readonly [BRIDGE_KEY]?: Bridge;
  }
}

/** Said once, so four failures cannot describe the same fault four ways. */
const MISSING_BRIDGE = "The preload bridge is unavailable.";

function getBridge(): Bridge | null {
  return window[BRIDGE_KEY] ?? null;
}

/**
 * Open an index over a directory, and wait for its first scan.
 *
 * Separate from `searchIn` because an index has a lifetime: the first call pays
 * for a full scan, and folding that into the first keystroke would make the
 * overlay feel broken on a large tree with no way to say why.
 */
export async function startSearchIndex(directory: string): Promise<Result<null>> {
  const bridge = getBridge();
  if (bridge === null) return failure("read_failed", MISSING_BRIDGE);
  const reply = await bridge.searchStart({ directory });
  return isFailure(reply) ? reply : success(null);
}

/**
 * Search an open index.
 *
 * The reply names the query it answered, so a caller can drop a reply the user
 * has already typed past rather than drawing it against newer input.
 */
export async function searchIn(directory: string, query: string): Promise<Result<SearchReply>> {
  const bridge = getBridge();
  if (bridge === null) return failure("read_failed", MISSING_BRIDGE);
  const reply = await bridge.searchQuery({ directory, query });
  return isFailure(reply) ? reply : decodeSearchReply(reply.value);
}

/**
 * Attribute a chosen file to the query that found it.
 *
 * Deliberately returns nothing. Nothing the user does next depends on it, and
 * awaiting it would put a statistic on the path between pressing Enter and the
 * file opening.
 */
export function recordSearchOpen(directory: string, query: string, chosenPath: string): void {
  void getBridge()?.searchRecord({ directory, query, chosenPath });
}

/** Release an index now rather than waiting for it to go idle. */
export async function releaseSearchIndex(directory: string): Promise<Result<null>> {
  const bridge = getBridge();
  if (bridge === null) return failure("read_failed", MISSING_BRIDGE);
  const reply = await bridge.searchRelease({ directory });
  return isFailure(reply) ? reply : success(null);
}
