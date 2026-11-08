/**
 * Where the thread-publisher socket lives.
 *
 * The name is a published interface: Symmetria Shell's agent bar connects to
 * it from outside this repository, so renaming it breaks the bar with nothing
 * here to catch it. The filesystem operations live in `socketFiles.ts`.
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
