import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import { ensureScratchpadRoot } from "./scratchpadRoot.ts";

/** The real workspace guard with no projects, worktrees or threads: only the scratchpad remains. */
const layer = KnownWorkspaces.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) })),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-scratchpad-root-" })),
  Layer.provideMerge(NodeServices.layer),
);

describe("the scratchpad folder", () => {
  it.effect("exists after the config is built, and file writes accept it as a workspace", () =>
    Effect.gen(function* () {
      const root = yield* ensureScratchpadRoot();
      const fileSystem = yield* FileSystem.FileSystem;
      assert.isNotNull(root);
      if (root === null) return;
      assert.isTrue(yield* fileSystem.exists(root));

      const known = yield* KnownWorkspaces.KnownWorkspaces;
      yield* known.assertContains(root);
      const nested = (yield* Path.Path).join(root, "projects");
      yield* fileSystem.makeDirectory(nested, { recursive: true });
      yield* known.assertContains(nested);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("does not open the rest of the state directory to writes", () =>
    Effect.gen(function* () {
      const root = yield* ensureScratchpadRoot();
      assert.isNotNull(root);
      if (root === null) return;
      const known = yield* KnownWorkspaces.KnownWorkspaces;
      const stateDir = (yield* Path.Path).dirname(root);
      const refused = yield* known.assertContains(stateDir).pipe(Effect.flip);
      assert.instanceOf(refused, KnownWorkspaces.UnknownWorkspaceError);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses a scratchpad folder that is a symlink, even to the state directory", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const link = path.join(config.stateDir, "scratchpads");
      yield* fileSystem.makeDirectory(config.stateDir, { recursive: true });
      yield* fileSystem.remove(link, { recursive: true }).pipe(Effect.ignore);
      yield* fileSystem.symlink(config.stateDir, link);

      assert.isNull(yield* ensureScratchpadRoot(), "a linked folder was announced to clients");
      const known = yield* KnownWorkspaces.KnownWorkspaces;
      for (const cwd of [link, config.stateDir]) {
        const refused = yield* known.assertContains(cwd).pipe(Effect.flip);
        assert.instanceOf(refused, KnownWorkspaces.UnknownWorkspaceError);
      }
    }).pipe(Effect.provide(layer)),
  );
});
