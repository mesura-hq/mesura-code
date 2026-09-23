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

          // A label the client cannot colour is a label it draws in the text's
          // own colours, which is one nobody can see. The id has to resolve to
          // a definition the wire can carry.
          const definitions = bridge.highlightDefinitions;
          const labelled = bridge.overlays.filter((overlay) => overlay.hl !== 0);
          assert.isNotEmpty(labelled, "the labels carry a highlight id, not the default");
          for (const overlay of labelled) {
            const definition = definitions.get(overlay.hl);
            assert.isDefined(definition, `highlight ${overlay.hl} is defined`);
            assert.isTrue(
              definition?.fg !== undefined ||
                definition?.bg !== undefined ||
                definition?.reverse === true,
              `highlight ${overlay.hl} resolves to a colour`,
            );
          }

          // Neovim reports normal mode throughout; the flag is what says the
          // next key picks a label. Read with the cursor after a frame, so it
          // can trail the labels by a frame or two.
          let waited = 0;
          while (!bridge.jumping && waited < 40) {
            yield* bridge.awaitFrame;
            waited += 1;
          }
          assert.isTrue(bridge.jumping, "the session reports flash as jumping");

          yield* bridge.input("<Esc>");
          yield* bridge.settle;
          assert.isFalse(bridge.jumping, "and not once the jump is abandoned");
          yield* assertMirrored(bridge);
        }).pipe(Effect.orDie),
      ),
    );

    it.effect("keeps the labels when an unrelated line changes under them", () =>
      withRealConfig(
        [
          "function alpha() {}",
          "function beta() {}",
          "function gamma() {}",
          "const untouched = 1;",
        ],
        "rows.lua",
        (bridge) =>
          Effect.gen(function* () {
            yield* bridge.input("sf");
            let frames = 0;
            while (bridge.overlays.length === 0 && frames < 40) {
              yield* bridge.awaitFrame;
              frames += 1;
            }
            const labelled = bridge.overlays.map(
              (overlay) => `${overlay.line}:${overlay.col}:${overlay.text}`,
            );
            assert.isNotEmpty(labelled, "flash drew labels");

            // A direct API write rather than a key, because flash is blocking
            // on a label and would take a keystroke as one. This is what an
            // agent's write looks like from Neovim's side, and it is the case
            // the per-row bookkeeping exists for: a line redrawing must not
            // take the labels off every other line with it.
            yield* bridge.request("nvim_buf_set_lines", [0, 3, 4, false, ["const changed = 2;"]]);
            yield* bridge.awaitFrame;

            const stillThere = bridge.overlays.map(
              (overlay) => `${overlay.line}:${overlay.col}:${overlay.text}`,
            );
            for (const label of labelled) {
              assert.include(stillThere, label, "a label on an untouched line survived");
            }

            yield* bridge.input("<Esc>");
            yield* bridge.settle;
          }).pipe(Effect.orDie),
      ),
    );

    it.effect("draws a search as highlight runs over the text it matched", () =>
      withRealConfig(["alpha target beta", "gamma delta", "target again"], "search.lua", (bridge) =>
        Effect.gen(function* () {
          // The search register directly, rather than the `/` key. Measured:
          // under his configuration `/target<CR>` moves the cursor onto the
          // match and leaves nothing highlighted, because flash owns `/` and
          // clears `hlsearch` when its jump finishes. Pressing the key here
          // would test flash's behaviour and call it this host's.
          yield* bridge.type(':let @/ = "target"<CR>');
          yield* bridge.type(":set hlsearch<CR>");
          yield* bridge.settle;

          // Frames, bounded, not one frame and a hope. Under a configuration
          // this size the redraw that paints the matches is not reliably the
          // next one — measured: one run in four reported nothing when this
          // waited for a single frame, which is a test that lies a quarter of
          // the time about a feature that works.
          let frames = 0;
          while (bridge.highlightRuns.length === 0 && frames < 40) {
            yield* bridge.awaitFrame;
            frames += 1;
          }

          const runs = bridge.highlightRuns;
          assert.isNotEmpty(runs, "the matches are marked");
          // Marked rather than drawn over: the characters are the file's own,
          // so they are runs and not overlays. A host that reported them as
          // overlays would draw the text twice.
          for (const run of runs) {
            assert.isAbove(run.endCol, run.startCol, "a run covers something");
          }

          yield* bridge.type(":noh<CR>");
          yield* bridge.settle;
          yield* assertMirrored(bridge);
        }).pipe(Effect.orDie),
      ),
    );

    it.effect("reports a selection for each of the three visual modes", () =>
      withRealConfig(["alpha beta", "gamma delta", "epsilon zeta"], "visual.lua", (bridge) =>
        Effect.gen(function* () {
          yield* bridge.type("ggv2j");
          yield* bridge.settle;
          const characterwise = bridge.visual;
          assert.isNotNull(characterwise, "a character-wise selection is reported");
          assert.strictEqual(characterwise?.anchor.line, 1, "anchored where it started");
          assert.strictEqual(characterwise?.cursor.line, 3, "and the cursor is where it is now");

          yield* bridge.type("<Esc>V");
          yield* bridge.settle;
          assert.strictEqual(bridge.visual?.kind.startsWith("V"), true, "line-wise says so");

          yield* bridge.type("<Esc><C-v>j");
          yield* bridge.settle;
          assert.strictEqual(bridge.visual?.kind.charCodeAt(0), 22, "and a block says so");

          yield* bridge.type("<Esc>");
          yield* bridge.settle;
          assert.isNull(bridge.visual, "leaving visual mode ends the selection");
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
