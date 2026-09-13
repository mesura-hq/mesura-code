import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/**
 * Spawning Neovim, behind a service.
 *
 * The same shape as `PtyAdapter`: the thing that talks to the operating system
 * is a service so the sessions above it can be built and tested without one.
 * Unlike a terminal this is a byte pipe rather than a pseudo-terminal — Neovim
 * embedded speaks msgpack on stdin and stdout, and a pseudo-terminal would put
 * line discipline in the middle of a binary protocol.
 */

export class NvimSpawnError extends Data.TaggedError("NvimSpawnError")<{
  readonly executable: string;
  readonly reason: "binary-missing" | "spawn-failed";
  readonly message: string;
}> {}

export interface NvimProcess {
  readonly pid: number;
  /** Writes to Neovim's stdin. Synchronous so the RPC writer stays simple. */
  write(bytes: Uint8Array): void;
  readonly stdout: Stream.Stream<Uint8Array, unknown>;
  /** Neovim's own complaints, which are the only clue when a config fails. */
  readonly stderr: Stream.Stream<string, unknown>;
  readonly exitCode: Effect.Effect<number | null>;
  readonly kill: (signal?: string) => Effect.Effect<void>;
}

export interface NvimSpawnInput {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
}

export class NvimAdapter extends Context.Service<
  NvimAdapter,
  {
    readonly spawn: (
      input: NvimSpawnInput,
    ) => Effect.Effect<NvimProcess, NvimSpawnError, Scope.Scope>;
  }
>()("t3/editor/NvimAdapter") {}
