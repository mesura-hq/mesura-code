import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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

it.layer(TestLayer)("legacy repository behavior guard", (it) => {
  it.effect("keeps t3.json scripts and icon precedence", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
      const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "mesura-legacy-guard-" });
      yield* fileSystem.makeDirectory(path.join(cwd, "brand"));
      yield* fileSystem.writeFileString(path.join(cwd, "brand", "icon.svg"), "<svg/>");
      yield* fileSystem.writeFileString(path.join(cwd, "favicon.svg"), "<svg/>");
      yield* fileSystem.writeFileString(
        path.join(cwd, "t3.json"),
        `{
          "iconPath": "brand/icon.svg",
          "defaultThreadEnvMode": "local",
          "scripts": [{ "name": "Dev", "command": "pnpm dev" }]
        }`,
      );

      const legacy = yield* loader.load(cwd);
      expect(Option.isSome(legacy)).toBe(true);
      if (Option.isSome(legacy)) {
        expect(legacy.value.defaultThreadEnvMode).toBe("local");
        expect(legacy.value.scripts).toEqual([{ name: "Dev", command: "pnpm dev" }]);
      }
      expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "brand", "icon.svg"));
    }),
  );
});
