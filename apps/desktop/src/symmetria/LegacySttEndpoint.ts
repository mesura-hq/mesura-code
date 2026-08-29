/**
 * Keeps the destination-less socket explicit during the Shell rollout.
 *
 * Current Shell builds use DictationBroker and an immutable reserved target.
 * An older Shell can still discover this path, but Mesura must never accept its
 * text because the request has no thread identity. The endpoint therefore
 * returns one structured refusal and performs no renderer IPC or side effect.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import { createSttServer } from "./SttSocket.ts";
import {
  defaultRuntimeDir,
  prepareSocketPath,
  removeSocketPath,
  restrictSocketPath,
} from "./socketFiles.ts";
import { sttSocketPath } from "./sttSocketFiles.ts";
import { closeServer, listenOnPath } from "./unixSocket.ts";

const { logInfo, logWarning } = makeComponentLogger("symmetria-stt-legacy-endpoint");

export class LegacySttEndpoint extends Context.Service<
  LegacySttEndpoint,
  {
    /** The compatibility endpoint path, or none when it could not start. */
    readonly socketPath: Option.Option<string>;
  }
>()("@t3tools/desktop/symmetria/LegacySttEndpoint") {}

export const make = Effect.gen(function* () {
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const runSync = Effect.runSyncWith(context);
  const socketPath = yield* sttSocketPath(defaultRuntimeDir(), process.pid);

  const start = Effect.gen(function* () {
    yield* prepareSocketPath(socketPath);
    const server = createSttServer({
      deliver: async () => ({
        kind: "error",
        code: "reserved-session-required",
        detail: "Mesura requires a reserved dictation session",
      }),
      onError: (error) => {
        runSync(logWarning("legacy dictation endpoint error", { message: error.message }));
      },
    });
    server.on("error", (error) => {
      runSync(logWarning("legacy dictation endpoint server error", { message: error.message }));
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
    yield* logInfo("legacy dictation endpoint listening", { socketPath });
    return socketPath;
  });

  const bound = yield* start.pipe(
    Effect.map(Option.some),
    Effect.catch((cause) =>
      logWarning("legacy dictation endpoint did not start", {
        socketPath,
        message: cause instanceof Error ? cause.message : String(cause),
      }).pipe(Effect.as(Option.none<string>())),
    ),
  );

  return LegacySttEndpoint.of({ socketPath: bound });
});

export const layer = Layer.effect(LegacySttEndpoint, make);
