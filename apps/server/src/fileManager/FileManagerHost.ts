import * as NodeOS from "node:os";

import { createRegistry, type Dependencies } from "@symmetria/fm-main/ipc/register";
import {
  FileManagerError,
  type FileManagerEvent,
  type FileManagerEventsInput,
  type FileManagerHostInfo,
  type FileManagerMutateInput,
  type FileManagerQueryInput,
  type FileManagerReply,
  type FileManagerStreamItem,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { createHostOperations } from "./hostOperations.ts";
import { createWsIpcSurface } from "./wsIpcSurface.ts";

/**
 * The file manager's privileged half: runs the vendored registry (`@symmetria/fm-main`) over a
 * WebSocket-shaped surface. The registry's own decoders decode every payload; this service only
 * carries envelopes and sessions. Every method takes the RPC client id first, because a session
 * belongs to the connection that opened it and its id is private to that connection.
 */

/**
 * Where `previewRoute.ts` serves a granted preview token. The prefix lives
 * here, beside the `previewUrlFor` that mints the URL, so the two cannot drift.
 */
export const FILE_MANAGER_PREVIEW_ROUTE_PREFIX = "/api/file-manager/preview/";

/**
 * Bounds the pushes waiting for a session's client, so a slow client cannot grow the server.
 * The queue slides and drops the OLDEST pushes: every consumer coalesces (a later `changed`
 * re-lists the directory, a later progress tick supersedes earlier ones), and the UI never
 * requests the order-sensitive streamed listing.
 */
const SESSION_EVENT_CAPACITY = 1024;

export class FileManagerHost extends Context.Service<
  FileManagerHost,
  {
    /** What the file manager's panel needs from its host at first render. */
    readonly host: Effect.Effect<FileManagerHostInfo>;
    /** A read channel, for a session this client opened. */
    readonly query: (
      clientId: string,
      input: FileManagerQueryInput,
    ) => Effect.Effect<FileManagerReply, FileManagerError>;
    /** A write channel, for a session this client opened. */
    readonly mutate: (
      clientId: string,
      input: FileManagerMutateInput,
    ) => Effect.Effect<FileManagerReply, FileManagerError>;
    /**
     * Open a session for the scope's lifetime and hand back its pushes. The
     * session ends with the scope: closing it releases every watch and stream
     * the session started, through the registry's own per-sender tables.
     */
    readonly openSession: (
      clientId: string,
      input: FileManagerEventsInput,
    ) => Effect.Effect<Stream.Stream<FileManagerStreamItem>, FileManagerError, Scope.Scope>;
    /**
     * `openSession` as one stream, which is what the RPC carries. Its first
     * item is the ready marker: from then on the session answers queries.
     */
    readonly events: (
      clientId: string,
      input: FileManagerEventsInput,
    ) => Stream.Stream<FileManagerStreamItem, FileManagerError>;
    /** How many sessions hold resources right now; the leak check. */
    readonly trackedSessions: Effect.Effect<number>;
  }
>()("t3/fileManager/FileManagerHost") {}

/**
 * What a host may override in the registry's dependencies. Production overrides nothing, so it
 * shares the standalone file manager's bookmark and listing stores and reaches the real desktop.
 * Tests confine the stores to a temporary directory and pass operations that never run `gio` or
 * `xdg-open`.
 */
export type HostOverrides = Pick<
  Dependencies,
  "bookmarksPath" | "listingOptionsPath" | "operations"
>;

/**
 * The registry's dependencies. The operations act on this host's filesystem
 * and desktop; the clipboard is left out on purpose, because the browser owns
 * it (the registry answers that channel as unavailable); the search pool is
 * left out until Mesura Code has a finder of its own.
 */
function hostDependencies(overrides: HostOverrides): Dependencies {
  return {
    ...overrides,
    // Root-relative on purpose: the server does not know the origin a client
    // reaches it by. The browser bridge resolves it against the environment's
    // HTTP base URL, the way asset URLs are resolved.
    previewUrlFor: (token) => `${FILE_MANAGER_PREVIEW_ROUTE_PREFIX}${token}`,
    operations: overrides.operations ?? createHostOperations(),
  };
}

export const make = Effect.fn(function* (overrides: HostOverrides = {}) {
  const transport = createWsIpcSurface();
  const registry = createRegistry(transport.surface, hostDependencies(overrides));
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));

  const invoke = (clientId: string, sessionId: string, channel: string, payload: unknown) =>
    Effect.tryPromise({
      try: () => transport.invoke({ owner: clientId, sessionId }, channel, payload),
      catch: (cause) =>
        new FileManagerError({
          sessionId,
          channel,
          message: `The file manager host failed on ${channel}.`,
          cause,
        }),
    });

  const openSession: FileManagerHost["Service"]["openSession"] = Effect.fn(function* (
    clientId,
    { sessionId },
  ) {
    const key = { owner: clientId, sessionId };
    const queue = yield* Queue.sliding<FileManagerEvent>(SESSION_EVENT_CAPACITY);
    // Acquired and released under the caller's scope, so an interruption
    // between opening and streaming cannot leave the session behind.
    const handle = yield* Effect.acquireRelease(
      Effect.sync(() =>
        transport.openSession(key, (event) => {
          Queue.offerUnsafe(queue, event);
        }),
      ),
      // Only a session this acquire opened is closed on release: a refused
      // open (`null`) must leave the session that refused it untouched.
      (opened) =>
        opened === null
          ? Effect.void
          : Effect.sync(() => {
              const closed = transport.closeSession(key);
              if (closed !== null) registry.disposeSender(closed);
            }),
    );
    if (handle === null) {
      return yield* new FileManagerError({
        sessionId,
        message: `File manager session '${sessionId}' is already open.`,
      });
    }
    // The marker follows the acquire, so a client that waits for it can
    // never be refused as `session not open`.
    return Stream.concat(
      Stream.succeed<FileManagerStreamItem>({ ready: true }),
      Stream.fromQueue(queue),
    );
  });

  return FileManagerHost.of({
    host: Effect.sync(() => ({ homePath: NodeOS.homedir() })),
    query: Effect.fn("FileManagerHost.query")(function (clientId, input) {
      return invoke(clientId, input.sessionId, input.channel, input.payload);
    }),
    mutate: Effect.fn("FileManagerHost.mutate")(function (clientId, input) {
      return invoke(clientId, input.sessionId, input.channel, input.payload);
    }),
    openSession,
    events: (clientId, input) => Stream.unwrap(openSession(clientId, input)),
    trackedSessions: Effect.sync(() => registry.trackedWindows()),
  });
});

export const layer = Layer.effect(FileManagerHost, make());

/** The service over confined stores, for tests. */
export const layerWith = (overrides: HostOverrides) =>
  Layer.effect(FileManagerHost, make(overrides));
