/**
 * Phase 3 fence of the hosts dock plan: acceptance criteria 3, 4 and 5, plus
 * the per-user runtime registry follow-up.
 *
 * Entry point: `MesuraServerDiscovery.make`, the constructor the server's
 * discovery layer wraps with `/proc`, the per-user registry directories, the
 * server's uid, the default state home and the server's own PID. Each spec
 * stages the processes it names from `fixtures/mesura-servers` (see its README
 * for what each PID is), writes the registry entries it names, and runs one
 * discovery against that tree.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { HostStatsMesuraServers } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as MesuraServerDiscovery from "./mesuraServerDiscovery.ts";
import { encodeServerRuntimeRegistryEntry } from "./serverRuntimeRegistry.ts";

const FIXTURE_UID = 1000;
const INSTALLED = 1163;
const DEV_WATCHER = 17807;
const DEV_CHILD = 2606635;
const DEV_DEFAULT_HOME = 6060;
const REUSED_PID = 4242;
const STALE_FILE = 5151;
const PAIR_CLI = 7070;
const LATE_WRITE = 8080;
const SLOW_WRITE = 8181;
const OTHER_USER = 9090;
const DESKTOP = 3773;
const SHELL = 2222;
const OTHER_HOME_DESKTOP = 3700;
const STALE_AND_CURRENT_FILES = 3800;
const NO_HOME = 3900;
const BOOTSTRAP_FD_DESKTOP = 3950;
/** Other ways a server is started; see the fixture README. */
const OTHER_ENTRIES = [3100, 3200, 3300, 3400, 3500, 3600];
const ALL_PIDS = [
  INSTALLED,
  DEV_WATCHER,
  DEV_CHILD,
  DEV_DEFAULT_HOME,
  REUSED_PID,
  STALE_FILE,
  PAIR_CLI,
  LATE_WRITE,
  OTHER_USER,
  DESKTOP,
  SHELL,
];

interface StagedHost {
  readonly procRoot: string;
  readonly defaultStateHome: string;
  /** The staged `root/`, where every fixture state home lives. */
  readonly root: string;
  /** The per-user runtime registry directory, empty until a spec writes to it. */
  readonly registry: string;
}

/** Copies the named processes and every state home into a temp tree with real paths. */
const stageHost = (pids: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fixture = path.join(import.meta.dirname, "fixtures", "mesura-servers");
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-server-discovery-" });
    const root = path.join(directory, "root");
    const procRoot = path.join(directory, "proc");
    const registry = path.join(directory, "registry");
    const withRoot = (text: string) => text.replaceAll("@ROOT@", root);

    yield* fs.copy(path.join(fixture, "root"), root);
    yield* fs.makeDirectory(procRoot, { recursive: true });
    yield* fs.makeDirectory(registry, { recursive: true });
    yield* fs.copyFile(path.join(fixture, "proc", "stat"), path.join(procRoot, "stat"));
    // Real /proc also lists non-PID entries.
    yield* fs.makeDirectory(path.join(procRoot, "sys"));
    for (const pid of pids) {
      const source = path.join(fixture, "proc", String(pid));
      const target = path.join(procRoot, String(pid));
      yield* fs.makeDirectory(target);
      for (const name of ["stat", "status"]) {
        yield* fs.copyFile(path.join(source, name), path.join(target, name));
      }
      for (const name of ["cmdline", "environ"]) {
        const contents = yield* fs.readFileString(path.join(source, name));
        yield* fs.writeFileString(path.join(target, name), withRoot(contents));
      }
      const cwd = withRoot((yield* fs.readFileString(path.join(source, "cwd.target"))).trim());
      yield* fs.makeDirectory(cwd, { recursive: true });
      yield* fs.symlink(cwd, path.join(target, "cwd"));
    }
    return {
      procRoot,
      defaultStateHome: path.join(root, "home", "dev", ".mesura-code"),
      root,
      registry,
    } satisfies StagedHost;
  });

interface RegistryEntryFixture {
  readonly pid: number;
  readonly startedAt: string;
  /** Relative to the staged `root/`. */
  readonly baseDir: string;
  readonly devUrl?: string;
}

/** Writes `<registry>/<pid>.json` the way a registered server does. */
const writeRegistryEntry = (host: StagedHost, entry: RegistryEntryFixture) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = path.join(host.root, entry.baseDir);
    yield* fs.writeFileString(
      path.join(host.registry, `${entry.pid}.json`),
      encodeServerRuntimeRegistryEntry({
        version: 1,
        pid: entry.pid,
        startedAt: entry.startedAt,
        baseDir,
        stateDir: path.join(baseDir, entry.devUrl === undefined ? "userdata" : "dev"),
        ...(entry.devUrl === undefined ? {} : { devUrl: entry.devUrl }),
      }),
    );
  });

/** 3950 started at 03:15:31; the desktop app's server registers itself 4 s later. */
const BOOTSTRAP_FD_DESKTOP_ENTRY: RegistryEntryFixture = {
  pid: BOOTSTRAP_FD_DESKTOP,
  startedAt: "2026-09-29T03:15:35.000Z",
  baseDir: "homes/desktop-bootstrap",
};

const discoverOn = (
  host: StagedHost,
  self: { readonly pid: number; readonly dev: boolean },
  platform: NodeJS.Platform = "linux",
) =>
  Effect.gen(function* () {
    const discovery = yield* MesuraServerDiscovery.make({
      procRoot: host.procRoot,
      registryDirectories: [host.registry],
      uid: FIXTURE_UID,
      defaultStateHome: host.defaultStateHome,
      self,
    });
    return yield* discovery.discover;
  }).pipe(Effect.provideService(HostProcessPlatform, platform));

const servers = (installed: number, dev: number): HostStatsMesuraServers => ({ installed, dev });

it.layer(NodeServices.layer)("mesuraServerDiscovery phase 3 fence", (it) => {
  it.effect("phase 3 AC3: a runtime file naming a dead PID is not counted", () =>
    Effect.gen(function* () {
      const host = yield* stageHost([INSTALLED, STALE_FILE]);
      assert.deepStrictEqual(
        yield* discoverOn(host, { pid: INSTALLED, dev: false }),
        servers(1, 0),
      );
    }),
  );

  it.effect(
    "phase 3 AC3: a reused PID whose start time is hours after startedAt is not counted",
    () =>
      Effect.gen(function* () {
        const host = yield* stageHost([INSTALLED, REUSED_PID]);
        assert.deepStrictEqual(
          yield* discoverOn(host, { pid: INSTALLED, dev: false }),
          servers(1, 0),
        );
      }),
  );

  it.effect("phase 3 AC3: startedAt 59 s after the process start counts, 61 s after does not", () =>
    Effect.gen(function* () {
      // 1163 wrote its file 9.167 s after it started (real, vigilia-home at boot);
      // 8181 wrote its file 59 s after, and 8080 61 s after.
      const host = yield* stageHost([DEV_CHILD, INSTALLED, SLOW_WRITE, LATE_WRITE]);
      assert.deepStrictEqual(yield* discoverOn(host, { pid: DEV_CHILD, dev: true }), servers(2, 1));
    }),
  );

  it.effect(
    "phase 3 AC3: a t3 pair CLI and the dev watcher parent are not counted as servers",
    () =>
      Effect.gen(function* () {
        const host = yield* stageHost([INSTALLED, PAIR_CLI, DEV_WATCHER, DEV_CHILD, SHELL]);
        assert.deepStrictEqual(
          yield* discoverOn(host, { pid: INSTALLED, dev: false }),
          servers(1, 1),
        );
      }),
  );

  it.effect("phase 3 discovery: a server owned by another user is not counted", () =>
    Effect.gen(function* () {
      const host = yield* stageHost([INSTALLED, OTHER_USER]);
      assert.deepStrictEqual(
        yield* discoverOn(host, { pid: INSTALLED, dev: false }),
        servers(1, 0),
      );
    }),
  );

  it.effect(
    "phase 3 AC4: servers are dev when their runtime file has devUrl, installed otherwise",
    () =>
      Effect.gen(function* () {
        // The desktop's bundled server counts itself; the installed server, the
        // worktree dev server and the default-home dev server are the others.
        const host = yield* stageHost(ALL_PIDS);
        assert.deepStrictEqual(
          yield* discoverOn(host, { pid: DESKTOP, dev: false }),
          servers(2, 2),
        );
      }),
  );

  it.effect(
    "phase 3 discovery: bare t3, mesura-code start, built and npx entries, a second desktop and an absolute src/bin.ts count",
    () =>
      Effect.gen(function* () {
        // 3200 names its home only through --base-dir, which outranks its T3CODE_HOME.
        const host = yield* stageHost([INSTALLED, ...OTHER_ENTRIES]);
        assert.deepStrictEqual(
          yield* discoverOn(host, { pid: INSTALLED, dev: false }),
          servers(6, 1),
        );
      }),
  );

  it.effect(
    "phase 3 rework: a server without T3CODE_HOME is found under its own HOME, not ours",
    () =>
      Effect.gen(function* () {
        const host = yield* stageHost([INSTALLED, OTHER_HOME_DESKTOP]);
        assert.deepStrictEqual(
          yield* discoverOn(host, { pid: INSTALLED, dev: false }),
          servers(2, 0),
        );
      }),
  );

  it.effect(
    "phase 3 rework: a stale userdata file for a reused PID does not hide its current dev file",
    () =>
      Effect.gen(function* () {
        const host = yield* stageHost([INSTALLED, STALE_AND_CURRENT_FILES]);
        assert.deepStrictEqual(
          yield* discoverOn(host, { pid: INSTALLED, dev: false }),
          servers(1, 1),
        );
      }),
  );

  it.effect(
    "phase 3 regression: a candidate with neither T3CODE_HOME nor HOME uses the counting server's default home",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const host = yield* stageHost([INSTALLED, NO_HOME]);
        // 3900 has no HOME, so it is looked for under the counting server's default home.
        const withItsFile = { ...host, defaultStateHome: path.join(host.root, "homes", "no-home") };
        assert.deepStrictEqual(
          yield* discoverOn(withItsFile, { pid: INSTALLED, dev: false }),
          servers(2, 0),
        );
        // That default home's file names 1163, not 3900: nothing to find there.
        assert.deepStrictEqual(
          yield* discoverOn(host, { pid: INSTALLED, dev: false }),
          servers(1, 0),
        );
      }),
  );

  it.effect("phase 3 AC4: the counting server is counted exactly once", () =>
    Effect.gen(function* () {
      const host = yield* stageHost([INSTALLED]);
      assert.deepStrictEqual(
        yield* discoverOn(host, { pid: INSTALLED, dev: false }),
        servers(1, 0),
      );
    }),
  );

  it.effect("phase 3 AC4: a dev server counts itself before its own runtime file is current", () =>
    Effect.gen(function* () {
      // 5151's home still holds a stale file naming PID 9999.
      const host = yield* stageHost([INSTALLED, STALE_FILE]);
      assert.deepStrictEqual(
        yield* discoverOn(host, { pid: STALE_FILE, dev: true }),
        servers(1, 1),
      );
    }),
  );

  it.effect(
    "server registry discovery: a bootstrap-fd desktop server with a non-default base dir is counted",
    () =>
      Effect.gen(function* () {
        const host = yield* stageHost([INSTALLED, BOOTSTRAP_FD_DESKTOP]);
        // Without its entry, 3950 is looked for under its HOME, whose file names 1163.
        assert.deepStrictEqual(
          yield* discoverOn(host, { pid: INSTALLED, dev: false }),
          servers(1, 0),
        );
        yield* writeRegistryEntry(host, BOOTSTRAP_FD_DESKTOP_ENTRY);
        assert.deepStrictEqual(
          yield* discoverOn(host, { pid: INSTALLED, dev: false }),
          servers(2, 0),
        );
      }),
  );

  it.effect("server registry discovery: an entry with devUrl counts as a dev server", () =>
    Effect.gen(function* () {
      const host = yield* stageHost([INSTALLED, BOOTSTRAP_FD_DESKTOP]);
      yield* writeRegistryEntry(host, {
        ...BOOTSTRAP_FD_DESKTOP_ENTRY,
        devUrl: "http://localhost:5733/",
      });
      assert.deepStrictEqual(
        yield* discoverOn(host, { pid: INSTALLED, dev: false }),
        servers(1, 1),
      );
    }),
  );

  it.effect(
    "server registry discovery: stale entries for a dead PID, a reused PID, a late write or another user are not counted",
    () =>
      Effect.gen(function* () {
        const host = yield* stageHost([INSTALLED, REUSED_PID, BOOTSTRAP_FD_DESKTOP, OTHER_USER]);
        // 9999 is not running.
        yield* writeRegistryEntry(host, {
          pid: 9999,
          startedAt: "2026-09-29T03:00:00.000Z",
          baseDir: "homes/reused",
        });
        // 4242 started at 02:59:41: an entry from two hours earlier is a previous owner's.
        yield* writeRegistryEntry(host, {
          pid: REUSED_PID,
          startedAt: "2026-09-29T00:59:44.000Z",
          baseDir: "homes/reused",
        });
        // 3950 started at 03:15:31: 61 s later is outside the window.
        yield* writeRegistryEntry(host, {
          ...BOOTSTRAP_FD_DESKTOP_ENTRY,
          startedAt: "2026-09-29T03:16:32.000Z",
        });
        // 9090 belongs to uid 1001, whatever directory its entry landed in.
        yield* writeRegistryEntry(host, {
          pid: OTHER_USER,
          startedAt: "2026-09-29T03:00:00.000Z",
          baseDir: "homes/other",
        });
        assert.deepStrictEqual(
          yield* discoverOn(host, { pid: INSTALLED, dev: false }),
          servers(1, 0),
        );
      }),
  );

  it.effect(
    "server registry discovery: a server found through both the registry and /proc counts once",
    () =>
      Effect.gen(function* () {
        const host = yield* stageHost([INSTALLED, DEV_CHILD]);
        yield* writeRegistryEntry(host, {
          pid: DEV_CHILD,
          startedAt: "2026-09-29T02:45:01.063Z",
          baseDir: "worktrees/t3code-55ad0e33/state",
          devUrl: "http://localhost:5878/",
        });
        // The counting server's own entry never counts it a second time.
        yield* writeRegistryEntry(host, {
          pid: INSTALLED,
          startedAt: "2026-09-28T18:56:41.557Z",
          baseDir: "home/dev/.mesura-code",
        });
        assert.deepStrictEqual(
          yield* discoverOn(host, { pid: INSTALLED, dev: false }),
          servers(1, 1),
        );
      }),
  );

  it.effect(
    "server registry discovery: an unreadable or malformed entry is skipped, the valid ones still count",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const host = yield* stageHost([INSTALLED, BOOTSTRAP_FD_DESKTOP]);
        yield* writeRegistryEntry(host, BOOTSTRAP_FD_DESKTOP_ENTRY);
        yield* fs.writeFileString(path.join(host.registry, "4000.json"), "{ not json");
        yield* fs.writeFileString(
          path.join(host.registry, "4001.json"),
          '{"version":2,"pid":4001}',
        );
        yield* fs.writeFileString(path.join(host.registry, "4002.json"), "");
        const unreadable = path.join(host.registry, "4003.json");
        yield* fs.writeFileString(unreadable, "{}");
        yield* fs.chmod(unreadable, 0o000);
        yield* fs.makeDirectory(path.join(host.registry, "4004.json"));
        yield* fs.writeFileString(path.join(host.registry, "notes.txt"), "not an entry");
        assert.deepStrictEqual(
          yield* discoverOn(host, { pid: INSTALLED, dev: false }),
          servers(2, 0),
        );
      }),
  );

  it.effect(
    "server registry discovery: a missing registry directory falls back to /proc alone",
    () =>
      Effect.gen(function* () {
        const host = yield* stageHost([INSTALLED, DEV_CHILD]);
        const missing = { ...host, registry: `${host.registry}-missing` };
        assert.deepStrictEqual(
          yield* discoverOn(missing, { pid: INSTALLED, dev: false }),
          servers(1, 1),
        );
      }),
  );

  it.effect("phase 3 AC5: on macOS and Windows mesuraServers is null", () =>
    Effect.gen(function* () {
      const host = yield* stageHost(ALL_PIDS);
      for (const platform of ["darwin", "win32"] as const) {
        assert.isNull(yield* discoverOn(host, { pid: INSTALLED, dev: false }, platform));
      }
    }),
  );

  it.effect("phase 3 discovery: an unreadable /proc yields null, not zero", () =>
    Effect.gen(function* () {
      const host = yield* stageHost([]);
      const missing = { ...host, procRoot: `${host.procRoot}-missing` };
      assert.isNull(yield* discoverOn(missing, { pid: INSTALLED, dev: false }));
    }),
  );
});
