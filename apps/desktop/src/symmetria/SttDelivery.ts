/**
 * Wires the dictation socket to the window.
 *
 * A thin shell on purpose: parsing lives in `sttProtocol.ts`, the connection in
 * `SttSocket.ts`, the filesystem in `socketFiles.ts` and the request
 * correlation in `sttBridge.ts` — each testable in its own idiom. This module
 * only supplies the three things that need the application: where the socket
 * goes, how to reach the window, and how the window answers back.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { RESOLVE_STT_DELIVER_CHANNEL, STT_DELIVER_CHANNEL } from "../ipc/channels.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import { createSttBridge } from "./sttBridge.ts";
import { createSttServer } from "./SttSocket.ts";
import { parseRendererOutcome } from "./sttProtocol.ts";
import type { SttOutcome } from "./sttProtocol.ts";
import {
  defaultRuntimeDir,
  prepareSocketPath,
  removeSocketPath,
  restrictSocketPath,
} from "./socketFiles.ts";
import { sttSocketPath } from "./sttSocketFiles.ts";
import { closeServer, listenOnPath } from "./unixSocket.ts";

const { logInfo, logWarning } = makeComponentLogger("symmetria-stt-delivery");

/**
 * How long the window gets before the shell is told there was nowhere to put
 * the words. The shell has its own socket timeout above this one; answering
 * late is no better than answering `no-conversation`, because it keeps no
 * clipboard copy either way.
 */
const WINDOW_DEADLINE = Duration.seconds(5);

export class SttDelivery extends Context.Service<
  SttDelivery,
  {
    /** The bound path, or none when the socket could not be started. */
    readonly socketPath: Option.Option<string>;
  }
>()("@t3tools/desktop/symmetria/SttDelivery") {}

export const make = Effect.gen(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const ipc = yield* DesktopIpc.DesktopIpc;
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const runSync = Effect.runSyncWith(context);
  const runPromise = Effect.runPromiseWith(context);

  // A counter rather than a UUID. The id only has to distinguish requests in
  // flight inside this process; it never leaves the machine, so randomness
  // would buy nothing and would need the Random service to be injected here.
  let requestCounter = 0;

  const bridge = createSttBridge({
    newRequestId: () => `stt-${(requestCounter += 1)}`,
    send: (message) => {
      // Synchronous because the bridge answers `no-conversation` on the spot
      // when there is no window, and reading the current window is a Ref read.
      const target = runSync(electronWindow.currentMainOrFirst);
      if (Option.isNone(target)) return false;
      target.value.webContents.send(STT_DELIVER_CHANNEL, message);
      return true;
    },
  });

  yield* ipc.handle({
    channel: RESOLVE_STT_DELIVER_CHANNEL,
    handler: (raw: unknown) =>
      Effect.sync(() => {
        const answer = parseRendererOutcome(raw);
        // An unrecognised shape is dropped rather than thrown: the deadline
        // still answers the shell, and a throw inside an IPC handler costs
        // more than this feature.
        if (answer !== null) bridge.resolve(answer.requestId, answer.outcome);
      }),
  });

  const socketPath = yield* sttSocketPath(defaultRuntimeDir(), process.pid);

  const start = Effect.gen(function* () {
    yield* prepareSocketPath(socketPath);

    const server = createSttServer({
      deliver: (request) => {
        const dispatch = bridge.deliver(request);
        return runPromise(
          Effect.promise(() => dispatch.answered).pipe(
            Effect.timeoutOption(WINDOW_DEADLINE),
            Effect.map((answered): SttOutcome => {
              if (Option.isSome(answered)) return answered.value;
              // Abandon THIS request only. The pending map is shared by every
              // dictation in flight, so wiping it here would answer
              // `no-conversation` to one the window was still about to serve.
              bridge.abandonOne(dispatch.requestId);
              return { kind: "no-conversation" };
            }),
          ),
        );
      },
      onError: (error) => {
        runSync(logWarning("dictation socket error", { message: error.message }));
      },
    });

    // A `net.Server` emitting 'error' with no listener THROWS, and this one
    // lives for the whole session — so an accept-time failure long after
    // startup would take the entire main process down over the dictation
    // feature. `listenOnPath` installs a listener for the bind only and removes
    // it again, which leaves exactly that gap.
    server.on("error", (error) => {
      runSync(logWarning("dictation socket server error", { message: error.message }));
    });

    yield* Effect.acquireRelease(
      Effect.tryPromise(() => listenOnPath(server, socketPath)),
      () =>
        Effect.promise(async () => {
          bridge.abandonAll();
          await closeServer(server);
        }).pipe(Effect.andThen(removeSocketPath(socketPath)), Effect.orDie),
    );

    yield* restrictSocketPath(socketPath);
    yield* logInfo("dictation socket listening", { socketPath });
    return socketPath;
  });

  const bound = yield* start.pipe(
    Effect.map((path) => Option.some(path)),
    // Best-effort. A bind failure must never block startup: dictation is
    // simply absent until the next launch and the shell keeps its clipboard
    // fallback.
    Effect.catch((error) =>
      logWarning("dictation socket did not start", {
        socketPath,
        message: error instanceof Error ? error.message : String(error),
      }).pipe(Effect.as(Option.none<string>())),
    ),
  );

  return SttDelivery.of({ socketPath: bound });
});

export const layer = Layer.effect(SttDelivery, make);
