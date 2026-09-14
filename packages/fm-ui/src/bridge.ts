import type { Bookmark } from "@symmetria/fm-core/bookmarks";
import { BRIDGE_KEY, type Bridge, type Unsubscribe } from "@symmetria/fm-core/bridge";
import {
  type ChangedEvent,
  type ClipboardRequest,
  type CreateRequest,
  type DescribeReply,
  decodeBookmarksReply,
  decodeChangedEvent,
  decodeDescribeReply,
  decodeFrecentReply,
  decodeListingOptionsReply,
  decodeListReply,
  decodePreviewUrlReply,
  decodeReadTextReply,
  decodeRenameReply,
  decodeTransferProgress,
  decodeTransferReply,
  type FrecentReply,
  failure,
  isFailure,
  isRecord,
  type ListReply,
  type ReadTextReply,
  type RenameReply,
  type Result,
  success,
  type TransferReply,
  type TransferRequest,
} from "@symmetria/fm-core/contract";
import type { ListingOptions } from "@symmetria/fm-core/listingOptions";
import { decodeOverviewReply, type OverviewReply } from "@symmetria/fm-core/overview/contract";

/**
 * The renderer's side of the bridge: untyped in, typed out.
 *
 * The preload deliberately declares its parameters as `unknown` — page code is
 * untrusted from the preload's point of view, so the preload promises nothing
 * about shapes. This module is where the renderer takes that raw surface and
 * turns it into values the interface can render, by parsing rather than by
 * asserting. Every component above this line sees domain types only.
 */

declare global {
  interface Window {
    readonly [BRIDGE_KEY]?: Bridge;
  }
}

/**
 * The bridge, or nothing. Deliberately NOT exported.
 *
 * Absent means the preload did not run — a packaging fault, not a user error.
 * Returning `null` rather than throwing lets the interface say so on screen
 * instead of showing a blank window with an error only in a console nobody has
 * open. Keeping it module-private means the untyped surface has exactly the
 * consumers in this file, so no component can reach past the decoding.
 */
function getBridge(): Bridge | null {
  return window[BRIDGE_KEY] ?? null;
}

/**
 * What a listing request carries: the stored order, narrowed to what it uses.
 *
 * DERIVED from `ListingOptions` rather than declared again. It was declared
 * again once, and `useTabs` aliased it a fourth time — so a field added to the
 * stored preference would have compiled everywhere and been sent nowhere.
 *
 * The narrowing arrived with `renderDocuments`, which lives in the same store
 * and decides how a file is DRAWN rather than what a listing contains. Naming
 * the three in the type is what lets a caller memoise exactly the fields a
 * listing depends on — without that, an effect re-reading a directory when the
 * order changes also re-reads it when the render mode does, and the parent
 * column flickers for a key that has nothing to do with it.
 *
 * ── What this type does NOT guarantee ───────────────────────────────────────
 * Review asked, and the honest answer is worth writing down: it documents which
 * fields a listing consumes; it does not make the compiler enforce that they
 * stay in step. `listDirectory` below builds its payload by naming each field
 * rather than by spreading, so a fourth field that DID affect a listing would
 * have to be added by hand in three places, none of which the type connects:
 *
 *   1. this type,
 *   2. the payload literal in `listDirectory` below,
 *   3. `listingIdentity` and the `forListing` memo in `useTabs.ts`.
 *
 * A field added to `ListingOptions` and nowhere else compiles everywhere and is
 * sent nowhere — the hazard the original comment named, still present, now
 * merely visible. Anyone adding one should start from this list.
 */
export type ListOptions = Pick<ListingOptions, "sort" | "reverse" | "showHidden">;

const MISSING_BRIDGE = "the preload bridge is not present; this build is incomplete";

/**
 * List one directory, whole.
 *
 * Not streamed. Streaming exists in the main process and is exercised by its
 * own tests, but a pane that repaints per batch flickers on every navigation,
 * and the measured scan of a large directory finishes in tens of milliseconds —
 * below the threshold where progressive display buys anything. The streaming
 * path stays for the directories where it will not.
 */
export async function listDirectory(
  path: string,
  options: ListOptions,
): Promise<Result<ListReply>> {
  const bridge = getBridge();
  if (bridge === null) return failure("scan_failed", MISSING_BRIDGE);

  const reply = await bridge.list({
    path,
    showHidden: options.showHidden,
    sort: options.sort,
    reverse: options.reverse,
    stream: false,
    streamId: null,
  });

  return isFailure(reply) ? reply : decodeListReply(reply.value);
}

/**
 * Every live watch in this renderer, by subscription id.
 *
 * ONE bridge listener serves all of them, and it delivers each event only to
 * the subscription it names.
 *
 * Both halves of that were defects. A listener per watch meant a change in any
 * directory woke every open tab — O(tabs) re-listings per filesystem event —
 * and eleven tabs was enough for Electron to print
 * `MaxListenersExceededWarning: 11 symmetria-fm:changed listeners added`. And
 * the callback ignored the event payload entirely, so there was nothing to
 * filter ON: `decodeChangedEvent` existed and had no consumer, which is usually
 * the sign that a message is being taken on faith.
 */
const subscribers = new Map<string, (event: ChangedEvent) => void>();
let listening: Unsubscribe | null = null;

function deliver(raw: unknown): void {
  const event = decodeChangedEvent(raw);
  // A malformed push is dropped rather than broadcast. Waking every tab on an
  // event nobody can attribute is how the fan-out came back.
  if (isFailure(event)) return;

  subscribers.get(event.value.subscriptionId)?.(event.value);
}

/**
 * Everything the preview router needs about one entry, in one round trip.
 *
 * One call rather than three: a `stat`, a MIME resolution and a head read on
 * separate channels would each pay the boundary crossing, and every cursor
 * movement would pay all three.
 */
export async function describeEntry(path: string): Promise<Result<DescribeReply>> {
  const bridge = getBridge();
  if (bridge === null) return failure("read_failed", MISSING_BRIDGE);

  const reply = await bridge.describe({ path });
  return isFailure(reply) ? reply : decodeDescribeReply(reply.value);
}

/**
 * A URL the renderer may load this file from.
 *
 * Not a blob URL built from bytes sent over the bridge: Chromium's PDF viewer
 * refuses a blob whose origin is a custom scheme, and the embed silently
 * resolves to an error page. A URL under the application's own scheme is one
 * the viewer accepts — and it saves copying the file across the boundary.
 */
export async function previewUrl(path: string): Promise<Result<string>> {
  const bridge = getBridge();
  if (bridge === null) return failure("read_failed", MISSING_BRIDGE);

  const reply = await bridge.previewUrl({ path });
  if (isFailure(reply)) return reply;

  const decoded = decodePreviewUrlReply(reply.value);
  return isFailure(decoded) ? decoded : { ok: true, value: decoded.value.url };
}

/**
 * The URL a previewed file's own directory is served under.
 *
 * What comes back is a PREFIX: append a slash and a relative path to reach a
 * neighbour. Every such path is checked for containment in the main process,
 * against the real location on disk, so a symbolic link cannot climb out of
 * the document's directory.
 *
 * Separate from `previewUrl` because the grant behind it is a different thing.
 * That one makes one file loadable and narrows nothing; this one names a root
 * and refuses everything outside it, which is what makes it safe to point at
 * a stranger's document.
 */
export async function previewDirectoryUrl(path: string): Promise<Result<string>> {
  const bridge = getBridge();
  if (bridge === null) return failure("read_failed", MISSING_BRIDGE);

  const reply = await bridge.previewDirectoryUrl({ path });
  if (isFailure(reply)) return reply;

  // The same reply shape as `previewUrl`, and deliberately the same decoder: a
  // URL is a URL, and a second one would be a second thing to keep in step.
  const decoded = decodePreviewUrlReply(reply.value);
  return isFailure(decoded) ? decoded : { ok: true, value: decoded.value.url };
}

/**
 * Put text or an image on the system clipboard.
 *
 * The image travels as a PATH for the main process to read, not as bytes. The
 * renderer is sandboxed and has no way to open a file, which is the whole
 * reason this crosses the bridge rather than reaching the platform clipboard
 * directly.
 */
export async function copyToClipboard(request: ClipboardRequest): Promise<Result<null>> {
  const bridge = getBridge();
  if (bridge === null) return failure("write_failed", MISSING_BRIDGE);

  const reply = await bridge.clipboard(request);
  return isFailure(reply) ? reply : success(null);
}

/**
 * The directories zoxide records this user going to, most frecent first.
 *
 * Asked for ONCE when the popup opens. Narrowing happens in the renderer, so
 * typing costs nothing — a query per keystroke would spawn a process per
 * character.
 */
export async function frecentDirectories(): Promise<Result<FrecentReply>> {
  const bridge = getBridge();
  if (bridge === null) return failure("read_failed", MISSING_BRIDGE);

  const reply = await bridge.frecent({});
  return isFailure(reply) ? reply : decodeFrecentReply(reply.value);
}

/** Read the head of a file as text. */
export async function readFileText(path: string, maxBytes: number): Promise<Result<ReadTextReply>> {
  const bridge = getBridge();
  if (bridge === null) return failure("read_failed", MISSING_BRIDGE);

  const reply = await bridge.readText({ path, maxBytes });
  return isFailure(reply) ? reply : decodeReadTextReply(reply.value);
}

/** Watch a directory, and stop watching when the returned function is called. */
export async function watchDirectory(
  path: string,
  subscriptionId: string,
  onChanged: (event: ChangedEvent) => void,
): Promise<() => Promise<void>> {
  const bridge = getBridge();
  if (bridge === null) {
    onChanged({ subscriptionId, error: MISSING_BRIDGE });
    return async () => undefined;
  }

  subscribers.set(subscriptionId, onChanged);
  listening ??= bridge.onChanged(deliver);

  const release = () => {
    subscribers.delete(subscriptionId);
    if (subscribers.size === 0) {
      listening?.();
      listening = null;
    }
  };

  const started = await bridge
    .watch({ path, subscriptionId })
    .catch(() => failure("watch_failed", "Watch setup failed"));

  // A watch that failed to start still left a subscriber registered, so the
  // teardown runs either way. Half-cleaning up is how a callback outlives the
  // tab that owns it.
  if (isFailure(started)) {
    onChanged({ subscriptionId, error: started.error.message });
    release();
    return async () => undefined;
  }

  return async () => {
    release();
    await bridge.unwatch({ subscriptionId }).catch(() => undefined);
  };
}

/** Copy or move entries into a directory. */
export async function transferEntries(request: TransferRequest): Promise<Result<TransferReply>> {
  const bridge = getBridge();
  if (bridge === null) return failure("write_failed", MISSING_BRIDGE);

  const reply = await bridge.transfer(request);
  return isFailure(reply) ? reply : decodeTransferReply(reply.value);
}

/** Abandon a running transfer. */
export function cancelTransfer(transferId: string): void {
  void getBridge()?.cancelTransfer({ transferId });
}

/** Create an empty file or a directory, with its parents. */
export async function createPath(request: CreateRequest): Promise<Result<null>> {
  const bridge = getBridge();
  if (bridge === null) return failure("write_failed", MISSING_BRIDGE);

  const reply = await bridge.create(request);
  return isFailure(reply) ? reply : { ok: true, value: null };
}

/** Rename an entry in place. */
export async function renamePath(path: string, name: string): Promise<Result<RenameReply>> {
  const bridge = getBridge();
  if (bridge === null) return failure("write_failed", MISSING_BRIDGE);

  const reply = await bridge.rename({ path, name });
  return isFailure(reply) ? reply : decodeRenameReply(reply.value);
}

/** Send entries to the desktop trash. */
export async function trashPaths(paths: readonly string[]): Promise<Result<null>> {
  const bridge = getBridge();
  if (bridge === null) return failure("write_failed", MISSING_BRIDGE);

  const reply = await bridge.trash({ paths });
  return isFailure(reply) ? reply : { ok: true, value: null };
}

/** Hand an entry to whatever the desktop says opens it. */
export async function openPath(path: string): Promise<Result<null>> {
  const bridge = getBridge();
  if (bridge === null) return failure("read_failed", MISSING_BRIDGE);

  const reply = await bridge.open({ path });
  return isFailure(reply) ? reply : { ok: true, value: null };
}

/**
 * Put the window away, keeping the program and everything in it alive.
 *
 * **The renderer must never call `window.close()`, and this exists so it does
 * not have to.** Verification found that page code closing the window DESTROYS
 * it, and — measured directly on Electron 41 — without ever raising the
 * window's own `close` event, so the main process cannot intercept it. The tab
 * set, the cursor and the scroll position all went with it, which is exactly
 * what this run exists to prevent. Asking the main process is the only route
 * that hides rather than destroys.
 */
export async function hideWindow(): Promise<void> {
  const bridge = getBridge();
  // Nothing to hide without a host, and no useful failure to report to a user:
  // this is only reachable in a test harness with no bridge installed.
  if (bridge === null) return;

  await bridge.hideWindow({});
}

/**
 * Tell the main process what the user chose, and for which dialog.
 *
 * The renderer cannot write a named pipe and must not try — it is sandboxed
 * with no filesystem at all. It says WHAT was chosen; the main process owns the
 * pipe, the exactly-once rule and the expiry. Naming the FIFO is not authority
 * to answer it either: the host refuses one that is not the open picker's.
 */
export async function pickerConfirm(request: {
  readonly fifo: string;
  readonly paths: readonly string[];
}): Promise<void> {
  const bridge = getBridge();
  if (bridge === null) return;
  await bridge.pickerConfirm(request);
}

/** The user cancelled, or Escape reached the dialog. */
export async function pickerCancel(request: { readonly fifo: string }): Promise<void> {
  const bridge = getBridge();
  if (bridge === null) return;
  await bridge.pickerCancel(request);
}

/**
 * A path the daemon was asked, from outside, to open.
 *
 * The origin is another program entirely — the command-line tool, and later a
 * portal request — so this arrives as a push rather than as an answer to
 * anything the interface asked. The payload is re-checked here even though the
 * main process decoded it already: this edge is where every other reply is
 * validated, and a channel exempt from that is the one nobody thinks about.
 */
export function onOpenPath(onPath: (path: string) => void): Unsubscribe {
  const bridge = getBridge();
  if (bridge === null) return () => undefined;

  return bridge.onOpenPath((raw) => {
    if (!isRecord(raw)) return;
    const path = raw.path;
    if (typeof path !== "string" || path === "") return;
    onPath(path);
  });
}

/**
 * Follow a running transfer.
 *
 * One listener for the channel, dispatched to the transfer it names — the same
 * shape the change events use, and for the same reason: a listener per transfer
 * would wake every one of them on each tick.
 */
export function onTransferProgress(
  transferId: string,
  onTick: (done: number, total: number) => void,
): Unsubscribe {
  const bridge = getBridge();
  if (bridge === null) return () => undefined;

  return bridge.onTransferProgress((raw) => {
    const event = decodeTransferProgress(raw);
    if (isFailure(event) || event.value.transferId !== transferId) return;
    onTick(event.value.done, event.value.total);
  });
}

/**
 * The bookmark store, as a map.
 *
 * Converted from the wire's list of pairs at this edge, so nothing above here
 * has to remember that the boundary carries plain data. A failure is returned
 * rather than thrown, like every other call in this file.
 */
export async function readBookmarks(): Promise<Result<Map<string, Bookmark>>> {
  const bridge = getBridge();
  if (bridge === null) return failure("read_failed", MISSING_BRIDGE);

  // The Result first, then its value. Handing the whole envelope to the decoder
  // is the shape mistake this boundary invites, and it fails as "reply must be
  // an object" — which reads like a main-process fault rather than a caller's.
  const reply = await bridge.bookmarksRead({});
  if (isFailure(reply)) return reply;

  const decoded = decodeBookmarksReply(reply.value);
  if (isFailure(decoded)) return decoded;

  return success(
    new Map(decoded.value.bookmarks.map(({ letter, bookmark }) => [letter, bookmark])),
  );
}

/**
 * The stored listing order, or the default.
 *
 * Never a failure the caller has to handle as one: the main process answers the
 * default when there is no file and when there is one nobody can read, so the
 * only failures left here are a missing bridge and a malformed reply. Both are
 * reported, and `useTabs` treats either as "open on the default" — a missing
 * preference is not a reason to refuse to list.
 */
export async function readListingOptions(): Promise<Result<ListingOptions>> {
  const bridge = getBridge();
  if (bridge === null) return failure("read_failed", MISSING_BRIDGE);

  const reply = await bridge.listingRead({});
  if (isFailure(reply)) return reply;

  const decoded = decodeListingOptionsReply(reply.value);
  return isFailure(decoded) ? decoded : success(decoded.value.options);
}

/** Replace the stored listing order. */
export async function writeListingOptions(options: ListingOptions): Promise<Result<null>> {
  const bridge = getBridge();
  if (bridge === null) return failure("write_failed", MISSING_BRIDGE);

  const reply = await bridge.listingWrite({ options });
  return isFailure(reply) ? reply : success(null);
}

/** Replace the stored bookmarks. */
export async function writeBookmarks(
  bookmarks: ReadonlyMap<string, Bookmark>,
): Promise<Result<null>> {
  const bridge = getBridge();
  if (bridge === null) return failure("write_failed", MISSING_BRIDGE);

  const reply = await bridge.bookmarksWrite({
    bookmarks: [...bookmarks].map(([letter, bookmark]) => ({ letter, bookmark })),
  });
  return isFailure(reply) ? reply : success(null);
}

export async function readOverview(
  path: string,
  requestId: string,
  limit: number,
): Promise<Result<OverviewReply>> {
  const bridge = getBridge();
  if (bridge === null) return failure("scan_failed", MISSING_BRIDGE);
  try {
    const reply = await bridge.overview({ path, requestId, limit });
    return isFailure(reply) ? reply : decodeOverviewReply(reply.value);
  } catch (cause) {
    return failure("scan_failed", String(cause));
  }
}
export function cancelOverview(requestId: string): void {
  void getBridge()?.cancel({ streamId: requestId });
}
