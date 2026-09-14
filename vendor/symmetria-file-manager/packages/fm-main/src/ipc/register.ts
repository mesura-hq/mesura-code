import type { Dirent } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { decodeBookmarks } from "@symmetria/fm-core/bookmarks";
import {
  type Decoder,
  decodeBookmarksWriteRequest,
  decodeCancelRequest,
  decodeCancelTransferRequest,
  decodeClipboardRequest,
  decodeCreateRequest,
  decodeDescribeRequest,
  decodeListingOptionsWriteRequest,
  decodeListRequest,
  decodeOpenRequest,
  decodePreviewDirectoryUrlRequest,
  decodePreviewUrlRequest,
  decodeReadTextRequest,
  decodeRenameRequest,
  decodeSearchDirectoryRequest,
  decodeSearchQueryRequest,
  decodeSearchRecordRequest,
  decodeTransferRequest,
  decodeTrashRequest,
  decodeUnwatchRequest,
  decodeWatchRequest,
  type FailureCode,
  failure,
  type IpcReply,
  isFailure,
  type ListBatch,
  type ListReply,
  type Result,
  success,
} from "@symmetria/fm-core/contract";
import type { EntrySummary, FsEntry } from "@symmetria/fm-core/entry";
import { filterEntries } from "@symmetria/fm-core/filter";
import { resolveListingOptions } from "@symmetria/fm-core/listingOptions";
import { resolveMimeType } from "@symmetria/fm-core/mime";
import { decodeOverviewRequest } from "@symmetria/fm-core/overview/contract";
import { sortEntries } from "@symmetria/fm-core/sort";
import { defaultBookmarksPath, readOrSeedBookmarks, saveBookmarks } from "../bookmarks.ts";
import { mimeTables } from "../fs/mimeTables.ts";
import { readOverviewDirectory } from "../fs/overview.ts";
import { kindOf, scanDirectory } from "../fs/scan.ts";
import { type ChangedEntry, type StopWatching, watchDirectory } from "../fs/watch.ts";
import {
  defaultListingOptionsPath,
  loadListingOptions,
  saveListingOptions,
} from "../listingOptions.ts";
import { copyImage, copyText } from "../ops/clipboard.ts";
import { operations } from "../ops/index.ts";
import { frecentDirectories } from "../ops/zoxide.ts";
import { authorisePreview, authorisePreviewDirectory } from "../previewTokens.ts";
import { searchPool } from "../search.ts";
import { CHANNELS, REQUEST_CHANNELS } from "./channels.ts";

/**
 * How much of a file's head the content sniff needs.
 *
 * The same figure `fm-core`'s sniff inspects. Reading more would cost a page
 * fault per preview for evidence nothing reads.
 */
const SNIFF_BYTES = 8192;

/**
 * How many names a directory's describe reply carries.
 *
 * The cap is here rather than in the renderer because this is the side that can
 * stop the work: a directory of ten thousand entries would otherwise serialise
 * ten thousand names across the boundary every time the cursor settled on it,
 * which the 150 ms preview debounce spaces out but does not bound. The true
 * count travels beside the listing, so the column can still say how many it is
 * not showing.
 *
 * 500 is far more than fits on any screen and small enough that the reply stays
 * a few tens of kilobytes.
 */
export const MAX_DIRECTORY_PREVIEW_ENTRIES = 500;

/**
 * One `readdir` result reduced to what a listing row draws.
 *
 * **A symlink's own dirent type is `DT_LNK`**, so `isDirectory()` and
 * `isFile()` are both false for one — classifying straight from the dirent
 * would make every link `other`, and a symlinked directory would draw the wrong
 * icon here while drawing the right one two columns to the left. What a person
 * means by "what is this" is the target, which is what `scanDirectory` already
 * reports in the two navigable columns.
 *
 * `kindOf` is shared with that scan rather than reimplemented, so the two can
 * never come to disagree. The stat strategy is NOT shared: the scan needs a
 * size and an mtime for every entry, and a listing row needs neither, so this
 * pays a `stat` only for the links.
 */
async function direntSummary(directory: string, dirent: Dirent): Promise<EntrySummary> {
  if (!dirent.isSymbolicLink()) return { name: dirent.name, kind: kindOf(dirent) };

  // A broken link resolves to `other` and stays listed, exactly as in the scan:
  // dropping it would make it invisible.
  const target = await stat(join(directory, dirent.name)).catch(() => null);
  return { name: dirent.name, kind: kindOf(target) };
}

async function readHead(path: string, bytes: number): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return new Uint8Array(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/**
 * The transport, as a shape rather than an import.
 *
 * Handed in rather than reached for, so routing, decoding and error handling
 * are testable in plain Node. Same reasoning as `buildWindowOptions` and
 * `resolveWithinRoot`: the parts worth testing must not drag Electron with them.
 */

/**
 * One window, as the only two things this package may know about one: it can be
 * pushed to, and it is not any other window.
 *
 * **The identity and the transport are deliberately the same object.** An
 * earlier version separated them — an opaque `object` token plus a registry-wide
 * sender that resolved it — and that shape was worse twice over. It gave callers
 * no contract at all (`object` says nothing), and it left two things that had to
 * be kept in step by whoever wired the host. Here a window is a thing you can
 * send to, map keys are its identity, and there is nothing to keep in step.
 *
 * Nothing about Electron appears in it: `send` takes a channel and a payload,
 * which is as true of a test double as of a `WebContents`.
 */
export interface SenderHandle {
  send(channel: string, payload: unknown): void;
}

/**
 * A handler takes the payload and the window it came from.
 *
 * The second parameter is what makes more than one window possible. It used to
 * be absent, and every push therefore went to whichever window the host had
 * captured when it built the registry — see the note on `createRegistry`, which
 * predicted this and named routing by sender as the fix.
 */
export type IpcHandler = (payload: unknown, from: SenderHandle) => Promise<IpcReply>;

export interface IpcSurface {
  handle(channel: string, handler: IpcHandler): void;
  removeHandler(channel: string): void;
}

/** What `createRegistry` hands back. Named, so the contract has somewhere to live. */
export interface Registry {
  /** Unregister every handler, abort every stream, release every watch. */
  dispose(): void;
  /**
   * Release one window's resources and forget it.
   *
   * The host calls this when a window is destroyed. `dispose` is the whole-process
   * lever and still means everything; this one must not touch any other window,
   * which is exactly what a picker opening and closing repeatedly depends on.
   */
  disposeSender(from: SenderHandle): void;
  /**
   * How many windows this registry is currently holding resources for.
   *
   * Production surface for one reason: on a daemon that runs for days and opens
   * a window per file dialog, "does the registry forget a window that has gone"
   * is a real operational question, and without this it has no answer that is
   * not a heap dump. It is also the only way to assert the leak review found —
   * a handler that created a record for a window with nothing in flight left an
   * empty entry behind, and every other observable behaved identically either
   * way, so a test written without this would have passed on the bug.
   */
  trackedWindows(): number;
}

/**
 * Turn an authorised preview token into a URL the page can load.
 *
 * INJECTED, not imported, and the split is what proved it had to be. The URL
 * carries the host's own private scheme — `symmetria-fm://` in the standalone,
 * and whatever an embedding application serves its renderer from. This package
 * has no way to know which, and importing the standalone's answer was the one
 * remaining line that would have stopped another host using it.
 */
export type PreviewUrlFor = (token: string) => string;

/**
 * What the host supplies.
 *
 * `previewUrlFor` is REQUIRED because there is no honest default: a fallback
 * would have to name some host's scheme, and a registry that quietly serves the
 * wrong origin is worse than one that will not compile without being told.
 * The other two are optional, injected so a test can prove a handler was never
 * entered.
 */
export interface Dependencies {
  previewUrlFor: PreviewUrlFor;
  scanDirectory?: typeof scanDirectory;
  readOverviewDirectory?: typeof readOverviewDirectory;
  watchDirectory?: typeof watchDirectory;
}

/**
 * How many entries travel in one push.
 *
 * Transfer lists are NOT zero-copy in Electron — transfer and clone measured
 * identical at about 400 MB/s, and a 256 MB payload took 607 ms either way — so
 * the entire cost of a large reply is copying it. One giant message blocks the
 * renderer until all of it lands; batches let the first rows paint immediately.
 */
const BATCH = 500;

/**
 * Register every handler on one transport.
 *
 * **One registry per process.** Electron's `ipcMain.handle` throws when a
 * channel already has a handler, so a second call on the same transport is a
 * crash rather than a second registry. That constraint has not moved — what has
 * moved is the consequence. This registry is now SHARED between windows and
 * routes by sender, which is the second of the two options the previous version
 * of this note named. `cancel: "all"` was the other half of it and now means
 * "everything THIS window started".
 *
 * The picker is what forced it: a second window that requested a listing and
 * watched its rows arrive somewhere else.
 */
export function createRegistry(ipc: IpcSurface, deps: Dependencies): Registry {
  const previewUrlFor = deps.previewUrlFor;
  const scan = deps.scanDirectory ?? scanDirectory;
  const readOverview = deps.readOverviewDirectory ?? readOverviewDirectory;
  const watch = deps.watchDirectory ?? watchDirectory;

  /**
   * One window's resources.
   *
   * Every map here used to be a single registry-wide map keyed by an identifier
   * the RENDERER chooses — and two renderers choose independently, so a picker
   * window opening subscription `s1` would have released the browse window's
   * `s1`. Keying by the pair is what makes the renderer's choice private to it.
   */
  interface WindowResources {
    readonly streams: Map<string, AbortController>;
    readonly watches: Map<string, StopWatching>;
    readonly watchQueue: Map<string, Promise<unknown>>;
  }

  const windows = new Map<SenderHandle, WindowResources>();
  let nextStream = 0;

  /** This window's tables, created on first use. */
  function resourcesFor(from: SenderHandle): WindowResources {
    const existing = windows.get(from);
    if (existing !== undefined) return existing;

    const fresh: WindowResources = {
      streams: new Map(),
      watches: new Map(),
      watchQueue: new Map(),
    };
    windows.set(from, fresh);
    return fresh;
  }

  /**
   * Forget a window that is holding nothing.
   *
   * `windows` holds its keys strongly, so without this a resident daemon that
   * opens and closes a picker all day accumulates one dead entry per dialog.
   * The host is expected to call `disposeSender` on close and this is the safety
   * net for when it does not — it runs only when all three tables are empty, so
   * it can never drop a record something still needs.
   */
  function pruneIfIdle(from: SenderHandle): void {
    const held = windows.get(from);
    if (held === undefined) return;
    if (held.streams.size > 0 || held.watches.size > 0 || held.watchQueue.size > 0) return;
    windows.delete(from);
  }

  /**
   * Decode, then run. The handler never sees a payload that failed to decode —
   * it is not merely given bad input to cope with, it is never called at all.
   */
  function guard<T>(
    decode: Decoder<T>,
    onError: FailureCode,
    run: (request: T, from: SenderHandle) => Promise<IpcReply>,
  ): IpcHandler {
    return async (payload, from) => {
      const decoded = decode(payload);
      if (isFailure(decoded)) return decoded;
      try {
        return await run(decoded.value, from);
      } catch (cause) {
        // Nothing throws across the boundary. A thrown error arrives as an
        // opaque string with no code, and the renderer cannot branch on it.
        //
        // The code is per channel, not a blanket `scan_failed`. Reporting a
        // read error or a watch error as a scan failure is a value that lies,
        // which defeats the reason failures are values at all.
        return failure(onError, cause instanceof Error ? cause.message : String(cause));
      }
    };
  }

  /**
   * Serialise work per subscription id.
   *
   * Two concurrent `watch` calls with the same id both read an empty map before
   * either writes, so both opened a real filesystem watch and the later one
   * silently overwrote the earlier — leaking a watcher that nothing could ever
   * stop, and delivering duplicate events under one id.
   *
   * The queue is PER WINDOW, like the tables it protects. Serialising two
   * different windows against each other would make one window's slow watch
   * delay another's, for two calls that never touch the same entry.
   */
  function serialise<T>(from: SenderHandle, id: string, work: () => Promise<T>): Promise<T> {
    const held = resourcesFor(from);
    const next = (held.watchQueue.get(id) ?? Promise.resolve()).then(work, work);
    const settled = next.catch(() => undefined);
    held.watchQueue.set(id, settled);
    // Drop the entry once this link is done, so an idle window really is idle
    // and `pruneIfIdle` can forget it. Only when nothing has queued behind it —
    // otherwise a second call waiting on this one loses its place in the chain.
    void settled.then(() => {
      if (held.watchQueue.get(id) !== settled) return;
      held.watchQueue.delete(id);
      pruneIfIdle(from);
    });
    return next;
  }

  function claimRequest(from: SenderHandle, id: string): AbortController | null {
    const held = resourcesFor(from);
    if (held.streams.has(id)) return null;
    const controller = new AbortController();
    held.streams.set(id, controller);
    return controller;
  }
  function releaseRequest(from: SenderHandle, id: string, controller: AbortController): void {
    const held = windows.get(from);
    if (held?.streams.get(id) === controller) held.streams.delete(id);
    pruneIfIdle(from);
  }

  ipc.handle(
    CHANNELS.overview,
    guard(decodeOverviewRequest, "scan_failed", async (request, from) => {
      const controller = claimRequest(from, request.requestId);
      if (controller === null) return failure("invalid_request", "request ID already active");
      try {
        const reply = await readOverview(request.path, request.limit, controller.signal);
        if (controller.signal.aborted) return failure("cancelled", "overview cancelled");
        return success(reply);
      } catch (cause) {
        if (controller.signal.aborted) return failure("cancelled", "overview cancelled");
        throw cause;
      } finally {
        releaseRequest(from, request.requestId, controller);
      }
    }),
  );

  ipc.handle(
    CHANNELS.list,
    guard(decodeListRequest, "scan_failed", async (request, from): Promise<Result<ListReply>> => {
      const streamId = request.streamId ?? `s${nextStream++}`;
      const controller = claimRequest(from, streamId);
      if (controller === null) return failure("invalid_request", "request ID already active");

      try {
        const raw = await scan(request.path, { signal: controller.signal });
        const shown = sortEntries(
          filterEntries(raw, { showHidden: request.showHidden }),
          request.sort,
          request.reverse,
        );

        if (!request.stream) {
          return success({ entries: shown, total: shown.length, streamId: null });
        }

        await pushBatches(from, streamId, shown);
        return success({ entries: [], total: shown.length, streamId });
      } catch (cause) {
        if (controller.signal.aborted) return failure("cancelled", "the scan was cancelled");
        return failure("scan_failed", cause instanceof Error ? cause.message : String(cause));
      } finally {
        releaseRequest(from, streamId, controller);
      }
    }),
  );

  ipc.handle(
    CHANNELS.cancel,
    guard(decodeCancelRequest, "cancelled", async (request, from) => {
      // `all` is the tab-closed case: abandon everything THIS window started.
      // It used to abandon everything the registry knew, which was correct while
      // there was one window and would have let a picker closing a tab kill the
      // browse window's in-flight scans.
      //
      // **`windows.get` and NOT `resourcesFor`, which is the one difference
      // from every other handler here.** Cancelling is the only operation that
      // stores nothing, and a window may cancel with nothing in flight — a
      // renderer clearing up on unmount does exactly that. Creating a record
      // for it would leave an empty entry in a strongly-keyed map for a window
      // that never came back, which for a daemon opening a picker per file
      // dialog is a leak with one entry per dialog. Review found it.
      const held = windows.get(from);
      if (held === undefined) return success(null);

      const targets =
        request.streamId === "all"
          ? [...held.streams.values()]
          : [held.streams.get(request.streamId)];
      for (const controller of targets) controller?.abort();
      return success(null);
    }),
  );

  ipc.handle(
    CHANNELS.watch,
    guard(decodeWatchRequest, "watch_failed", async (request, from) => {
      const held = resourcesFor(from);
      return serialise(from, request.subscriptionId, async () => {
        await held.watches.get(request.subscriptionId)?.();
        const stop = await watch(
          request.path,
          (changed: ChangedEntry[]) => {
            from.send(CHANNELS.changed, { subscriptionId: request.subscriptionId, changed });
          },
          (error) => from.send(CHANNELS.changed, { subscriptionId: request.subscriptionId, error }),
        );
        held.watches.set(request.subscriptionId, stop);
        return success(null);
      });
    }),
  );

  ipc.handle(
    CHANNELS.unwatch,
    guard(decodeUnwatchRequest, "watch_failed", async (request, from) => {
      const held = resourcesFor(from);
      return serialise(from, request.subscriptionId, async () => {
        await held.watches.get(request.subscriptionId)?.();
        held.watches.delete(request.subscriptionId);
        return success(null);
      });
    }),
  );

  ipc.handle(
    CHANNELS.describe,
    guard(decodeDescribeRequest, "read_failed", async (request) => {
      const stats = await stat(request.path);

      if (stats.isDirectory()) {
        // `readdir` rather than the full scan, still: the listing needs a name
        // and a kind, and `withFileTypes` returns the kind inline — on Linux it
        // comes back in the same `getdents64` the names do, so it costs nothing
        // extra. The full scan would `stat` every entry for a size and an mtime
        // that no row in the preview column draws.
        const found = await readdir(request.path, { withFileTypes: true });
        return success({
          name: basename(request.path),
          path: request.path,
          isDirectory: true,
          entryCount: found.length,
          entries: await Promise.all(
            found
              .slice(0, MAX_DIRECTORY_PREVIEW_ENTRIES)
              .map((dirent) => direntSummary(request.path, dirent)),
          ),
          size: stats.size,
          mime: "inode/directory",
          head: new Uint8Array(),
        });
      }

      const tables = await mimeTables();
      return success({
        name: basename(request.path),
        path: request.path,
        isDirectory: false,
        entryCount: 0,
        entries: [],
        size: stats.size,
        mime: resolveMimeType(tables, basename(request.path)),
        head: await readHead(request.path, SNIFF_BYTES),
      });
    }),
  );

  // No `guard`: this channel takes no payload, so there is nothing to decode.
  ipc.handle(CHANNELS.bookmarksRead, async () => {
    try {
      const bookmarks = await readOrSeedBookmarks();
      return success({
        bookmarks: [...bookmarks].map(([letter, bookmark]) => ({ letter, bookmark })),
      });
    } catch (cause) {
      return failure("read_failed", cause instanceof Error ? cause.message : String(cause));
    }
  });

  ipc.handle(
    CHANNELS.bookmarksWrite,
    guard(decodeBookmarksWriteRequest, "write_failed", async (request) => {
      // Shape, then MEANING. `decodeBookmarksWriteRequest` proves the payload
      // is a list of letter-and-bookmark pairs; it does not know that `g` is
      // reserved or that a path must be absolute. Running the store's own
      // decoder here applies the same rules the read path applies, so a caller
      // cannot persist an entry that the next load would silently drop —
      // a bookmark that appears to save and is gone after a restart.
      const asObject: Record<string, { path: string; label: string }> = {};
      for (const { letter, bookmark } of request.bookmarks) asObject[letter] = bookmark;

      await saveBookmarks(defaultBookmarksPath(), decodeBookmarks(asObject));
      return success(null);
    }),
  );

  /**
   * The listing order, read once when a window opens.
   *
   * Answers the DEFAULT rather than a failure when there is no file and when
   * there is one nobody can read. A missing preference is not an error, and a
   * window that refused to list because of it would be worse than one that
   * lists in an order the user has to set again.
   */
  ipc.handle(CHANNELS.listingRead, async () => {
    const stored = await loadListingOptions(defaultListingOptionsPath());
    return success({ options: resolveListingOptions(stored).options });
  });

  ipc.handle(
    CHANNELS.listingWrite,
    guard(decodeListingOptionsWriteRequest, "write_failed", async (request) => {
      // Shape, then MEANING. The decoder proves the payload is an options
      // object; `decodeListingOptions` inside it applies the rules the READ
      // path applies, so a caller cannot persist a sort mode the next load
      // would silently discard — a setting that appears to save and is gone
      // after a restart. The bookmark write does the same two steps.
      //
      // A file nobody could parse is left alone: `mayWrite` is false for it,
      // and saving over the user's data mid-edit destroys it.
      const path = defaultListingOptionsPath();
      const stored = await loadListingOptions(path);
      if (!resolveListingOptions(stored).mayWrite) {
        return failure("write_failed", "the stored listing order could not be read");
      }

      await saveListingOptions(path, request.options);
      return success(null);
    }),
  );

  ipc.handle(
    CHANNELS.previewUrl,
    guard(decodePreviewUrlRequest, "read_failed", async (request) => {
      // Stat first, so a path that cannot be read fails here rather than as a
      // broken image the renderer has no way to explain.
      await stat(request.path);
      return success({ url: previewUrlFor(authorisePreview(request.path)) });
    }),
  );

  ipc.handle(
    CHANNELS.previewDirectoryUrl,
    guard(decodePreviewDirectoryUrlRequest, "read_failed", async (request) => {
      // Stat first, for the same reason `previewUrl` does: a path that cannot
      // be read fails here rather than as a document whose images silently do
      // not appear.
      await stat(request.path);
      // The PARENT, taken here and never accepted from the renderer. A caller
      // naming its own root is the one shape that would let a bug in the panel
      // grant more than the document it is showing.
      return success({ url: previewUrlFor(authorisePreviewDirectory(dirname(request.path))) });
    }),
  );

  ipc.handle(
    CHANNELS.transfer,
    guard(decodeTransferRequest, "write_failed", async (request, from) => {
      const outcome = await operations.transfer(request, (done, total) => {
        from.send(CHANNELS.transferProgress, {
          transferId: request.transferId,
          done,
          total,
        });
      });
      return success(outcome);
    }),
  );

  ipc.handle(
    CHANNELS.cancelTransfer,
    guard(decodeCancelTransferRequest, "write_failed", (request) => {
      operations.cancelTransfer(request.transferId);
      return Promise.resolve(success(null));
    }),
  );

  ipc.handle(
    CHANNELS.create,
    guard(decodeCreateRequest, "write_failed", async (request) => {
      await operations.create(request.path, request.kind);
      return success(null);
    }),
  );

  ipc.handle(
    CHANNELS.rename,
    guard(decodeRenameRequest, "write_failed", async (request) => {
      return success({ path: await operations.rename(request.path, request.name) });
    }),
  );

  ipc.handle(
    CHANNELS.trash,
    guard(decodeTrashRequest, "write_failed", async (request) => {
      await operations.trash(request.paths);
      return success(null);
    }),
  );

  ipc.handle(
    CHANNELS.searchStart,
    guard(decodeSearchDirectoryRequest, "read_failed", async (request) => {
      // Waited on, not fired and forgotten. The pool spawns on first ask and
      // reuses afterwards, so a second start for the same directory is cheap
      // and a caller does not have to track whether it already opened one —
      // but an index that fails to open has to be reported HERE. Returning
      // success and letting the first query discover it turns "this directory
      // could not be indexed" into a finder that shows nothing and says
      // nothing.
      await searchPool().start(request.directory);
      return success(null);
    }),
  );

  ipc.handle(
    CHANNELS.searchQuery,
    guard(decodeSearchQueryRequest, "read_failed", async (request) => {
      const reply = await searchPool().search(request.directory, request.query);
      return success(reply);
    }),
  );

  ipc.handle(
    CHANNELS.searchRecord,
    guard(decodeSearchRecordRequest, "write_failed", async (request) => {
      // Fire and forget, deliberately. The engine's tracker write has no
      // outcome a user could act on, and making the overlay wait for it would
      // put a statistic on the path between pressing Enter and the file
      // opening. Silent when the index is already gone.
      searchPool().record(request.directory, request.query, request.chosenPath);
      return success(null);
    }),
  );

  ipc.handle(
    CHANNELS.searchRelease,
    guard(decodeSearchDirectoryRequest, "read_failed", async (request) => {
      searchPool().release(request.directory);
      return success(null);
    }),
  );

  ipc.handle(CHANNELS.frecent, async () => {
    const listed = await frecentDirectories();
    // `read_failed` and not a spawn-specific code: from the renderer's side
    // this is one thing — the list could not be read — and the reason worth
    // showing is the message, not the class.
    return listed.ok ? success({ entries: listed.entries }) : failure("read_failed", listed.reason);
  });

  ipc.handle(
    CHANNELS.clipboard,
    guard(decodeClipboardRequest, "write_failed", async (request) => {
      if (request.kind === "text") {
        copyText(request.text);
        return success(null);
      }

      // Reported as a value rather than thrown. A file that is not an image —
      // or one that vanished between the keystroke and the read — is an
      // ordinary thing for a user to point at, not an exceptional one.
      const problem = copyImage(request.path);
      return problem === null ? success(null) : failure("write_failed", problem);
    }),
  );

  ipc.handle(
    CHANNELS.open,
    guard(decodeOpenRequest, "read_failed", async (request) => {
      await operations.open(request.path);
      return success(null);
    }),
  );

  ipc.handle(
    CHANNELS.readText,
    guard(decodeReadTextRequest, "read_failed", async (request) => {
      const handle = await open(request.path, "r");
      try {
        // Allocate what the file HOLDS, not what the caller asked for. The
        // first draft did `Buffer.alloc(request.maxBytes)` before reading, so a
        // renderer could force a 64 MB zero-filled allocation per call, with no
        // limit on how many calls were in flight, for a file of twelve bytes.
        const { size } = await handle.stat();
        const wanted = Math.min(request.maxBytes, size);
        const buffer = Buffer.alloc(wanted);
        const { bytesRead } = await handle.read(buffer, 0, wanted, 0);
        return success({
          text: buffer.subarray(0, bytesRead).toString("utf8"),
          bytesRead,
          truncated: bytesRead < size,
        });
      } finally {
        await handle.close();
      }
    }),
  );

  /** Abandon one window's work without touching the handler registrations. */
  function releaseWindow(held: WindowResources): void {
    for (const controller of held.streams.values()) controller.abort();
    for (const stop of held.watches.values()) void stop();
    held.streams.clear();
    held.watches.clear();
    held.watchQueue.clear();
  }

  return {
    dispose() {
      // Every request channel, including any this registry never handled.
      // `hideWindow` is registered by the HOST rather than here, and
      // `removeHandler` on an unregistered channel is a no-op — so this loop
      // is correct as written. Do NOT narrow it to the channels this file
      // handles: the loop is the safety net, and the set it iterates is the
      // contract rather than a list to keep in step by hand.
      for (const channel of Object.values(REQUEST_CHANNELS)) ipc.removeHandler(channel);
      // Still EVERY window. This runs at quit, and narrowing it to one would
      // leak whatever the last window did not happen to own.
      for (const held of windows.values()) releaseWindow(held);
      windows.clear();
    },

    disposeSender(from) {
      const held = windows.get(from);
      if (held === undefined) return;
      releaseWindow(held);
      windows.delete(from);
    },

    trackedWindows: () => windows.size,
  };
}

/**
 * Send the batches, yielding between them.
 *
 * A synchronous loop changes the wire granularity and nothing else: the main
 * process still serialises every batch before returning, so the first rows do
 * not paint any sooner. Yielding is what lets the renderer process batch one
 * while the main process is still building batch two.
 */
async function pushBatches(
  to: SenderHandle,
  streamId: string,
  entries: readonly FsEntry[],
): Promise<void> {
  for (let offset = 0; offset < entries.length; offset += BATCH) {
    const slice = entries.slice(offset, offset + BATCH);
    const batch: ListBatch = {
      streamId,
      entries: slice,
      done: offset + BATCH >= entries.length,
    };
    to.send(CHANNELS.listBatch, batch);
    await new Promise((resolve) => setImmediate(resolve));
  }
}
