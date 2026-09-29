/**
 * The per-user runtime registry: what a server writes about itself, where,
 * and for how long.
 *
 * Entry point: `ServerRuntimeRegistry.layer`, the layer the server's host
 * stats block builds, over `ServerConfig.layerTest` and a
 * `HostProcessEnvironment` whose `XDG_RUNTIME_DIR` is a temp directory. The
 * pure directory rule and the dead-entry sweep are reached through the same
 * module's `serverRuntimeRegistryDirectory` and `register`. The round trip
 * reads what `register` wrote through `MesuraServerDiscovery.make`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessUserId,
} from "@t3tools/shared/hostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../config.ts";
import * as MesuraServerDiscovery from "./mesuraServerDiscovery.ts";
import * as ServerRuntimeRegistry from "./serverRuntimeRegistry.ts";

const decodeEntry = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ServerRuntimeRegistry.ServerRuntimeRegistryEntry),
);

const readEntry = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* decodeEntry(yield* fs.readFileString(file));
  });

/** `/proc` files report size 0, so a plain file copy of one comes out empty. */
const copyProcFile = (source: string, target: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(target, yield* fs.readFileString(source));
  });

it.layer(NodeServices.layer)("server runtime registry", (it) => {
  it("server registry directory: XDG_RUNTIME_DIR/mesura-code/servers when set, else <tmpdir>/mesura-code-<uid>/servers", () => {
    assert.strictEqual(
      ServerRuntimeRegistry.serverRuntimeRegistryDirectory({
        xdgRuntimeDir: "/run/user/1000",
        tmpDir: "/tmp",
        uid: 1000,
      }),
      "/run/user/1000/mesura-code/servers",
    );
    for (const xdgRuntimeDir of [undefined, "", "relative/dir"]) {
      assert.strictEqual(
        ServerRuntimeRegistry.serverRuntimeRegistryDirectory({
          xdgRuntimeDir,
          tmpDir: "/var/tmp",
          uid: 1000,
        }),
        "/var/tmp/mesura-code-1000/servers",
      );
    }
  });

  it("server registry directories: discovery reads both the XDG and the tmpdir registry, once each", () => {
    assert.deepStrictEqual(
      ServerRuntimeRegistry.serverRuntimeRegistryDirectories({
        xdgRuntimeDir: "/run/user/1000",
        tmpDir: "/tmp",
        uid: 1000,
      }),
      ["/run/user/1000/mesura-code/servers", "/tmp/mesura-code-1000/servers"],
    );
    assert.deepStrictEqual(
      ServerRuntimeRegistry.serverRuntimeRegistryDirectories({
        xdgRuntimeDir: undefined,
        tmpDir: "/tmp",
        uid: 1000,
      }),
      ["/tmp/mesura-code-1000/servers"],
    );
  });

  it.effect(
    "server registry layer: a Linux server writes <pid>.json in a 0700 directory and removes it on shutdown",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runtimeDir = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-registry-xdg-" });
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-registry-base-" });
        const directory = path.join(runtimeDir, "mesura-code", "servers");
        const entryPath = path.join(directory, `${process.pid}.json`);

        const scope = yield* Scope.make();
        const registeredAt = Date.parse("2026-09-29T03:15:35.000Z");
        yield* TestClock.setTime(registeredAt);
        yield* Layer.buildWithScope(
          ServerRuntimeRegistry.layer.pipe(Layer.provide(ServerConfig.layerTest(baseDir, baseDir))),
          scope,
        ).pipe(
          Effect.provideService(HostProcessEnvironment, { XDG_RUNTIME_DIR: runtimeDir }),
          Effect.provideService(HostProcessPlatform, "linux"),
        );

        const entry = yield* readEntry(entryPath);
        assert.strictEqual(entry.version, 1);
        assert.strictEqual(entry.pid, process.pid);
        assert.strictEqual(entry.baseDir, baseDir);
        assert.strictEqual(entry.stateDir, path.join(baseDir, "userdata"));
        assert.isUndefined(entry.devUrl);
        assert.strictEqual(Date.parse(entry.startedAt), registeredAt);
        assert.strictEqual((yield* fs.stat(directory)).mode & 0o777, 0o700);

        yield* Scope.close(scope, Exit.void);
        assert.isFalse(yield* fs.exists(entryPath));
      }),
  );

  it.effect("server registry layer: nothing is written on macOS or Windows", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runtimeDir = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-registry-xdg-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-registry-base-" });
      for (const platform of ["darwin", "win32"] as const) {
        yield* Effect.scoped(
          Layer.build(
            ServerRuntimeRegistry.layer.pipe(
              Layer.provide(ServerConfig.layerTest(baseDir, baseDir)),
            ),
          ).pipe(
            Effect.provideService(HostProcessEnvironment, { XDG_RUNTIME_DIR: runtimeDir }),
            Effect.provideService(HostProcessPlatform, platform),
          ),
        );
      }
      assert.deepStrictEqual(yield* fs.readDirectory(runtimeDir), []);
    }),
  );

  it.effect("server registry register: a dev server's entry carries its devUrl", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "mesura-registry-" }),
        "servers",
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ServerRuntimeRegistry.register({
            directory,
            pid: 4321,
            baseDir: "/home/dev/.mesura-code",
            stateDir: "/home/dev/.mesura-code/dev",
            devUrl: "http://localhost:5733/",
            isProcessAlive: () => true,
          });
          const entry = yield* readEntry(path.join(directory, "4321.json"));
          assert.strictEqual(entry.devUrl, "http://localhost:5733/");
          assert.strictEqual(entry.stateDir, "/home/dev/.mesura-code/dev");
        }),
      );
      assert.isFalse(yield* fs.exists(path.join(directory, "4321.json")));
    }),
  );

  it.effect(
    "server registry register: registering deletes entries whose PID is dead and keeps the rest",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-registry-" });
        for (const name of ["1111.json", "2222.json", "notes.txt", "garbage.json"]) {
          yield* fs.writeFileString(path.join(directory, name), "{}");
        }
        const alive = new Set([2222, 4321]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* ServerRuntimeRegistry.register({
              directory,
              pid: 4321,
              baseDir: "/b",
              stateDir: "/b/userdata",
              devUrl: undefined,
              isProcessAlive: (pid) => alive.has(pid),
            });
            assert.deepStrictEqual((yield* fs.readDirectory(directory)).toSorted(), [
              "2222.json",
              "4321.json",
              "garbage.json",
              "notes.txt",
            ]);
          }),
        );
      }),
  );

  /** Registers PID 4321 in `directory` for the life of one scope, then reports what is on disk. */
  const registerOnce = (directory: string) =>
    Effect.scoped(
      ServerRuntimeRegistry.register({
        directory,
        pid: 4321,
        baseDir: "/b",
        stateDir: "/b/userdata",
        devUrl: undefined,
        isProcessAlive: () => true,
      }),
    );

  it.effect(
    "server registry safety: a registry directory owned by another user is neither written, tightened nor read",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const uid = yield* HostProcessUserId;
        if (uid === undefined) return;
        const directory = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "mesura-registry-" }),
          "servers",
        );
        yield* fs.makeDirectory(directory, { mode: 0o755 });
        yield* fs.chmod(directory, 0o755);
        yield* fs.writeFileString(
          path.join(directory, "1234.json"),
          ServerRuntimeRegistry.encodeServerRuntimeRegistryEntry({
            version: 1,
            pid: 1234,
            startedAt: "2026-09-29T03:15:35.000Z",
            baseDir: "/forged",
            stateDir: "/forged/userdata",
          }),
        );
        // Seen as another user, the directory (and its parent) belong to someone else.
        const asAnotherUser = Effect.provideService(HostProcessUserId, uid + 1);
        yield* registerOnce(directory).pipe(asAnotherUser);
        assert.deepStrictEqual(yield* fs.readDirectory(directory), ["1234.json"]);
        assert.strictEqual((yield* fs.stat(directory)).mode & 0o777, 0o755);
        assert.deepStrictEqual(
          yield* ServerRuntimeRegistry.readServerRuntimeRegistry(directory).pipe(asAnotherUser),
          [],
        );
      }),
  );

  it.effect(
    "server registry safety: a registry path through a symlink creates, tightens and reads nothing behind it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-registry-" });
        const target = path.join(root, "elsewhere");
        yield* fs.makeDirectory(target);
        yield* fs.chmod(target, 0o755);
        const link = path.join(root, "mesura-code-1000");
        yield* fs.symlink(target, link);

        yield* registerOnce(path.join(link, "servers"));
        assert.deepStrictEqual(yield* fs.readDirectory(target), []);
        assert.strictEqual((yield* fs.stat(target)).mode & 0o777, 0o755);

        // A leaf that is itself a symlink is refused for reading too.
        yield* fs.writeFileString(
          path.join(target, "1234.json"),
          ServerRuntimeRegistry.encodeServerRuntimeRegistryEntry({
            version: 1,
            pid: 1234,
            startedAt: "2026-09-29T03:15:35.000Z",
            baseDir: "/forged",
            stateDir: "/forged/userdata",
          }),
        );
        assert.deepStrictEqual(yield* ServerRuntimeRegistry.readServerRuntimeRegistry(link), []);
      }),
  );

  it.effect(
    "server registry safety: an ancestor other users can write without the sticky bit is refused",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-registry-" });
        const open = path.join(root, "open");
        yield* fs.makeDirectory(open);
        yield* fs.chmod(open, 0o777);
        yield* registerOnce(path.join(open, "mesura-code", "servers"));
        assert.deepStrictEqual(yield* fs.readDirectory(open), []);
        // With the sticky bit, as /tmp has, the same ancestor is safe.
        yield* fs.chmod(open, 0o1777);
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* ServerRuntimeRegistry.register({
              directory: path.join(open, "mesura-code", "servers"),
              pid: 4321,
              baseDir: "/b",
              stateDir: "/b/userdata",
              devUrl: undefined,
              isProcessAlive: () => true,
            });
            assert.deepStrictEqual(
              yield* fs.readDirectory(path.join(open, "mesura-code", "servers")),
              ["4321.json"],
            );
            assert.strictEqual(
              (yield* fs.stat(path.join(open, "mesura-code"))).mode & 0o777,
              0o700,
            );
          }),
        );
      }),
  );

  it.effect(
    "server registry safety: a loose registry directory of this user is tightened to 0700 before use",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "mesura-registry-" }),
          "servers",
        );
        yield* fs.makeDirectory(directory);
        yield* fs.chmod(directory, 0o777);
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* ServerRuntimeRegistry.register({
              directory,
              pid: 4321,
              baseDir: "/b",
              stateDir: "/b/userdata",
              devUrl: undefined,
              isProcessAlive: () => true,
            });
            assert.strictEqual((yield* fs.stat(directory)).mode & 0o777, 0o700);
            assert.deepStrictEqual(yield* fs.readDirectory(directory), ["4321.json"]);
          }),
        );
      }),
  );

  it.effect(
    "server registry round trip: discovery counts the entry a registered server writes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Reads the real /proc of this test process: nothing to read without one.
        const uid = yield* HostProcessUserId;
        if (uid === undefined || !(yield* fs.exists("/proc/self/stat"))) return;
        // A /proc holding only this test process, read from the real one.
        const procRoot = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-registry-proc-" });
        yield* copyProcFile("/proc/stat", path.join(procRoot, "stat"));
        const own = path.join(procRoot, String(process.pid));
        yield* fs.makeDirectory(own);
        for (const name of ["stat", "status"]) {
          yield* copyProcFile(path.join("/proc/self", name), path.join(own, name));
        }
        // Registration happens seconds after a server process starts.
        const btime = Number(/^btime\s+(\d+)/m.exec(yield* fs.readFileString("/proc/stat"))?.[1]);
        const ownStat = yield* fs.readFileString(path.join(own, "stat"));
        const startTicks = Number(ownStat.slice(ownStat.lastIndexOf(")") + 2).split(" ")[19]);
        yield* TestClock.setTime(btime * 1000 + startTicks * 10 + 5_000);
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-registry-" });
        const discovery = yield* MesuraServerDiscovery.make({
          procRoot,
          registryDirectories: [directory],
          uid,
          defaultStateHome: path.join(directory, "no-home"),
          self: { pid: -1, dev: false },
        }).pipe(Effect.provideService(HostProcessPlatform, "linux"));

        // The counting server (not this process) always counts itself as one installed server.
        assert.deepStrictEqual(yield* discovery.discover, { installed: 1, dev: 0 });
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* ServerRuntimeRegistry.register({
              directory,
              pid: process.pid,
              baseDir: "/opt/custom-base",
              stateDir: "/opt/custom-base/dev",
              devUrl: "http://localhost:5733/",
              isProcessAlive: () => true,
            });
            assert.deepStrictEqual(yield* discovery.discover, { installed: 1, dev: 1 });
          }),
        );
        assert.deepStrictEqual(yield* discovery.discover, { installed: 1, dev: 0 });
      }),
  );
});
