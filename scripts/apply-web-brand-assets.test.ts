import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { applyWebBrandAssets } from "./apply-web-brand-assets.ts";
import { resolveWebIconOverrides } from "./lib/brand-assets.ts";

const WEB_ICON_FILENAMES = [
  "apple-touch-icon.png",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "favicon.ico",
  "icon-192.png",
  "icon-512.png",
];

const assertCopiedProductionIcons = Effect.fn("test.assertCopiedProductionIcons")(function* (
  targetDirectory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
  for (const override of resolveWebIconOverrides("production", targetDirectory)) {
    assert.deepStrictEqual(
      yield* fs.readFile(override.targetRelativePath),
      yield* fs.readFile(path.join(repoRoot, override.sourceRelativePath)),
      override.targetRelativePath,
    );
  }
});

it.layer(NodeServices.layer)("apply-web-brand-assets", (it) => {
  it.effect("copies the icons into an absolute target directory as given", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const targetDirectory = yield* fs.makeTempDirectoryScoped({
        prefix: "apply-web-brand-assets-",
      });

      yield* applyWebBrandAssets("production", targetDirectory);

      assert.deepStrictEqual(
        (yield* fs.readDirectory(targetDirectory)).toSorted(),
        WEB_ICON_FILENAMES,
      );
      yield* assertCopiedProductionIcons(targetDirectory);
    }),
  );

  it.effect("resolves an empty target directory to the repo root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const destinations = resolveWebIconOverrides("production", repoRoot).map(
        (override) => override.targetRelativePath,
      );
      // readDirectory does not follow symlinks, so a dangling link counts as an existing entry.
      // Names are lowercased so a case-insensitive filesystem cannot hide a differently cased file.
      const existingEntries = new Set(
        (yield* fs.readDirectory(repoRoot)).map((entry) => entry.toLowerCase()),
      );
      for (const destination of destinations) {
        assert.isFalse(
          existingEntries.has(path.basename(destination)),
          `${destination} already exists`,
        );
      }
      yield* Effect.addFinalizer(() =>
        Effect.forEach(destinations, (destination) => fs.remove(destination, { force: true })).pipe(
          Effect.orDie,
        ),
      );

      yield* applyWebBrandAssets("production", "");

      yield* assertCopiedProductionIcons(repoRoot);
    }),
  );
});
