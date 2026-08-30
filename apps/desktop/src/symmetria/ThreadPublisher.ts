/**
 * Serves the projected thread list to Symmetria Shell.
 *
 * A thin shell: the projection lives in
 * `threadProjection.ts`, the socket in `threadStream.ts`, the filesystem in
 * `socketFiles.ts` and the binding in `unixSocket.ts`. This module supplies
 * only what needs the application — where the socket goes, what state is
 * current, and that the whole thing must never be able to fail startup.
 *
 * **The state is pushed in from the renderer over IPC**, on
 * `PUBLISH_THREADS_CHANNEL`. The renderer already holds the fork's read model
 * and already renders it, so a second subscription in the main process would be
 * a duplicate with its own authentication. `threadFeed.ts` turns that series of
 * pushes into the ordered stream, and this module only carries frames from it
 * to the socket.
 *
 * That choice has one consequence worth stating where somebody will meet it:
 * **the publisher only has state while a renderer is alive.** It therefore
 * serves the LAST KNOWN state rather than nothing when none is attached — a
 * shell showing a stale bar is better than one showing an empty bar, because a
 * consumer cannot tell "no threads" from "nobody has told me".
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

    // A `net.Server` emitting 'error' with no listener THROWS, and this one
    // lives for the whole session — so an accept-time failure long after
    // startup would take the entire main process down over the bar.
    // `listenOnPath` installs a listener for the bind only and removes it
    // again, which leaves exactly that gap. Same reasoning, same shape, as the
    // dictation socket's.
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
    Effect.map((running) => Option.some(running)),
    // Best-effort, for the same reason dictation is: a bind failure must never
    // block startup. The bar is simply absent until the next launch, and every
    // other surface of the application is unaffected.
    Effect.catch((error) =>
      logWarning("thread socket did not start", {
        socketPath,
        message: error instanceof Error ? error.message : String(error),
      }).pipe(Effect.as(Option.none<{ socketPath: string; server: ThreadStreamServer }>())),
    ),
  );

  // ⚠ UNTESTED, and named here rather than left as a gap of unknown shape.
  // This module has no test of its own: the two things it decides — that the
  // handler is registered even when the bind failed, and that frames are
  // dropped rather than queued in that state — would need the whole Effect
  // layer stood up with a fake IPC and a fake socket. Everything the handler
  // CALLS is covered (`parseFeedPush`, `createFeed`, `projectReadModel`), so
  // what is uncovered is this wiring and nothing else.
  //
  // Registered even when the bind failed. The renderer must not have to know
  // whether a socket came up, and an unhandled `invoke` channel rejects in the
  // renderer rather than being ignored — which would turn an absent bar into a
  // console full of errors on every push.
  yield* ipc.handle({
    channel: PUBLISH_THREADS_CHANNEL,
    handler: (raw: unknown) =>
      Effect.sync(() => {
        const push = parseFeedPush(raw);
        // A malformed push publishes nothing rather than half a world. It is
        // dropped rather than thrown for the reason the dictation handler
        // gives: a throw inside an IPC handler costs more than this feature.
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
