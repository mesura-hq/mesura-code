import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/**
 * Spawning Neovim behind a service, like `PtyAdapter`, so sessions are testable without one.
 * It is a byte pipe, not a pseudo-terminal: embedded Neovim speaks msgpack on stdin and stdout,
 * and line discipline would corrupt that binary protocol.
 */

export class NvimSpawnError extends Schema.TaggedError<NvimSpawnError>()("NvimSpawnError", {
  executable: Schema.String,
  reason: Schema.Literals(["binary-missing", "spawn-failed"]),
  message: Schema.String,
}) {}

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
