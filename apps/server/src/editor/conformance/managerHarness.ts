// @effect-diagnostics nodeBuiltinImport:off - writes a scratch configuration for a real Neovim.
/**
 * A manager over a real Neovim, and a recorder for its attach stream, for the
 * conformance files that drive `EditorSessionManager` the way the websocket
 * layer does.
 *
 * @module managerHarness
 */
import * as NodeOS from "node:os";
import type { EditorSessionEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";

import * as EditorSessionManager from "../Manager.ts";

/**
 * The developer's configuration when `MESURA_NVIM_CONFIG_DIR` names one, as
 * `realConfig.test.ts` reads it; otherwise `null`.
 */
export const realConfigDirectory = (() => {
  const raw = process.env["MESURA_NVIM_CONFIG_DIR"];
  if (raw === undefined || raw.trim() === "") return null;
  return raw.startsWith("~/") ? `${NodeOS.homedir()}/${raw.slice(2)}` : raw;
})();

/**
 * A manager whose Neovim reads the developer's configuration when one is
 * named, and otherwise a directory under `root` with an empty `init.lua`, so
 * the real launch path runs in continuous integration too.
 */
export const makeScratchManager = Effect.fn(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  if (realConfigDirectory !== null) {
    return yield* EditorSessionManager.makeWithOptions({
      configDirectory: realConfigDirectory,
      stateDir: `${root}/state`,
    });
  }
  const configDirectory = `${root}/config`;
  yield* fs.makeDirectory(configDirectory, { recursive: true });
  yield* fs.writeFileString(`${configDirectory}/init.lua`, "-- a configuration\n");
  return yield* EditorSessionManager.makeWithOptions({
    configDirectory,
    stateDir: `${root}/state`,
    homeDir: root,
  });
});

/**
 * Records every chunk the attachment yields, in order, as the RPC server would
 * pull them: the next chunk is pulled the moment the last one is recorded.
 */
export const recordChunks = Effect.fn(function* (
  manager: EditorSessionManager.EditorSessionManager["Service"],
  threadId: string,
) {
  const chunks: Array<ReadonlyArray<EditorSessionEvent>> = [];
  const watchers = new Set<() => void>();
  const attached = yield* Deferred.make<void>();
  yield* Stream.runForEachArray(
    EditorSessionManager.attachEventStream(manager, { threadId }),
    (chunk) =>
      Effect.gen(function* () {
        chunks.push(chunk);
        for (const watcher of watchers) watcher();
        yield* Deferred.succeed(attached, undefined);
      }),
  ).pipe(Effect.forkScoped);
  yield* Deferred.await(attached);

  /** Waits until some event recorded at or after chunk `from` satisfies `matches`. */
  const waitFor = Effect.fn(function* (matches: (event: EditorSessionEvent) => boolean, from = 0) {
    const seen = yield* Deferred.make<void>();
    const check = () => {
      if (chunks.slice(from).some((chunk) => chunk.some(matches))) {
        Deferred.doneUnsafe(seen, Effect.void);
      }
    };
    watchers.add(check);
    check();
    yield* Deferred.await(seen);
    watchers.delete(check);
  });

  return { chunks, waitFor };
});
