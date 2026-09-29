import type { HostStatsMesuraServers } from "@t3tools/contracts";
import { HostProcessPlatform, HostProcessUserId } from "@t3tools/shared/hostProcess";
import { DEFAULT_STATE_HOME_DIR_NAME } from "@t3tools/shared/stateHome";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import {
  type PersistedServerRuntimeState,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import {
  currentRegistryLocation,
  readServerRuntimeRegistry,
  serverRuntimeRegistryDirectories,
} from "./serverRuntimeRegistry.ts";

export interface MesuraServerDiscoveryOptions {
  readonly procRoot: string;
  /**
   * The per-user runtime registry directories (`serverRuntimeRegistry.ts`),
   * read before `/proc`: an entry names a base dir that argv and environment
   * cannot, such as one passed through `--bootstrap-fd`.
   */
  readonly registryDirectories: ReadonlyArray<string>;
  /** Only processes of this user are considered: the counting server's own uid. */
  readonly uid: number;
  /**
   * The state home of a candidate whose argv and environment name none and
   * whose environment has no `HOME` either: the counting server's own default.
   */
  readonly defaultStateHome: string;
  /**
   * The counting server. It is counted whatever its argv and runtime file say:
   * the desktop app's bundled server has no recognisable argv, and a server
   * writes its runtime file only after activation.
   */
  readonly self: { readonly pid: number; readonly dev: boolean };
}

/** Counts the Mesura Code servers running on this host; null where it cannot tell. */
export class MesuraServerDiscovery extends Context.Service<
  MesuraServerDiscovery,
  { readonly discover: Effect.Effect<HostStatsMesuraServers | null> }
>()("t3/hostStats/mesuraServerDiscovery") {}

/**
 * How far a runtime file's or registry entry's `startedAt` may sit from its
 * process's start time. A server writes the runtime file once it listens,
 * which took 9.2 s on vigilia-home at boot, so a slower boot needs headroom;
 * a PID reused by an unrelated process is off by minutes or hours.
 */
export const RUNTIME_FILE_START_WINDOW_MS = 60_000;

/** `/proc/<pid>/stat` counts start time in USER_HZ, which the kernel ABI fixes at 100. */
const CLOCK_TICKS_PER_SECOND = 100;

/** Field 22 of `/proc/<pid>/stat`, counted from the first field after the `comm` field. */
const START_TIME_FIELD_AFTER_COMM = 22 - 3;

/** The state directories a server writes `server-runtime.json` into, under its home. */
const RUNTIME_STATE_DIRECTORIES = ["userdata", "dev"] as const;

const SERVER_EXECUTABLE_NAMES = new Set(["t3", "mesura-code"]);
const SERVER_ENTRY_SUFFIXES = [
  "/apps/server/dist/bin.mjs",
  "/apps/server/src/bin.ts",
  "/node_modules/t3/dist/bin.mjs",
];

/**
 * Whether argv names a Mesura Code server entry: a `t3` or `mesura-code`
 * executable, or the server package's built or source entry. Relative entries
 * resolve against the process's cwd, as its runtime did. Loose on purpose:
 * `t3 pair` and the dev watcher match too, and the runtime file rejects them.
 */
function namesServerEntry(argv: ReadonlyArray<string>, cwd: string, path: Path.Path): boolean {
  return argv.some((entry) => {
    if (entry.startsWith("-")) return false;
    if (SERVER_EXECUTABLE_NAMES.has(path.basename(entry))) return true;
    const resolved = path.resolve(cwd, entry);
    return SERVER_ENTRY_SUFFIXES.some((suffix) => resolved.endsWith(suffix));
  });
}

/** `--base-dir <dir>` or `--base-dir=<dir>`, which outranks `T3CODE_HOME` as in `cli/config.ts`. */
function baseDirFlag(argv: ReadonlyArray<string>): string | undefined {
  for (const [index, entry] of argv.entries()) {
    if (entry === "--base-dir") return argv[index + 1];
    if (entry.startsWith("--base-dir=")) return entry.slice("--base-dir=".length);
  }
  return undefined;
}

function environmentValue(environ: string, name: string): string | undefined {
  const prefix = `${name}=`;
  return environ
    .split("\0")
    .find((entry) => entry.startsWith(prefix))
    ?.slice(prefix.length);
}

/** Start time in clock ticks since boot. `comm` may hold spaces and `)`, so parse after the last `)`. */
function startTicks(stat: string): number | null {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ticks = Number(fields[START_TIME_FIELD_AFTER_COMM]);
  return Number.isFinite(ticks) ? ticks : null;
}

function realUid(status: string): number | null {
  const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
  return Number.isInteger(uid) ? uid : null;
}

type ServerKind = "installed" | "dev";

/** A server fronting a dev web server records its `devUrl`; every other one is installed. */
const serverKind = (devUrl: string | undefined): ServerKind =>
  devUrl === undefined ? "installed" : "dev";

/** Whether a record's `startedAt` was written by the process that started at `processStartMs`. */
function startedWith(startedAt: string, processStartMs: number): boolean {
  return Math.abs(Date.parse(startedAt) - processStartMs) <= RUNTIME_FILE_START_WINDOW_MS;
}

const bootTimeMs = (procRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const btime = Number(/^btime\s+(\d+)/m.exec(yield* fs.readFileString(`${procRoot}/stat`))?.[1]);
    return Number.isFinite(btime) ? btime * 1000 : yield* Effect.fail("no btime" as const);
  });

export const make = Effect.fn("makeMesuraServerDiscovery")(function* (
  options: MesuraServerDiscoveryOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;

  const selfCount: HostStatsMesuraServers = options.self.dev
    ? { installed: 0, dev: 1 }
    : { installed: 1, dev: 0 };

  /**
   * Where a candidate keeps its state, resolved as its own CLI would: `--base-dir`,
   * then `T3CODE_HOME`, then the default under its own `HOME`, which may not be
   * ours. A desktop app passing its base dir through the bootstrap fd is not
   * visible here and falls back to that default; the registry finds it instead.
   */
  const stateHomeOf = (argv: ReadonlyArray<string>, environ: string, cwd: string) =>
    Effect.gen(function* () {
      const explicit = baseDirFlag(argv) ?? environmentValue(environ, "T3CODE_HOME");
      if (explicit === undefined || explicit.trim().length === 0) {
        const home = environmentValue(environ, "HOME")?.trim();
        return home !== undefined && path.isAbsolute(home)
          ? path.join(home, DEFAULT_STATE_HOME_DIR_NAME)
          : options.defaultStateHome;
      }
      const trimmed = explicit.trim();
      return trimmed.startsWith("~") || path.isAbsolute(trimmed)
        ? yield* resolveBaseDir(trimmed)
        : path.resolve(cwd, trimmed);
    });

  /**
   * The runtime state this process wrote about itself, or none: a file naming
   * its PID and started with it. Each file is checked in full, so a stale file
   * for a reused PID in `userdata` cannot hide the current one in `dev`.
   */
  const ownRuntimeState = (pid: number, stateHome: string, processStartMs: number) =>
    Effect.gen(function* () {
      for (const directory of RUNTIME_STATE_DIRECTORIES) {
        const state = yield* readPersistedServerRuntimeState(
          path.join(stateHome, directory, "server-runtime.json"),
        );
        if (Option.isNone(state) || state.value.pid !== pid) continue;
        if (startedWith(state.value.startedAt, processStartMs)) return state;
      }
      return Option.none<PersistedServerRuntimeState>();
    });

  /** The start time of the process at `processDir` when it belongs to this user; null otherwise. */
  const ownProcessStartMs = (processDir: string, bootedAtMs: number) =>
    Effect.gen(function* () {
      if (realUid(yield* fs.readFileString(path.join(processDir, "status"))) !== options.uid) {
        return null;
      }
      const ticks = startTicks(yield* fs.readFileString(path.join(processDir, "stat")));
      return ticks === null ? null : bootedAtMs + (ticks * 1000) / CLOCK_TICKS_PER_SECOND;
    });

  /**
   * The registry entries of live servers of this user, one per PID. An entry
   * is checked like a runtime file: its process runs, is ours, and started
   * with it. A stale entry, for a dead or reused PID, is skipped.
   */
  const registeredServers = (bootedAtMs: number) =>
    Effect.gen(function* () {
      const entries = (yield* Effect.forEach(
        options.registryDirectories,
        readServerRuntimeRegistry,
      )).flat();
      const servers = new Map<number, ServerKind>();
      for (const entry of entries) {
        if (entry.pid === options.self.pid || servers.has(entry.pid)) continue;
        const processStartMs = yield* ownProcessStartMs(
          path.join(options.procRoot, String(entry.pid)),
          bootedAtMs,
        ).pipe(Effect.catchCause(() => Effect.succeed(null)));
        if (processStartMs === null || !startedWith(entry.startedAt, processStartMs)) continue;
        servers.set(entry.pid, serverKind(entry.devUrl));
      }
      return servers;
    });

  /** The kind of server `pid` is, or null when it is not a live Mesura Code server. */
  const classify = (pid: number, bootedAtMs: number) =>
    Effect.gen(function* () {
      const processDir = path.join(options.procRoot, String(pid));
      const processStartMs = yield* ownProcessStartMs(processDir, bootedAtMs);
      if (processStartMs === null) return null;
      const argv = (yield* fs.readFileString(path.join(processDir, "cmdline")))
        .split("\0")
        .filter((entry) => entry.length > 0);
      const cwd = yield* fs.readLink(path.join(processDir, "cwd"));
      if (!namesServerEntry(argv, cwd, path)) return null;

      const environ = yield* fs.readFileString(path.join(processDir, "environ"));
      const stateHome = yield* stateHomeOf(argv, environ, cwd);
      const state = yield* ownRuntimeState(pid, stateHome, processStartMs);
      if (Option.isNone(state)) return null;
      return serverKind(state.value.devUrl);
    }).pipe(
      // The process exited, or its files are not ours to read: it is not counted.
      Effect.catchCause(() => Effect.succeed(null)),
    );

  const discoverOnLinux = Effect.gen(function* () {
    const bootedAtMs = yield* bootTimeMs(options.procRoot);
    const registered = yield* registeredServers(bootedAtMs);
    // A registered server is counted from its entry, never again from /proc.
    const pids = (yield* fs.readDirectory(options.procRoot))
      .filter((entry) => /^\d+$/.test(entry))
      .map(Number)
      .filter((pid) => pid !== options.self.pid && !registered.has(pid));
    const kinds = [
      ...registered.values(),
      ...(yield* Effect.forEach(pids, (pid) => classify(pid, bootedAtMs), {
        concurrency: 16,
      })),
    ];
    return {
      installed: selfCount.installed + kinds.filter((kind) => kind === "installed").length,
      dev: selfCount.dev + kinds.filter((kind) => kind === "dev").length,
    } satisfies HostStatsMesuraServers;
  });

  const discover: Effect.Effect<HostStatsMesuraServers | null> =
    platform === "linux"
      ? discoverOnLinux.pipe(
          Effect.catchCause(() => Effect.succeed(null)),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.withSpan("MesuraServerDiscovery.discover"),
        )
      : Effect.succeed(null);

  return MesuraServerDiscovery.of({ discover });
});

export const layer = Layer.effect(
  MesuraServerDiscovery,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const uid = yield* HostProcessUserId;
    return yield* make({
      procRoot: "/proc",
      registryDirectories:
        uid === undefined
          ? []
          : serverRuntimeRegistryDirectories(yield* currentRegistryLocation(uid)),
      // No POSIX uid means no /proc to walk; discovery is null there anyway.
      uid: uid ?? -1,
      defaultStateHome: yield* resolveBaseDir(undefined),
      self: { pid: process.pid, dev: config.devUrl !== undefined },
    });
  }),
);
