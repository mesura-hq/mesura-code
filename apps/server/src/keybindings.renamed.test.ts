import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "./config.ts";
import * as Keybindings from "./keybindings.ts";

/**
 * Fork guard. A rule stored under a command id this fork renamed must load
 * as the new command, keep the user's key, and raise no config issue — an
 * issue would stop the startup backfill for every other default too.
 */
const makeKeybindingsLayer = () =>
  Keybindings.layer.pipe(
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-keybindings-renamed-" })),
    ),
  );

it.layer(NodeServices.layer)("renamed keybinding commands", (it) => {
  it.effect("loads a rule stored under the old id as the new command, without an issue", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* fs.writeFileString(
        keybindingsConfigPath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify([
          { key: "mod+shift+e", command: "fileTree.overview", when: "!terminalFocus" },
          { key: "mod+j", command: "terminal.toggle" },
        ]),
      );

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return yield* keybindings.loadConfigState;
      });

      assert.deepEqual(configState.issues, []);
      const miller = configState.keybindings.filter((entry) => entry.command === "fileTree.miller");
      assert.lengthOf(miller, 1);
      assert.deepEqual(miller[0]?.shortcut, {
        key: "e",
        metaKey: false,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
        modKey: true,
      });
      assert.deepEqual(miller[0]?.whenAst, {
        type: "not",
        node: { type: "identifier", name: "terminalFocus" },
      });
      assert.isFalse(
        configState.keybindings.some((entry) => String(entry.command) === "fileTree.overview"),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );
});
