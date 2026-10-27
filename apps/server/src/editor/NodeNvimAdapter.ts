import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  NvimAdapter,
  NvimSpawnError,
  type NvimProcess,
  type NvimSpawnInput,
} from "./NvimAdapter.ts";

/**
 * Grace before `SIGKILL`. Measured: a `SIGTERM` to the process id alone leaves a configured Neovim
 * alive, because lazy.nvim's update checker and file watchers keep libuv handles open. Signalling
 * the process group, as the spawner does, stops it; the escalation stays for plugins that do not.
 */
const KILL_GRACE = Duration.seconds(2);

/**
 * The real Neovim, spawned through Effect's process service.
 *
 * `stdin` on the handle is a `Sink`, and the RPC writer needs a plain call it
 * can make from a request. A queue bridges the two: writes land on the queue,
 * and one forked fiber drains it into the sink for as long as the scope lives.
 */
const spawnWith = Effect.fn(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  input: NvimSpawnInput,
) {
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
            // A missing binary is fixed by installing Neovim; a spawn failure is not, so the two
            // stay apart. Effect reports a missing executable as tag `NotFound` (no space): an
            // earlier `/ENOENT|not found/i` test matched neither and misreported every case.
            reason: isMissingBinary(cause) ? "binary-missing" : "spawn-failed",
            message: String(cause),
          }),
      ),
    );

  const outbound = yield* Queue.make<Uint8Array>();
  yield* Stream.fromQueue(outbound).pipe(
    Stream.run(child.stdin),
    Effect.ignoreCause,
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
        .kill({
          killSignal: (signal ?? "SIGTERM") as never,
          // The spawner already knows how to escalate, so this is one option
          // rather than a second implementation of it standing beside the
          // first and drifting from it.
          forceKillAfter: KILL_GRACE,
        })
        .pipe(Effect.ignoreCause),
  } satisfies NvimProcess;
});

/**
 * Reads the tag Effect sets first and the rendered string second. The string forms stay because
 * the platform layer may change how it renders, and this classifier already stopped matching once.
 */
const isMissingBinary = (cause: unknown): boolean => {
  const tag =
    typeof cause === "object" && cause !== null && "reason" in cause
      ? String((cause as { reason: unknown }).reason)
      : "";
  if (tag === "NotFound") return true;
  return /ENOENT|NotFound|not found/i.test(String(cause));
};

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
      return NvimAdapter.of({
        spawn: Effect.fn("NvimAdapter.spawn")(function (input) {
          return spawnWith(spawner, input);
        }),
      });
    }),
    // This module is already Node-specific, so it provides the spawner rather than pushing the
    // requirement onto every consumer; the server keeps platform imports out of its module scope.
  ).pipe(Layer.provide(NodeChildProcessSpawner.layer)),
};
