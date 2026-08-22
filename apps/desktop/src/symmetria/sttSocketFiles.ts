/**
 * The filesystem side of the dictation socket.
 *
 * Split out from `SttSocket.ts` so the socket stays plain `node:net` and this
 * part uses Effect's `FileSystem` and `Path`, which the repository requires
 * over the node builtins. It is also the only part with acceptance criteria a
 * test can reach: where the node lives, that nothing else can write to it, and
 * that it does not survive the process.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Owner-only. Anything able to write to this socket can put text in the
 * composer and send it, and `listen` creates the node with the process umask
 * applied, which is a default rather than a guarantee.
 */
export const SOCKET_MODE = 0o600;

/** Owner-only for the directory too, for the tmpdir fallback case. */
export const DIRECTORY_MODE = 0o700;

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

/**
 * Makes the path bindable: the directory exists, and no stale node is sitting
 * there. A socket left by a process that was killed rather than stopped would
 * fail the bind with EADDRINUSE.
 */
export const prepareSocketPath = Effect.fn("symmetria.stt.prepareSocketPath")(function* (
  socketPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // `mode` applies only when this call creates the directory, so an existing
  // `$XDG_RUNTIME_DIR` is left exactly as the session manager made it while the
  // world-writable-tmpdir fallback gets an owner-only parent of its own.
  yield* fs.makeDirectory(path.dirname(socketPath), { recursive: true, mode: DIRECTORY_MODE });
  yield* removeSocketPath(socketPath);
});

/** Restricts the bound node to the owning user. Call after `listen` resolves. */
export const restrictSocketPath = Effect.fn("symmetria.stt.restrictSocketPath")(function* (
  socketPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.chmod(socketPath, SOCKET_MODE);
});

/** Removing a path that is not there is the ordinary case, not a failure. */
export const removeSocketPath = Effect.fn("symmetria.stt.removeSocketPath")(function* (
  socketPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(socketPath, { force: true });
});
