/**
 * Serves the projected thread list to Symmetria Shell; it must never fail startup.
 * The renderer pushes its read model over `PUBLISH_THREADS_CHANNEL`; a main-process subscription would duplicate it.
 * State exists only while a renderer is alive, so a socket peer gets the last known state:
 * a stale bar beats an empty one, because a consumer cannot tell "no threads" from "nobody told me".
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import { PUBLISH_THREADS_CHANNEL } from "../ipc/channels.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import {
  defaultRuntimeDir,
  prepareSocketPath,
  removeSocketPath,
  restrictSocketPath,
} from "./socketFiles.ts";
import { createFeed, parseFeedPush } from "./threadFeed.ts";
import { threadSocketPath } from "./threadSocketFiles.ts";
import { createThreadStreamServer, type ThreadStreamServer } from "./threadStream.ts";
import { closeServer, listenOnPath } from "./unixSocket.ts";

const { logInfo, logWarning } = makeComponentLogger("symmetria-thread-publisher");

export class ThreadPublisher extends Context.Service<
  ThreadPublisher,
  {
    /** The bound path, or none when the socket could not be started. */
    readonly socketPath: Option.Option<string>;
  }
>()("@t3tools/desktop/symmetria/ThreadPublisher") {}

export const make = Effect.gen(function* () {
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const runSync = Effect.runSyncWith(context);
  const ipc = yield* DesktopIpc.DesktopIpc;

  const feed = createFeed();
  const socketPath = yield* threadSocketPath(defaultRuntimeDir(), process.pid);

  const start = Effect.gen(function* () {
    yield* prepareSocketPath(socketPath);

    const server = createThreadStreamServer({
      // Synchronous because a connection callback cannot await, and the feed
      // is a pure synchronous value. Writing the snapshot one tick late would
      // mean the peer had already been told the stream opened.
      snapshot: () => feed.snapshot(),
      onError: (error) => {
        runSync(logWarning("thread socket connection error", { message: error.message }));
      },
    });

    // A `net.Server` 'error' with no listener throws and would take down the main process.
    // `listenOnPath` listens only during the bind, so accept-time errors need this listener.
    server.on("error", (error) => {
      runSync(logWarning("thread socket server error", { message: error.message }));
    });

    yield* Effect.acquireRelease(
      Effect.tryPromise(() => listenOnPath(server, socketPath)),
      () =>
        Effect.promise(() => closeServer(server)).pipe(
          Effect.andThen(removeSocketPath(socketPath)),
          Effect.orDie,
        ),
    );

    yield* restrictSocketPath(socketPath);
    yield* logInfo("thread socket listening", { socketPath });
    return { socketPath, server };
  });

  const started = yield* start.pipe(
    Effect.asSome,
    // Best-effort: a bind failure must never
    // block startup. The bar is simply absent until the next launch, and every
    // other surface of the application is unaffected.
    Effect.catch((error) =>
      logWarning("thread socket did not start", {
        socketPath,
        message: error instanceof Error ? error.message : String(error),
      }).pipe(Effect.as(Option.none<{ socketPath: string; server: ThreadStreamServer }>())),
    ),
  );

  // Registered even when the bind failed: an unhandled `invoke` channel rejects in the
  // renderer, which would log an error on every push. Frames are then dropped, not queued.
  // Untested: both bind-failure decisions need a socket path that cannot bind.
  yield* ipc.handle({
    channel: PUBLISH_THREADS_CHANNEL,
    handler: (raw: unknown) =>
      Effect.sync(() => {
        const push = parseFeedPush(raw);
        // A malformed push publishes nothing rather than half a world. It is
        // dropped rather than thrown: a throw inside an IPC handler costs more
        // than this feature.
        if (push === null) return;
        const frames = feed.accept(push.generation, push.readModel);
        if (Option.isNone(started)) return;
        for (const frame of frames) started.value.server.broadcast(frame.line);
      }),
  });

  return ThreadPublisher.of({
    socketPath: Option.map(started, (running) => running.socketPath),
  });
});

export const layer = Layer.effect(ThreadPublisher, make);
