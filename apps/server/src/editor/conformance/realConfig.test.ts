// @effect-diagnostics nodeBuiltinImport:off - reads the developer's own config directory.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { NodeNvimAdapter } from "../NodeNvimAdapter.ts";
import { NvimBridge } from "../NvimBridge.ts";

/**
 * The developer's own configuration, driven.
 *
 * Gated on `MESURA_NVIM_CONFIG_DIR` on purpose, and it cannot run in
 * continuous integration: the configuration is a separate repository and its
 * first start installs 55 plugins under `stdpath('data')`. Run it on a machine
 * that has both:
 *
 *   MESURA_NVIM_CONFIG_DIR=~/.neovim vp test run src/editor/conformance/realConfig.test.ts
 *
 * What it proves is the thing no unit test can: that the mappings the
 * developer actually uses still behave under `--embed`, with the host plugin
 * loaded after the configuration, and that the mirror equals the buffer after
 * each of them. A mapping that silently stops working is exactly the failure
 * this whole cycle exists to prevent.
 */

const configDirectory = (() => {
  const raw = process.env["MESURA_NVIM_CONFIG_DIR"];
  if (raw === undefined || raw.trim() === "") return null;
  const expanded = raw.startsWith("~/") ? `${NodeOS.homedir()}/${raw.slice(2)}` : raw;
  try {
    return NodeFS.statSync(expanded).isDirectory() ? expanded : null;
  } catch {
    return null;
  }
})();

const nvimAvailable = (() => {
  try {
    NodeChildProcess.execFileSync("nvim", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const enabled = configDirectory !== null && nvimAvailable;

const layer = NodeNvimAdapter.layer.pipe(Layer.provideMerge(NodeServices.layer));

/** Opens a bridge over the real configuration, seeded with `lines`. */
const withRealConfig = <A>(
  lines: ReadonlyArray<string>,
  filename: string,
  body: (bridge: NvimBridge.Session) => Effect.Effect<A, never, never>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-real-config-" });
    // The file is written and opened in argv rather than over RPC. This
    // configuration shows a dashboard when Neovim is given nothing to open,
    // and it opens it from a deferred callback after `VimEnter` — so a file
    // opened right after connecting is opened and then taken away again.
    const path = `${root}/${filename}`;
    yield* fs.writeFileString(path, `${lines.join("\n")}\n`);
    const bridge = yield* NvimBridge.spawn({
      cols: 120,
      rows: 40,
      configDirectory: configDirectory as string,
      stateDir: root,
      cwd: root,
      initialFile: path,
    });
    yield* bridge.settle;
    return yield* body(bridge);
  }).pipe(Effect.scoped);

/** Types keys and returns once Neovim has executed them, never on a clock. */
const send = (bridge: NvimBridge.Session, keys: string) =>
  Effect.gen(function* () {
    yield* bridge.type(keys);
    yield* bridge.settle;
  });

/** Asserts the mirror still equals what Neovim itself reports. */
const assertMirrored = (bridge: NvimBridge.Session) =>
  Effect.gen(function* () {
    const lines = (yield* bridge.request("nvim_buf_get_lines", [0, 0, -1, false])) as string[];
    assert.deepStrictEqual(bridge.lines, lines, "the mirror equals the buffer");
  });

if (!enabled) {
  it("skips the real-configuration harness", () => {
    // Said out loud rather than silently absent: a harness that vanishes looks
    // the same as a harness that passed.
    assert.isTrue(
      configDirectory === null || !nvimAvailable,
      "MESURA_NVIM_CONFIG_DIR names a directory and nvim is on PATH, so this should have run",
    );
  });
}

if (enabled)
  it.layer(layer, { excludeTestServices: true })("the developer's configuration, driven", (it) => {
    it.effect("starts, loads the configuration and reports the host flag", () =>
      withRealConfig(["const value = 1;"], "probe.ts", (bridge) =>
        Effect.gen(function* () {
          const flag = (yield* bridge.request("nvim_exec_lua", [
            "return vim.g.mesura",
            [],
          ])) as number;
          assert.strictEqual(flag, 1);
          const plugins = (yield* bridge.request("nvim_exec_lua", [
            "return #vim.tbl_keys(require('lazy.core.config').plugins)",
            [],
          ])) as number;
          assert.isAbove(plugins, 0, "lazy.nvim loaded the plugin list");
        }).pipe(Effect.orDie),
      ),
    );

    it.effect("flash labels a jump target on s and takes it", () =>
      withRealConfig(["alpha beta", "gamma delta", "epsilon zeta"], "jump.lua", (bridge) =>
        Effect.gen(function* () {
          // `input` here, not `type`. Flash blocks Neovim's main loop waiting for
          // a label, so nothing answers over RPC while the labels are on screen —
          // and the labels are the whole point. They arrive as a redraw on the
          // notification stream, which needs no reply, so frames are what this
          // waits on. `<Esc>` then unblocks it.
          yield* bridge.input("se");

          // Frames, not a clock, and bounded rather than endless. `nvim_input`
          // is asynchronous, so the first frame after it is usually a status
          // line or a notifier redrawing and not flash at all. The bound is what
          // turns "flash never drew" into a failure instead of a hung suite.
          let frames = 0;
          while (bridge.overlays.length === 0 && frames < 40) {
            yield* bridge.awaitFrame;
            frames += 1;
          }

          // Flash draws its labels as virtual cells over the buffer text, which
          // is the classification phase 1 built. If none appear, either flash
          // did not load or the host's column equality broke.
          assert.isAbove(bridge.overlays.length, 0, "flash drew labels");

          yield* bridge.input("<Esc>");
          yield* bridge.settle;
          yield* assertMirrored(bridge);
        }).pipe(Effect.orDie),
      ),
    );

    it.effect('ci" changes inside the quotes', () =>
      withRealConfig(['const a = "old";'], "quote.ts", (bridge) =>
        Effect.gen(function* () {
          // One sequence, not four. `type` finishes the typeahead before it
          // answers, so a lone `ci"` would be aborted on the way into insert
          // mode and the text that followed would be read as normal-mode keys.
          yield* send(bridge, 'f"ci"new<Esc>');
          assert.deepStrictEqual(bridge.lines, ['const a = "new";']);
          yield* assertMirrored(bridge);
        }).pipe(Effect.orDie),
      ),
    );

    it.effect("gz surrounds a word, which is his own remapping rather than the default", () =>
      withRealConfig(["alpha beta"], "surround.ts", (bridge) =>
        Effect.gen(function* () {
          // One `nvim_input`, not two. `gziw` leaves nvim-surround waiting for
          // the character to surround with, and waiting draws nothing — so a
          // `send` after it waits for a redraw that never comes. The whole
          // sequence goes in together and the completed surround is what draws.
          yield* send(bridge, 'gziw"');
          yield* assertMirrored(bridge);
          assert.deepStrictEqual(bridge.lines, ['"alpha" beta']);
        }).pipe(Effect.orDie),
      ),
    );

    it.effect("viq selects inside the nearest quote pair", () =>
      withRealConfig(['x = "inside" y'], "textobject.ts", (bridge) =>
        Effect.gen(function* () {
          yield* send(bridge, "viq");
          yield* send(bridge, "d");
          assert.deepStrictEqual(bridge.lines, ['x = "" y']);
          yield* assertMirrored(bridge);
        }).pipe(Effect.orDie),
      ),
    );

    it.effect("leaves no treesitter highlighter on a TypeScript buffer", () =>
      withRealConfig(["const value: number = 1;"], "highlight.ts", (bridge) =>
        Effect.gen(function* () {
          const attached = (yield* bridge.request("nvim_exec_lua", [
            "return vim.treesitter.highlighter.active[vim.api.nvim_get_current_buf()] ~= nil",
            [],
          ])) as boolean;
          assert.isFalse(attached);
        }).pipe(Effect.orDie),
      ),
    );

    it.effect("takes back the three options his configuration sets against the host", () =>
      withRealConfig(["one"], "options.ts", (bridge) =>
        Effect.gen(function* () {
          const options = (yield* bridge.request("nvim_exec_lua", [
            "return { vim.wo.relativenumber, vim.wo.signcolumn, vim.wo.scrolloff, vim.wo.list }",
            [],
          ])) as [boolean, string, number, boolean];
          assert.deepStrictEqual(options, [false, "no", 0, false]);
        }).pipe(Effect.orDie),
      ),
    );
  });
