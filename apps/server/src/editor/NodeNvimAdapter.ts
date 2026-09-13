import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  NvimAdapter,
  NvimSpawnError,
  type NvimProcess,
  type NvimSpawnInput,
} from "./NvimAdapter.ts";

/**
 * The real Neovim, spawned through Effect's process service.
 *
 * `stdin` on the handle is a `Sink`, and the RPC writer needs a plain call it
 * can make from a request. A queue bridges the two: writes land on the queue,
 * and one forked fiber drains it into the sink for as long as the scope lives.
 */
const spawnWith = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  input: NvimSpawnInput,
) =>
  Effect.gen(function* () {
    const child = yield* spawner
      .spawn(
        ChildProcess.make(input.executable, [...input.args], {
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.env === undefined ? {} : { env: input.env }),
          shell: false,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new NvimSpawnError({
              executable: input.executable,
              // A missing binary is the ordinary case on a machine with no
              // Neovim, and it deserves to be told apart from a real failure.
              reason: /ENOENT|not found/i.test(String(cause)) ? "binary-missing" : "spawn-failed",
              message: String(cause),
            }),
        ),
      );

    const outbound = yield* Queue.make<Uint8Array>();
    yield* Stream.fromQueue(outbound).pipe(
      Stream.run(child.stdin),
      Effect.catchCause(() => Effect.void),
      Effect.forkScoped,
    );

    return {
      pid: Number(child.pid),
      write: (bytes: Uint8Array) => {
        Queue.offerUnsafe(outbound, bytes);
      },
      stdout: child.stdout,
      stderr: child.stderr.pipe(Stream.decodeText(), Stream.splitLines),
      exitCode: child.exitCode.pipe(
        Effect.map((code) => Number(code)),
        Effect.catchCause(() => Effect.succeed(null)),
      ),
      kill: (signal?: string) =>
        child
          .kill(signal === undefined ? undefined : { killSignal: signal as never })
          .pipe(Effect.catchCause(() => Effect.void)),
    } satisfies NvimProcess;
  });

export const NodeNvimAdapter = {
  /**
   * The spawner is resolved once, when the layer is built, so `spawn` itself
   * needs nothing in context but a `Scope` — which is what the service promises
   * its callers.
   */
  layer: Layer.effect(
    NvimAdapter,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return NvimAdapter.of({ spawn: (input) => spawnWith(spawner, input) });
    }),
  ),
};
