import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as T3ProjectFileLoader from "./T3ProjectFileLoader.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(T3ProjectFileLoader.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-project-file-",
  });
});

const writeProjectFile = Effect.fn("writeProjectFile")(function* (cwd: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(path.join(cwd, "t3.json"), contents).pipe(Effect.orDie);
});

it.layer(TestLayer)("T3ProjectFileLoader", (it) => {
  it.effect("preserves legacy defaults when the Mesura path cannot be read as a file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
      const cwd = yield* makeTempDir;
      yield* fileSystem.makeDirectory(path.join(cwd, ".mesura.json"));
      yield* writeProjectFile(cwd, '{ "defaultThreadEnvMode": "worktree" }');
      const defaults = yield* loader.loadRepositoryDefaults(cwd);
      expect(defaults.defaultThreadEnvMode).toEqual({ value: "worktree", source: "t3" });
      expect(defaults.defaultModelSelection).toEqual({ value: undefined, source: null });
      expect(defaults.iconCandidates).toEqual([]);
    }),
  );

  it.effect(
    "loads Mesura defaults per checkout and logs invalid files without losing t3 values",
    () => {
      const messages: unknown[] = [];
      const logger = Logger.make<unknown, void>(({ message }) => messages.push(message));
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const first = yield* makeTempDir;
        const second = yield* makeTempDir;
        yield* fileSystem.writeFileString(
          path.join(first, ".mesura.json"),
          '{ "version": 1, "defaultModelSelection": { "provider": "codex", "model": "model-a" } }',
        );
        yield* fileSystem.writeFileString(path.join(second, ".mesura.json"), "{ broken");
        yield* writeProjectFile(second, '{ "defaultThreadEnvMode": "local" }');

        expect((yield* loader.loadRepositoryDefaults(first)).defaultModelSelection).toEqual({
          value: { provider: "codex", model: "model-a" },
          source: "mesura",
        });
        const defaults = yield* loader.loadRepositoryDefaults(second);
        expect(defaults.defaultModelSelection).toEqual({ value: undefined, source: null });
        expect(defaults.defaultThreadEnvMode).toEqual({ value: "local", source: "t3" });
        expect(messages).toContainEqual([
          expect.objectContaining({
            operation: "decode",
            workspaceRoot: second,
            filePath: path.join(second, ".mesura.json"),
            fileName: ".mesura.json",
          }),
        ]);

        yield* writeProjectFile(first, "{ broken");
        expect((yield* loader.loadRepositoryDefaults(first)).defaultModelSelection.source).toBe(
          "mesura",
        );
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    },
  );

  describe("load", () => {
    it.effect("loads and decodes a valid t3.json", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(
          cwd,
          `{
            // JSONC is tolerated
            "iconPath": "assets/logo.svg",
            "scripts": [{ "name": "Dev", "command": "pnpm dev" }],
          }`,
        );

        const loaded = yield* loader.load(cwd);

        expect(Option.isSome(loaded)).toBe(true);
        if (Option.isSome(loaded)) {
          expect(loaded.value.iconPath).toBe("assets/logo.svg");
          expect(loaded.value.scripts).toEqual([{ name: "Dev", command: "pnpm dev" }]);
        }
      }),
    );

    it.effect("returns none when t3.json is missing", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );

    it.effect("returns none for malformed JSON without failing", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, "{ not json");

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );

    it.effect("returns none for schema-invalid files without failing", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, '{ "scripts": [{ "name": "Dev" }] }');

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );
  });
});
