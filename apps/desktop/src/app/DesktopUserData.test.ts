import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { resolveUserDataPath } from "./DesktopUserData.ts";

// Mesura: this fork's own names resolve both entries to one directory, which
// leaves the migration branches unreachable. Distinct names keep upstream's
// Windows migration behavior under test.
const distinctDirectoryNames = { current: "current-profile", legacy: "legacy-profile" };

it.effect("identifies a failed source read and preserves its cause", () => {
  const sourceState = "/profiles/legacy-profile/Local State";
  const cause = PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "readFileString",
    pathOrDescriptor: sourceState,
  });
  return Effect.gen(function* () {
    const error = yield* resolveUserDataPath({
      appDataDirectory: "/profiles",
      isDevelopment: false,
      platform: "win32",
      directoryNames: distinctDirectoryNames,
    }).pipe(Effect.flip);
    assert.equal(error.operation, "read");
    assert.equal(error.resourcePath, sourceState);
    assert.equal(error.category, "PermissionDenied");
    assert.strictEqual(error.cause, cause);
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: (path) => Effect.succeed(path === sourceState),
        readFileString: () => Effect.fail(cause),
      }),
    ),
    Effect.provide(NodeServices.layer),
  );
});

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
      for (const t3Name of ["t3code", "t3code-v2", "T3 Code (Alpha)", "T3 Code (Dev)"]) {
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
