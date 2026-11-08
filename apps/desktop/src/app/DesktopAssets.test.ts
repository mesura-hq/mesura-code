import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

describe("DesktopAssets", () => {
  it.effect("uses the rounded production icon for unpackaged Linux", () =>
    Effect.gen(function* () {
      const productionEnvironmentLayer = DesktopEnvironment.layer({
        dirname: "/repo/apps/desktop/dist-electron",
        homeDirectory: "/Users/alice",
        platform: "linux",
        processArch: "x64",
        appVersion: "1.2.3",
        appPath: "/repo",
        isPackaged: false,
        resourcesPath: "/repo/apps/desktop/resources",
        runningUnderArm64Translation: false,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest({})),
        ),
      );
      const fileSystemLayer = FileSystem.layerNoop({
        exists: (path) => Effect.succeed(String(path).endsWith("black-linux-1024.png")),
      });
      const assets = yield* DesktopAssets.DesktopAssets.pipe(
        Effect.provide(
          DesktopAssets.layer.pipe(
            Layer.provide(Layer.merge(fileSystemLayer, productionEnvironmentLayer)),
          ),
        ),
      );

      const icons = yield* assets.iconPaths;

      assert.match(Option.getOrThrow(icons.png), /assets\/prod\/black-linux-1024\.png$/);
    }),
  );
});
