/**
 * Where the dictation socket lives.
 *
 * The generic half — creating the directory, clearing a stale node, restricting
 * the bound file — moved to `socketFiles.ts` when the thread publisher became a
 * second socket in this process. What is left is the one thing that is about
 * dictation specifically: its name.
 */
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

/**
 * A prefix of our own rather than the editor's `symmetria-ide-agents-`. Both
 * applications run at the same time, so a shared prefix would make them
 * indistinguishable by path, and their payloads differ — the editor addresses
 * an agent slot that does not exist here.
 */
export const sttSocketPath = Effect.fn("symmetria.stt.socketPath")(function* (
  runtimeDir: string,
  pid: number,
) {
  const path = yield* Path.Path;
  return path.join(runtimeDir, `symmetria-mesura-${pid}.sock`);
});
