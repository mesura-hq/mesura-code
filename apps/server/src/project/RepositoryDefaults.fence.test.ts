import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "./T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(
    ProjectFaviconResolver.layer.pipe(
      Layer.provide(WorkspacePaths.layer),
      Layer.provide(T3ProjectFileLoader.layer),
    ),
  ),
  Layer.provideMerge(T3ProjectFileLoader.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeCheckout = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "mesura-defaults-fence-" });
});

const writeFile = Effect.fn("portableFence.writeFile")(function* (
  checkout: string,
  name: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(checkout, name);
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
});

it.layer(TestLayer)("repository defaults fence", (it) => {
  describe("repository defaults", () => {
    it.effect("inherits each omitted field from t3.json and retains legacy scripts", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeCheckout;
        yield* writeFile(
          cwd,
          "t3.json",
          `{
            "iconPath": "legacy/icon.svg",
            "defaultThreadEnvMode": "local",
            "scripts": [{ "name": "Dev", "command": "pnpm dev" }]
          }`,
        );
        yield* writeFile(cwd, ".mesura.json", '{ "version": 1 }');

        const inherited = yield* loader.loadRepositoryDefaults(cwd);
        expect(inherited.iconPath).toEqual({ value: "legacy/icon.svg", source: "t3" });
        expect(inherited.defaultThreadEnvMode).toEqual({ value: "local", source: "t3" });
        expect(inherited.scripts).toEqual([{ name: "Dev", command: "pnpm dev" }]);

        yield* writeFile(
          cwd,
          ".mesura.json",
          '{ "version": 1, "defaultThreadEnvMode": "worktree" }',
        );

        const defaults = yield* loader.loadRepositoryDefaults(cwd);
        expect(defaults.iconPath).toEqual({ value: "legacy/icon.svg", source: "t3" });
        expect(defaults.defaultThreadEnvMode).toEqual({ value: "worktree", source: "mesura" });
        expect(defaults.defaultModelSelection).toEqual({ value: undefined, source: null });
        expect(defaults.scripts).toEqual([{ name: "Dev", command: "pnpm dev" }]);
      }),
    );

    it.effect(
      "keeps empty defaults and automatic icon detection for missing or invalid files",
      () =>
        Effect.gen(function* () {
          const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
          const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
          const path = yield* Path.Path;
          for (const invalidContents of [
            null,
            "{ invalid json",
            '{ "version": 1, "iconPath": "../secret.svg" }',
          ]) {
            const cwd = yield* makeCheckout;
            yield* writeFile(cwd, "favicon.svg", "<svg/>");
            if (invalidContents !== null) yield* writeFile(cwd, ".mesura.json", invalidContents);
            const defaults = yield* loader.loadRepositoryDefaults(cwd);
            expect(defaults.iconPath).toEqual({ value: undefined, source: null });
            expect(defaults.defaultThreadEnvMode).toEqual({ value: undefined, source: null });
            expect(defaults.defaultModelSelection).toEqual({ value: undefined, source: null });
            expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "favicon.svg"));
          }

          const configuredCheckout = yield* makeCheckout;
          yield* writeFile(configuredCheckout, "brand/portable.svg", "<svg/>");
          yield* writeFile(configuredCheckout, "brand/legacy.svg", "<svg/>");
          yield* writeFile(configuredCheckout, "favicon.svg", "<svg/>");
          yield* writeFile(configuredCheckout, "t3.json", '{ "iconPath": "brand/legacy.svg" }');
          yield* writeFile(
            configuredCheckout,
            ".mesura.json",
            '{ "version": 1, "iconPath": "brand/portable.svg" }',
          );
          expect(yield* resolver.resolvePath(configuredCheckout)).toBe(
            path.join(configuredCheckout, "brand/portable.svg"),
          );

          const staleCheckout = yield* makeCheckout;
          yield* writeFile(staleCheckout, "brand/legacy.svg", "<svg/>");
          yield* writeFile(staleCheckout, "favicon.svg", "<svg/>");
          yield* writeFile(staleCheckout, "t3.json", '{ "iconPath": "brand/legacy.svg" }');
          yield* writeFile(
            staleCheckout,
            ".mesura.json",
            '{ "version": 1, "iconPath": "brand/missing.svg" }',
          );
          expect(yield* resolver.resolvePath(staleCheckout)).toBe(
            path.join(staleCheckout, "brand", "legacy.svg"),
          );
        }),
    );
  });
});
