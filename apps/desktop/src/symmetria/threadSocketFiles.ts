/**
 * Where the thread-publisher socket lives.
 *
 * A name of its own, deliberately NOT a parameterisation of `sttSocketPath`.
 * Symmetria Shell's `stt-inject.sh` builds the dictation path by hand as
 * `symmetria-mesura-<pid>.sock`, so that string is a published interface with
 * a consumer outside this repository: generalising the builder would invite an
 * edit that renames it and breaks dictation with nothing here to catch it.
 *
 * Two sockets, two names, one shared set of filesystem operations in
 * `socketFiles.ts`.
 */
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

export const threadSocketPath = Effect.fn("symmetria.threads.socketPath")(function* (
  runtimeDir: string,
  pid: number,
) {
  const path = yield* Path.Path;
  return path.join(runtimeDir, `symmetria-mesura-threads-${pid}.sock`);
});
