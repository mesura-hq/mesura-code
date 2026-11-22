import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";

/**
 * The scratchpads are plain Markdown files the client edits through the regular file RPCs, so they
 * survive a crashed client, a lost socket or a restarted server. The server owns the folder; the
 * client only names a file inside it (`general.md`, `projects/<id>.md`, `threads/<id>.md`).
 */
const scratchpadRootPath = (path: Path.Path, stateDir: string) =>
  path.join(stateDir, "scratchpads");

/**
 * The folder file writes may use, or null. Only a real directory named `scratchpads` directly in
 * the real state directory qualifies: a symlink there would hand writes to wherever it points,
 * the state directory itself included.
 */
export const canonicalScratchpadRoot = Effect.fn("Scratchpad.canonicalRoot")(
  function* (fileSystem: FileSystem.FileSystem, path: Path.Path, stateDir: string) {
    const realStateDir = yield* fileSystem.realPath(stateDir);
    const root = scratchpadRootPath(path, stateDir);
    const realRoot = yield* fileSystem.realPath(root);
    if (realRoot !== scratchpadRootPath(path, realStateDir)) return null;
    return (yield* fileSystem.stat(realRoot)).type === "Directory" ? realRoot : null;
  },
  Effect.orElseSucceed(() => null),
);

/** The folder, created when missing; null when it cannot be created or is not a real directory. */
export const ensureScratchpadRoot = Effect.fn("Scratchpad.ensureRoot")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // The file write resolves the root with realpath, so the folder must exist before the first save.
  yield* fileSystem
    .makeDirectory(scratchpadRootPath(path, config.stateDir), { recursive: true })
    .pipe(Effect.ignore);
  return yield* canonicalScratchpadRoot(fileSystem, path, config.stateDir);
});
