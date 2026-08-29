import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

/** The persistent session socket. The rollout keeps the legacy STT socket beside it. */
export const dictationSocketPath = Effect.fn("symmetria.dictation.socketPath")(function* (
  runtimeDir: string,
  pid: number,
) {
  const path = yield* Path.Path;
  return path.join(runtimeDir, `symmetria-mesura-dictation-${pid}.sock`);
});
