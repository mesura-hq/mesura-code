import type { Bridge, Unsubscribe } from "@symmetria/fm-core/bridge";
import {
  type FailureCode,
  failure,
  isRecord,
  type Result,
  success,
} from "@symmetria/fm-core/contract";
import { PUSH_CHANNELS, REQUEST_CHANNELS } from "@symmetria/fm-main/ipc/channels";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type {
  FileManagerEvent,
  FileManagerPushChannel,
  FileManagerReadChannel,
  FileManagerReply,
  FileManagerWriteChannel,
} from "@t3tools/contracts";

import { randomUUID } from "~/lib/utils";

/**
 * The browser side of the file manager's bridge.
 *
 * The file manager's UI reaches its host through one object of channels
 * (`window.symmetriaFm`, typed by `@symmetria/fm-core/bridge`) and decodes
 * every reply itself. This object answers those channels over the server's
 * `fileManager.*` RPCs: a read channel is a query, a write channel a mutate,
 * and the four push channels arrive on one event stream per session. Three
 * calls never reach the server, because the browser owns them: the clipboard,
 * the window (closing the layer), and the picker, which this host has no use
 * for.
 *
 * The session exists on the server only once its event stream is open, so
 * every call waits for the stream's ready marker before it is sent. A stream
 * that fails afterwards is reported once through `onSessionLost`; the layer
 * decides whether to rebuild the bridge.
 */

/** A session's event stream, as the transport hands it back. */
export interface FileManagerSession {
  /** Resolves when the server has opened the session; rejects when the stream fails first. */
  readonly ready: Promise<void>;
  /** Stops following and ends the session on the server. */
  stop(): void;
}

/** What the bridge needs from the RPC layer. `apps/web/src/state/fileManagerRpc.ts` builds it. */
export interface FileManagerTransport {
  query(input: {
    readonly sessionId: string;
    readonly channel: FileManagerReadChannel;
    readonly payload: unknown;
  }): Promise<FileManagerReply>;
  mutate(input: {
    readonly sessionId: string;
    readonly channel: FileManagerWriteChannel;
    readonly payload: unknown;
  }): Promise<FileManagerReply>;
  /** Follow a session's pushes; `onLost` fires once if the stream fails after it opened. */
  events(
    sessionId: string,
    onEvent: (event: FileManagerEvent) => void,
    onLost: (cause: unknown) => void,
  ): FileManagerSession;
}

/** What the bridge needs from the page. */
export interface WsBridgeHooks {
  /** `hideWindow`: the file manager asks to be put away, and the layer closes. */
  close(): void;
  /** The environment's HTTP base URL, which preview URLs are resolved against. */
  httpBaseUrl(): string;
  clipboard: {
    writeText(text: string): Promise<void>;
    writeImage(blob: Blob): Promise<void>;
  };
  /** Fetch a preview as a blob, for the image clipboard. */
  fetchBlob(url: string): Promise<Blob>;
  /** The session's stream failed after it opened; pushes have stopped. */
  onSessionLost?(cause: unknown): void;
}

export interface WsBridge extends Bridge {
  /** End the session: stops the event stream and releases every watch on the server. Idempotent. */
  dispose(): void;
}

function failed(code: FailureCode, cause: unknown): Result<unknown> {
  return failure(code, cause instanceof Error ? cause.message : String(cause));
}

const SESSION_LOST = "the file manager's session was lost";

/** A bridge over one server session. Create it when the layer mounts; dispose it on unmount. */
export function createWsBridge(transport: FileManagerTransport, hooks: WsBridgeHooks): WsBridge {
  const sessionId = randomUUID();
  const listeners = new Map<FileManagerPushChannel, Set<(payload: unknown) => void>>();
  let lost = false;
  let disposed = false;

  const session = transport.events(
    sessionId,
    (event) => {
      // A snapshot: a listener may unsubscribe and re-arm during delivery.
      for (const listener of Array.from(listeners.get(event.channel) ?? []))
        listener(event.payload);
    },
    (cause) => {
      lost = true;
      hooks.onSessionLost?.(cause);
    },
  );

  /** Every call waits for the session; after a loss it fails fast. */
  const send =
    <Channel extends string>(
      code: FailureCode,
      call: (input: {
        readonly sessionId: string;
        readonly channel: Channel;
        readonly payload: unknown;
      }) => Promise<FileManagerReply>,
    ) =>
    (channel: Channel) =>
    async (payload: unknown): Promise<Result<unknown>> => {
      if (lost) return failure(code, SESSION_LOST);
      try {
        await session.ready;
        return await call({ sessionId, channel, payload });
      } catch (cause) {
        return failed(code, cause);
      }
    };
  const query = send<FileManagerReadChannel>("read_failed", (input) => transport.query(input));
  const mutate = send<FileManagerWriteChannel>("write_failed", (input) => transport.mutate(input));

  /**
   * The server answers a root-relative URL because it does not know the origin
   * this page reaches it by; a paired browser and the desktop shell differ.
   */
  const absoluteUrl = (reply: Result<unknown>): Result<{ readonly url: string }> => {
    if (!reply.ok) return reply;
    const value = reply.value;
    if (!isRecord(value) || typeof value["url"] !== "string") {
      return failure("invalid_reply", "the preview reply carried no URL");
    }
    const resolved = resolveAssetUrl(hooks.httpBaseUrl(), value["url"]);
    return resolved === null
      ? failure("invalid_reply", "the preview URL could not be resolved")
      : success({ ...value, url: resolved });
  };

  const listen =
    (channel: FileManagerPushChannel) =>
    (listener: (payload: unknown) => void): Unsubscribe => {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
      return () => {
        set.delete(listener);
      };
    };

  const previewUrl = query(REQUEST_CHANNELS.previewUrl);

  /** Text goes straight to the clipboard; an image is fetched from its preview first. */
  const clipboard = async (request: unknown): Promise<Result<unknown>> => {
    if (!isRecord(request))
      return failure("invalid_request", "clipboard request must be an object");
    try {
      if (request["kind"] === "text" && typeof request["text"] === "string") {
        await hooks.clipboard.writeText(request["text"]);
        return success(null);
      }
      if (request["kind"] === "image" && typeof request["path"] === "string") {
        const granted = absoluteUrl(await previewUrl({ path: request["path"] }));
        if (!granted.ok) return granted;
        await hooks.clipboard.writeImage(await hooks.fetchBlob(granted.value.url));
        return success(null);
      }
      return failure("invalid_request", "clipboard request must name text or an image path");
    } catch (cause) {
      return failed("write_failed", cause);
    }
  };

  return {
    version: "mesura-code",
    overview: query(REQUEST_CHANNELS.overview),
    list: query(REQUEST_CHANNELS.list),
    watch: query(REQUEST_CHANNELS.watch),
    unwatch: query(REQUEST_CHANNELS.unwatch),
    readText: query(REQUEST_CHANNELS.readText),
    cancel: query(REQUEST_CHANNELS.cancel),
    searchStart: query(REQUEST_CHANNELS.searchStart),
    searchQuery: query(REQUEST_CHANNELS.searchQuery),
    searchRecord: query(REQUEST_CHANNELS.searchRecord),
    searchRelease: query(REQUEST_CHANNELS.searchRelease),
    describe: query(REQUEST_CHANNELS.describe),
    previewUrl: (request) => previewUrl(request).then(absoluteUrl),
    previewDirectoryUrl: (request) =>
      query(REQUEST_CHANNELS.previewDirectoryUrl)(request).then(absoluteUrl),
    transfer: mutate(REQUEST_CHANNELS.transfer),
    cancelTransfer: mutate(REQUEST_CHANNELS.cancelTransfer),
    create: mutate(REQUEST_CHANNELS.create),
    rename: mutate(REQUEST_CHANNELS.rename),
    trash: mutate(REQUEST_CHANNELS.trash),
    open: mutate(REQUEST_CHANNELS.open),
    clipboard,
    frecent: query(REQUEST_CHANNELS.frecent),
    bookmarksRead: query(REQUEST_CHANNELS.bookmarksRead),
    bookmarksWrite: mutate(REQUEST_CHANNELS.bookmarksWrite),
    listingRead: query(REQUEST_CHANNELS.listingRead),
    listingWrite: mutate(REQUEST_CHANNELS.listingWrite),
    hideWindow: () => {
      hooks.close();
      return Promise.resolve(success(null));
    },
    // This host never opens the file manager as a dialog for another program.
    pickerConfirm: () => Promise.resolve(success(null)),
    pickerCancel: () => Promise.resolve(success(null)),
    onTransferProgress: listen(PUSH_CHANNELS.transferProgress),
    onListBatch: listen(PUSH_CHANNELS.listBatch),
    onChanged: listen(PUSH_CHANNELS.changed),
    // Nothing outside the page asks this host to open a path.
    onOpenPath: () => () => undefined,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      session.stop();
    },
  };
}
