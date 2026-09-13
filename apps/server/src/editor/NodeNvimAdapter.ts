import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  NvimAdapter,
  NvimSpawnError,
  type NvimProcess,
  type NvimSpawnInput,
} from "./NvimAdapter.ts";

/**
 * How long Neovim gets to stop on its own before it is killed outright.
 *
 * Measured, not defensive: sent a plain `SIGTERM` on its own process id, a
 * Neovim with a UI attached and the developer's configuration loaded prints
 * `Caught deadly signal` and then stays alive — lazy.nvim's update checker and
 * its change-detection file watchers leave libuv handles open, and the exit
 * path never finishes. The same Neovim with `--clean`, or with those two
 * features off, exits in a millisecond.
 *
 * In practice this grace has not been seen to elapse, because the spawner
 * signals the whole process group rather than one process id, and that does
 * stop it. The escalation stays for the case where it does not: a session that
 * ends has to be able to end whatever a plugin is doing.
 */
const KILL_GRACE = Duration.seconds(2);

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
              // Neovim, and it deserves to be told apart from a real failure:
              // one is fixed by installing Neovim and the other is not fixed
              // by anything the developer can reach from Settings.
              //
              // Measured, because the first version of this could never say
              // so. Effect reports a missing executable as a `PlatformError`
              // whose tag is `NotFound` — one word, no space — and the test
              // was `/ENOENT|not found/i`, which matches neither. Every
              // missing binary came back as a plain spawn failure, and the
              // developer was told the one thing they could fix was not
              // fixable.
              reason: isMissingBinary(cause) ? "binary-missing" : "spawn-failed",
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
          .kill({
            killSignal: (signal ?? "SIGTERM") as never,
            // The spawner already knows how to escalate, so this is one option
            // rather than a second implementation of it standing beside the
            // first and drifting from it.
            forceKillAfter: KILL_GRACE,
          })
          .pipe(Effect.catchCause(() => Effect.void)),
    } satisfies NvimProcess;
  });

/**
 * Whether a spawn failure means the binary is not there.
 *
 * Reads the error's own tag first and the rendered string second. The tag is
 * what Effect actually sets; the string forms are kept because the platform
 * layer is free to change how it renders, and a classifier that silently
 * stops matching is exactly what this already did once.
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
      return NvimAdapter.of({ spawn: (input) => spawnWith(spawner, input) });
    }),
    // The spawner is provided here, not left for the caller. The `Node` in
    // this module's name has already committed to a platform, so a layer that
    // still asked for one would make every consumer carry a requirement this
    // file has an answer for — and the server deliberately keeps platform
    // imports out of its own module scope.
  ).pipe(Layer.provide(NodeChildProcessSpawner.layer)),
};
