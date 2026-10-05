/**
 * The filesystem side of a Unix socket this process owns.
 *
 * Nothing here knows what travels over the socket: it is where the node lives,
 * that nothing else can write to it, and that it does not survive the process.
 *
 * Effect's `FileSystem` and `Path` rather than the node builtins, which the
 * repository's diagnostics enforce at typecheck — that requirement is why this
 * concern is a module of its own rather than part of the `node:net` side.
 */
// @effect-diagnostics nodeBuiltinImport:off - `os.tmpdir()` has no Effect
// service, and the fallback below is precisely about which directory the
// operating system offers when the session manager gave us none.
import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Owner-only. Anything able to connect to the thread socket reads the whole
 * projected thread list, and `listen` creates the node with the process umask
 * applied — which is a default rather than a guarantee.
 */
export const SOCKET_MODE = 0o600;

/** Owner-only for the directory too, for the tmpdir fallback case. */
export const DIRECTORY_MODE = 0o700;

/**
 * Makes the path bindable: the directory exists, and no stale node is sitting
 * there. A socket left by a process that was killed rather than stopped would
 * fail the bind with EADDRINUSE.
 */
export const prepareSocketPath = Effect.fn("symmetria.socket.prepareSocketPath")(function* (
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
export const restrictSocketPath = Effect.fn("symmetria.socket.restrictSocketPath")(function* (
  socketPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.chmod(socketPath, SOCKET_MODE);
});

/** Removing a path that is not there is the ordinary case, not a failure. */
export const removeSocketPath = Effect.fn("symmetria.socket.removeSocketPath")(function* (
  socketPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(socketPath, { force: true });
});

/**
 * `$XDG_RUNTIME_DIR` is already `drwx------`, so the socket's own mode is a
 * second lock rather than the only one. The fallback is not: `os.tmpdir()` is
 * world-writable, and a predictable name there invites another local user to
 * pre-place a symlink between our unlink and our bind. So the fallback gets a
 * per-user directory of its own, which `prepareSocketPath` creates owner-only.
 */
export function defaultRuntimeDir(
  env: NodeJS.ProcessEnv = process.env,
  uid: number | undefined = process.getuid?.(),
): string {
  const xdg = env["XDG_RUNTIME_DIR"];
  if (typeof xdg === "string" && xdg.length > 0) return xdg;
  return `${NodeOS.tmpdir()}/symmetria-mesura-${uid ?? "nouid"}`;
}
