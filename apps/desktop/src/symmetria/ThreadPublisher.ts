/**
 * Serves the projected thread list to Symmetria Shell.
 *
 * A thin shell, like `SttDelivery.ts` next door: the projection lives in
 * `threadProjection.ts`, the socket in `threadStream.ts`, the filesystem in
 * `socketFiles.ts` and the binding in `unixSocket.ts`. This module supplies
 * only what needs the application — where the socket goes, what state is
 * current, and that the whole thing must never be able to fail startup.
 *
 * **The state is held here and pushed in from outside.** `publish` is the seam:
 * the renderer already holds the fork's read model and already renders it, so
 * it forwards a projection over IPC and this republishes. That is a deliberate
 * choice over a second authenticated subscription from the main process, and it
 * has one consequence worth stating where somebody will meet it: **the
 * publisher only has state while a renderer is alive.** It therefore serves the
 * LAST KNOWN state rather than nothing when no renderer is attached — a shell
 * showing a stale bar is better than one showing an empty bar, and the bar has
 * no way to tell "no threads" from "nobody told me" if this served an empty
 * snapshot.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import {
  defaultRuntimeDir,
  prepareSocketPath,
  removeSocketPath,
  restrictSocketPath,
} from "./socketFiles.ts";
import { projectReadModel, type ProjectableReadModel } from "./threadProjection.ts";
import { threadSocketPath } from "./threadSocketFiles.ts";
import { createThreadStreamServer } from "./threadStream.ts";
import { closeServer, listenOnPath } from "./unixSocket.ts";

const { logInfo, logWarning } = makeComponentLogger("symmetria-thread-publisher");

/**
 * What a peer receives before anything has been published.
 *
 * Revision zero and empty lists, which is a true statement rather than a
 * placeholder: the position is the one nothing has advanced past, and there
 * genuinely are no threads this process knows of yet.
 */
const EMPTY_READ_MODEL: ProjectableReadModel = {
  snapshotSequence: 0,
  projects: [],
  threads: [],
};

export class ThreadPublisher extends Context.Service<
  ThreadPublisher,
  {
    /** The bound path, or none when the socket could not be started. */
    readonly socketPath: Option.Option<string>;
    /** Replaces the state every future peer will be handed on connect. */
    readonly publish: (readModel: ProjectableReadModel) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/symmetria/ThreadPublisher") {}

export const make = Effect.gen(function* () {
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const runSync = Effect.runSyncWith(context);

  const held = yield* Ref.make(EMPTY_READ_MODEL);
  const socketPath = yield* threadSocketPath(defaultRuntimeDir(), process.pid);

  const start = Effect.gen(function* () {
    yield* prepareSocketPath(socketPath);

    const server = createThreadStreamServer({
      // Synchronous because a connection callback cannot await: reading a Ref
      // is a pure read, and the alternative is writing the snapshot one tick
      // late, after the peer has already been told the stream opened.
      snapshot: () => projectReadModel(runSync(Ref.get(held))),
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
    return socketPath;
  });

  const bound = yield* start.pipe(
    Effect.map((path) => Option.some(path)),
    // Best-effort, for the same reason dictation is: a bind failure must never
    // block startup. The bar is simply absent until the next launch, and every
    // other surface of the application is unaffected.
    Effect.catch((error) =>
      logWarning("thread socket did not start", {
        socketPath,
        message: error instanceof Error ? error.message : String(error),
      }).pipe(Effect.as(Option.none<string>())),
    ),
  );

  return ThreadPublisher.of({
    socketPath: bound,
    publish: (readModel) => Ref.set(held, readModel),
  });
});

export const layer = Layer.effect(ThreadPublisher, make);
