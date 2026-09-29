/**
 * Phase 3 fence of the hosts dock plan: acceptance criteria 3, 4 and 5.
 *
 * Entry point: `MesuraServerDiscovery.make`, the constructor the server's
 * discovery layer wraps with `/proc`, the server's uid, the default state home
 * and the server's own PID. Each spec stages the processes it names from
 * `fixtures/mesura-servers` (see its README for what each PID is) and runs one
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

const FIXTURE_UID = 1000;
const INSTALLED = 1163;
const DEV_WATCHER = 17807;
const DEV_CHILD = 2606635;
const DEV_DEFAULT_HOME = 6060;
const REUSED_PID = 4242;
const STALE_FILE = 5151;
const PAIR_CLI = 7070;
const LATE_WRITE = 8080;
const OTHER_USER = 9090;
const DESKTOP = 3773;
const SHELL = 2222;
const OTHER_HOME_DESKTOP = 3700;
const STALE_AND_CURRENT_FILES = 3800;
const NO_HOME = 3900;
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
    const withRoot = (text: string) => text.replaceAll("@ROOT@", root);

    yield* fs.copy(path.join(fixture, "root"), root);
    yield* fs.makeDirectory(procRoot, { recursive: true });
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
    } satisfies StagedHost;
  });

const discoverOn = (
  host: StagedHost,
  self: { readonly pid: number; readonly dev: boolean },
  platform: NodeJS.Platform = "linux",
) =>
  Effect.gen(function* () {
    const discovery = yield* MesuraServerDiscovery.make({
      procRoot: host.procRoot,
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

  it.effect(
    "phase 3 AC3: startedAt 9.2 s after the process start counts, 11 s after does not",
    () =>
      Effect.gen(function* () {
        // 1163 wrote its file 9.167 s after it started (real, vigilia-home at boot);
        // 8080 wrote its file 11 s after.
        const host = yield* stageHost([DEV_CHILD, INSTALLED, LATE_WRITE]);
        assert.deepStrictEqual(
          yield* discoverOn(host, { pid: DEV_CHILD, dev: true }),
          servers(1, 1),
        );
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
