import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { clearStaleGpuCaches, resolveUserDataPath } from "./DesktopUserData.ts";

// Mesura: this fork's own names resolve both entries to one directory, which
// leaves the migration branches unreachable. Distinct names keep upstream's
// Windows migration behavior under test.
const distinctDirectoryNames = { current: "current-profile", legacy: "legacy-profile" };

it.effect("preserves Windows credential keys without copying browser databases", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-profile-" });
    const source = path.join(directory, distinctDirectoryNames.legacy);
    const destination = path.join(directory, distinctDirectoryNames.current);
    const state = '{"os_crypt":{"encrypted_key":"test-encrypted-key"}}';
    yield* fs.makeDirectory(path.join(source, "IndexedDB"), { recursive: true });
    yield* fs.writeFileString(path.join(source, "Local State"), state);
    yield* fs.writeFileString(path.join(source, "IndexedDB", "LOCK"), "V1 owns this database");
    const resolve = resolveUserDataPath({
      appDataDirectory: directory,
      isDevelopment: false,
      platform: "win32",
      directoryNames: distinctDirectoryNames,
    });
    yield* resolve;
    assert.equal(yield* fs.readFileString(path.join(destination, "Local State")), state);
    assert.equal(yield* fs.readFileString(path.join(source, "Local State")), state);
    assert.isFalse(yield* fs.exists(path.join(destination, "IndexedDB")));
    yield* fs.writeFileString(path.join(destination, "Local State"), "existing V2 state");
    yield* resolve;
    assert.equal(
      yield* fs.readFileString(path.join(destination, "Local State")),
      "existing V2 state",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { platform: "linux" as const, isDevelopment: false, expected: "mesura-code" },
  { platform: "win32" as const, isDevelopment: false, expected: "mesura-code" },
  { platform: "linux" as const, isDevelopment: true, expected: "mesura-code-dev" },
])(
  "owns the Mesura profile and never copies the installed T3 Code's keys ($platform, dev=$isDevelopment)",
  ({ platform, isDevelopment, expected }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-profile-" });
      for (const t3Name of [
        "t3code",
        "t3code-v2",
        "T3 Code (Alpha)",
        "T3 Code (Beta)",
        "T3 Code (Dev)",
      ]) {
        yield* fs.makeDirectory(path.join(directory, t3Name), { recursive: true });
        yield* fs.writeFileString(path.join(directory, t3Name, "Local State"), "t3 keys");
      }
      const userData = yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment,
        platform,
      });
      assert.equal(userData, path.join(directory, expected));
      assert.isFalse(yield* fs.exists(path.join(userData, "Local State")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps using the legacy development profile when the two names differ", () =>
  Effect.gen(function* () {
    const resolveWith = (legacyExists: boolean) =>
      resolveUserDataPath({
        appDataDirectory: "/profiles",
        isDevelopment: true,
        platform: "linux",
        directoryNames: distinctDirectoryNames,
      }).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({ exists: () => Effect.succeed(legacyExists) }),
        ),
      );
    assert.equal(yield* resolveWith(true), "/profiles/legacy-profile");
    assert.equal(yield* resolveWith(false), "/profiles/current-profile");
  }).pipe(Effect.provide(NodeServices.layer)),
);

const gpuCacheDirectories = [
  "GPUCache",
  "GrShaderCache",
  "ShaderCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GPUPersistentCache",
];

it.effect.each([
  { profile: "written by Electron 44.10.0", marker: "44.10.0" },
  { profile: "with no recorded Electron version", marker: undefined },
])("clears GPU caches $profile once when Electron 44.10.1 starts", ({ marker }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const userDataPath = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-gpu-cache-" });
    for (const name of gpuCacheDirectories) {
      yield* fs.makeDirectory(path.join(userDataPath, name), { recursive: true });
      yield* fs.writeFileString(path.join(userDataPath, name, "data_0"), "44.10.0 shaders");
    }
    yield* fs.makeDirectory(path.join(userDataPath, "Local Storage"), { recursive: true });
    yield* fs.writeFileString(path.join(userDataPath, "Local Storage", "LOCK"), "profile");
    yield* fs.writeFileString(path.join(userDataPath, "Local State"), "profile");
    if (marker !== undefined) {
      yield* fs.writeFileString(path.join(userDataPath, "gpu-cache-electron-version"), marker);
    }

    yield* clearStaleGpuCaches({ userDataPath, electronVersion: "44.10.1" });

    const survivingCaches: Array<string> = [];
    for (const name of gpuCacheDirectories) {
      if (yield* fs.exists(path.join(userDataPath, name))) survivingCaches.push(name);
    }
    assert.deepStrictEqual(survivingCaches, []);
    assert.equal(
      yield* fs.readFileString(path.join(userDataPath, "Local Storage", "LOCK")),
      "profile",
    );
    assert.equal(yield* fs.readFileString(path.join(userDataPath, "Local State")), "profile");

    yield* fs.makeDirectory(path.join(userDataPath, "GPUCache"));
    yield* fs.writeFileString(path.join(userDataPath, "GPUCache", "data_0"), "44.10.1 shaders");
    yield* clearStaleGpuCaches({ userDataPath, electronVersion: "44.10.1" });
    assert.equal(
      yield* fs.readFileString(path.join(userDataPath, "GPUCache", "data_0")),
      "44.10.1 shaders",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps GPU caches built on the first launch of a fresh install", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const appData = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-fresh-" });
    const userDataPath = path.join(appData, "t3code-v2");

    yield* clearStaleGpuCaches({ userDataPath, electronVersion: "44.10.1" });
    yield* fs.makeDirectory(path.join(userDataPath, "GPUCache"));
    yield* fs.writeFileString(path.join(userDataPath, "GPUCache", "data_0"), "44.10.1 shaders");
    yield* clearStaleGpuCaches({ userDataPath, electronVersion: "44.10.1" });

    assert.equal(
      yield* fs.readFileString(path.join(userDataPath, "GPUCache", "data_0")),
      "44.10.1 shaders",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("retries on the next launch when a GPU cache cannot be removed", () =>
  Effect.gen(function* () {
    const writes: Array<string> = [];
    const fileSystem = FileSystem.makeNoop({
      remove: (path) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "remove",
            pathOrDescriptor: path,
          }),
        ),
      writeFileString: (path) =>
        Effect.sync(() => {
          writes.push(path);
        }),
    });

    yield* clearStaleGpuCaches({ userDataPath: "/profile", electronVersion: "44.10.1" }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );

    assert.deepStrictEqual(writes, []);
  }).pipe(Effect.provide(NodeServices.layer)),
);
