import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";

/**
 * The scratchpads are plain Markdown files the client edits through the regular file RPCs, so they
 * survive a crashed client, a lost socket or a restarted server. The server owns the folder; the
 * client only names a file inside it (`general.md`, `projects/<id>.md`, `threads/<id>.md`).
 */
export const scratchpadRootPath = (path: Path.Path, stateDir: string) =>
  path.join(stateDir, "scratchpads");

export const ensureScratchpadRoot = Effect.fn("Scratchpad.ensureRoot")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = scratchpadRootPath(path, config.stateDir);
  // The file write resolves the root with realpath, so the folder must exist before the first save.
  yield* fileSystem.makeDirectory(root, { recursive: true });
  return root;
});
