import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { loadReportedProfiles, saveReportedProfiles } from "./ReportedBrowserProfiles.ts";

const recordWarnings = () => {
  const warnings: Array<string> = [];
  const logger = Logger.make(({ message, logLevel }) => {
    const text = Array.isArray(message) ? message[0] : message;
    if (logLevel === "Warn" && typeof text === "string") warnings.push(text);
  });
  return { warnings, layer: Logger.layer([logger], { mergeWithExisting: false }) };
};

const inTempDir = <A, E>(
  use: (dir: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* use(yield* fs.makeTempDirectoryScoped({ prefix: "t3-reported-profiles-" }));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("saved browser profiles load back after a save", () =>
  inTempDir((dir) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const file = path.join(dir, "nested", "reported-profiles.json");
      yield* saveReportedProfiles(file, {
        profiles: [{ id: "profile-work", name: "Work", kind: "persistent" }],
        defaultProfileId: "profile-work",
        recordingFrameRate: 60,
      });
      const loaded = yield* loadReportedProfiles(file);
      assert.deepEqual(Option.getOrUndefined(loaded), {
        profiles: [{ id: "profile-work", name: "Work", kind: "persistent" }],
        defaultProfileId: "profile-work",
      });
    }),
  ),
);

it.effect("a missing saved profile file loads as nothing without a warning", () => {
  const { warnings, layer } = recordWarnings();
  return inTempDir((dir) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const loaded = yield* loadReportedProfiles(path.join(dir, "reported-profiles.json"));
      assert.isTrue(Option.isNone(loaded));
      assert.deepEqual(warnings, []);
    }).pipe(Effect.provide(layer)),
  );
});

it.effect.each([
  { case: "corrupt JSON", write: "{not json" as string | null },
  { case: "a wrong shape", write: '{"profiles":"nope"}' as string | null },
  { case: "an unreadable path", write: null },
])("a saved profile file with $case is ignored with a warning", ({ write }) => {
  const { warnings, layer } = recordWarnings();
  return inTempDir((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(dir, "reported-profiles.json");
      // A directory at the file's path fails the read itself, not the decode.
      if (write === null) yield* fs.makeDirectory(file);
      else yield* fs.writeFileString(file, write);
      const loaded = yield* loadReportedProfiles(file);
      assert.isTrue(Option.isNone(loaded));
      assert.deepEqual(warnings, ["Ignoring unreadable saved browser profiles."]);
    }).pipe(Effect.provide(layer)),
  );
});
