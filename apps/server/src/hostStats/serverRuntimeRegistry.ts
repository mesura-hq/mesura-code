// @effect-diagnostics nodeBuiltinImport:off
/**
 * Mesura: the per-user runtime registry. Every Linux server writes
 * `<registry dir>/<pid>.json` naming its base dir while it runs, so the hosts
 * dock's server discovery can find a server whose base dir is invisible from
 * `/proc`: the desktop app passes its base dir through `--bootstrap-fd`, and
 * discovery cannot read a file descriptor. `server-runtime.json` stays where
 * it is; this is a second, fork-owned record beside it.
 */
import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessUserId,
} from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import { isProcessAlive } from "../serverRuntimeState.ts";

export const ServerRuntimeRegistryEntry = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  /** When the server registered, a few seconds after its process started. */
  startedAt: Schema.String,
  baseDir: Schema.String,
  stateDir: Schema.String,
  /** Present on a dev server, as in `server-runtime.json`. */
  devUrl: Schema.optional(Schema.String),
});
export type ServerRuntimeRegistryEntry = typeof ServerRuntimeRegistryEntry.Type;

const ServerRuntimeRegistryEntryJson = Schema.fromJsonString(ServerRuntimeRegistryEntry);
const decodeEntry = Schema.decodeUnknownEffect(ServerRuntimeRegistryEntryJson);
/** The text of an entry file, as `register` writes it and discovery reads it. */
export const encodeServerRuntimeRegistryEntry = Schema.encodeSync(ServerRuntimeRegistryEntryJson);

const ENTRY_FILE_NAME = /^(\d+)\.json$/;

export interface ServerRuntimeRegistryLocation {
  readonly xdgRuntimeDir: string | undefined;
  readonly tmpDir: string;
  readonly uid: number;
}

/**
 * Where this user's servers register: `$XDG_RUNTIME_DIR/mesura-code/servers`
 * when it is set, else `<tmpdir>/mesura-code-<uid>/servers`. A relative
 * `XDG_RUNTIME_DIR` is invalid by the XDG spec and ignored.
 */
export function serverRuntimeRegistryDirectory(location: ServerRuntimeRegistryLocation): string {
  const xdg = location.xdgRuntimeDir;
  return xdg !== undefined && NodePath.posix.isAbsolute(xdg)
    ? NodePath.posix.join(xdg, "mesura-code", "servers")
    : NodePath.posix.join(location.tmpDir, `mesura-code-${location.uid}`, "servers");
}

/**
 * Every directory a server of this user may have registered in. A server
 * started without a login session (cron, `ssh host cmd`, some service
 * managers) has no `XDG_RUNTIME_DIR` and registers under the tmpdir, so
 * discovery reads both.
 */
export function serverRuntimeRegistryDirectories(
  location: ServerRuntimeRegistryLocation,
): ReadonlyArray<string> {
  const own = serverRuntimeRegistryDirectory(location);
  const fallback = serverRuntimeRegistryDirectory({ ...location, xdgRuntimeDir: undefined });
  return own === fallback ? [own] : [own, fallback];
}

/** This process's registry location, from its environment. */
export const currentRegistryLocation = (uid: number) =>
  Effect.gen(function* () {
    const environment = yield* HostProcessEnvironment;
    return {
      xdgRuntimeDir: environment.XDG_RUNTIME_DIR,
      tmpDir: NodeOS.tmpdir(),
      uid,
    } satisfies ServerRuntimeRegistryLocation;
  });

const STICKY_BIT = 0o1000;
const WRITABLE_BY_OTHERS = 0o022;

/**
 * Why one component of a registry path cannot be trusted, or null. `link` is
 * the component itself, `target` what it resolves to. The fallback registry
 * lives in the shared tmpdir, where another user can create
 * `mesura-code-<uid>` first or plant a symlink there: every ancestor must be
 * this user's or root's, and not writable by others unless sticky, as `/tmp`
 * is. The registry directory itself must be this user's.
 */
function componentProblem(
  link: NodeFS.Stats,
  target: NodeFS.Stats,
  uid: number,
  isRegistryDirectory: boolean,
): string | null {
  if (link.isSymbolicLink() && link.uid !== 0) return "a symlink not owned by root";
  if (!target.isDirectory()) return "not a directory";
  if (isRegistryDirectory) return target.uid === uid ? null : "owned by another user";
  if (target.uid !== uid && target.uid !== 0) return "owned by another user";
  if ((target.mode & WRITABLE_BY_OTHERS) !== 0 && (target.mode & STICKY_BIT) === 0) {
    return "writable by other users";
  }
  return null;
}

const lstatOrNull = (path: string) =>
  Effect.tryPromise(() => NodeFSP.lstat(path)).pipe(Effect.orElseSucceed(() => null));

/**
 * Walks `directory` from `/` and returns why it cannot be trusted, or null.
 * With `create`, a missing component is created (0700) only once everything
 * above it has been checked, so nothing is ever created behind an untrusted
 * component.
 */
const registryDirectoryProblem = (directory: string, options: { readonly create: boolean }) =>
  Effect.gen(function* () {
    const uid = yield* HostProcessUserId;
    if (uid === undefined || !NodePath.posix.isAbsolute(directory)) return "not a POSIX path";
    const names = directory.split("/").filter((name) => name.length > 0);
    let current = "/";
    for (const [index, name] of ["", ...names].entries()) {
      current = NodePath.posix.join(current, name);
      let link = yield* lstatOrNull(current);
      if (link === null && options.create) {
        yield* Effect.tryPromise(() => NodeFSP.mkdir(current, { mode: 0o700 })).pipe(Effect.ignore);
        link = yield* lstatOrNull(current);
      }
      if (link === null) return `${current} is missing`;
      const target = link.isSymbolicLink()
        ? yield* Effect.tryPromise(() => NodeFSP.stat(current)).pipe(
            Effect.orElseSucceed(() => null),
          )
        : link;
      if (target === null) return `${current} is a dangling symlink`;
      const problem = componentProblem(link, target, uid, index === names.length);
      if (problem !== null) return `${current} is ${problem}`;
    }
    return null;
  });

/**
 * Every well-formed entry in `directory`. A missing or untrusted directory,
 * and any entry that cannot be read or decoded, yields nothing: discovery
 * skips it. The directory must also be closed to other users, since a server
 * tightens it when it registers.
 */
export const readServerRuntimeRegistry = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if ((yield* registryDirectoryProblem(directory, { create: false })) !== null) return [];
    const info = yield* fs.stat(directory).pipe(Effect.orElseSucceed(() => null));
    if (info === null || (info.mode & WRITABLE_BY_OTHERS) !== 0) return [];
    const names = yield* fs
      .readDirectory(directory)
      .pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])));
    const entries = yield* Effect.forEach(
      names.filter((name) => ENTRY_FILE_NAME.test(name)),
      (name) =>
        fs.readFileString(path.join(directory, name)).pipe(
          Effect.flatMap(decodeEntry),
          Effect.map(Option.some),
          Effect.catch(() => Effect.succeed(Option.none<ServerRuntimeRegistryEntry>())),
        ),
      { concurrency: 16 },
    );
    return entries.flatMap((entry) => (Option.isSome(entry) ? [entry.value] : []));
  });

/** Deletes the entries of processes that no longer exist: a server killed before its finalizer ran. */
const removeDeadEntries = (directory: string, alive: (pid: number) => boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const name of yield* fs.readDirectory(directory)) {
      const pid = ENTRY_FILE_NAME.exec(name)?.[1];
      if (pid === undefined || alive(Number(pid))) continue;
      yield* fs.remove(path.join(directory, name), { force: true });
    }
  });

export interface RegisterOptions {
  readonly directory: string;
  readonly pid: number;
  readonly baseDir: string;
  readonly stateDir: string;
  readonly devUrl: string | undefined;
  readonly isProcessAlive: (pid: number) => boolean;
}

/**
 * Writes this server's entry for the life of the scope, then removes it. The
 * directory is created, or tightened, to 0700 once its whole path is trusted
 * (`registryDirectoryProblem`): it lists every server of one user. A failure
 * or an untrusted path is logged, never fatal: the server still runs, and
 * discovery still finds it through `/proc` when its argv names its home.
 */
export const register = (options: RegisterOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entryPath = path.join(options.directory, `${options.pid}.json`);
    const entry: ServerRuntimeRegistryEntry = {
      version: 1,
      pid: options.pid,
      startedAt: DateTime.formatIso(yield* DateTime.now),
      baseDir: options.baseDir,
      stateDir: options.stateDir,
      ...(options.devUrl === undefined ? {} : { devUrl: options.devUrl }),
    };
    yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const problem = yield* registryDirectoryProblem(options.directory, { create: true });
        if (problem !== null) {
          yield* Effect.logWarning("Refusing an untrusted server runtime registry directory", {
            problem,
          });
          return false;
        }
        yield* fs.chmod(options.directory, 0o700);
        yield* removeDeadEntries(options.directory, options.isProcessAlive).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to sweep the server runtime registry", { cause }),
          ),
        );
        yield* writeFileStringAtomically({
          filePath: entryPath,
          contents: `${encodeServerRuntimeRegistryEntry(entry)}\n`,
        });
        return true;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to register in the server runtime registry", {
            cause,
            entryPath,
          }).pipe(Effect.as(true)),
        ),
      ),
      // The acquire yields whether the directory was trusted: nothing is removed through an untrusted path.
      (trusted) =>
        (trusted ? fs.remove(entryPath, { force: true }) : Effect.void).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to leave the server runtime registry", {
              cause,
              entryPath,
            }),
          ),
        ),
    );
  });

/** Registers this server for as long as it runs. Linux only: discovery is Linux only. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const uid = yield* HostProcessUserId;
    if ((yield* HostProcessPlatform) !== "linux" || uid === undefined) return;
    const config = yield* ServerConfig;
    yield* register({
      directory: serverRuntimeRegistryDirectory(yield* currentRegistryLocation(uid)),
      pid: process.pid,
      baseDir: config.baseDir,
      stateDir: config.stateDir,
      devUrl: config.devUrl?.toString(),
      isProcessAlive,
    });
  }),
);
