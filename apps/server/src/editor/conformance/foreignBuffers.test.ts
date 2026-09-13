// @effect-diagnostics nodeBuiltinImport:off - locates the real nvim binary before spawning it.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { NodeNvimAdapter } from "../NodeNvimAdapter.ts";
import { APPLY_EDITS_LUA } from "../hostPlugin.ts";
import { NvimBridge, type NvimBridgeError } from "../NvimBridge.ts";

/**
 * The mirror follows the file, and nothing else.
 *
 * A real configuration puts a plugin behind a great many keys, and a plugin
 * shows itself by opening a buffer in the window: a picker, a git status, a
 * prompt, a terminal. Neovim announces every one of those the same way it
 * announces a file, so a host that follows the announcement follows the plugin.
 *
 * That is not a display problem. The mirrored lines are what the client renders
 * as the file and what the host later writes back to disk, so following a
 * plugin's buffer means the panel shows the plugin's window as though it were
 * the file, and the next save puts it on top of the source.
 *
 * **Measured, not imagined.** Driving the developer's own configuration
 * through the web app, `<C-e>` replaced the panel's contents with a git-status
 * window and `<C-f>` replaced them with a one-line prompt holding a single
 * emoji. `apps/server/src/editor/hostPlugin.ts` was on disk as that emoji, five
 * bytes, and was recovered from the commit.
 */

const nvimAvailable = (() => {
  try {
    NodeChildProcess.execFileSync("nvim", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const layer = NodeNvimAdapter.layer.pipe(Layer.provideMerge(NodeServices.layer));

const withNvim = <A>(
  body: (bridge: NvimBridge.Session) => Effect.Effect<A, NvimBridgeError, never>,
) =>
  Effect.gen(function* () {
    const bridge = yield* NvimBridge.spawn({ cols: 80, rows: 24 });
    return yield* body(bridge);
  }).pipe(Effect.scoped);

const THE_FILE = ["first", "second", "third"];

/**
 * Opens a file exactly the way the manager does.
 *
 * Both halves, because both are load-bearing: `mesura.open` puts the buffer in
 * the window, and `followBuffer` points the mirror at the buffer it answered
 * with. Nothing else moves the mirror — the `BufEnter` announcement that used
 * to is gone, because Neovim announces a plugin's window the same way it
 * announces a file.
 */
const openFile = (bridge: NvimBridge.Session, path: string, lines: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const buffer = (yield* bridge.request("nvim_exec_lua", [
      "return _G.mesura.open(...)",
      [path, [...lines]],
    ])) as number;
    yield* bridge.followBuffer(buffer);
    return buffer;
  });

it.layer(layer)("a buffer the host did not open", (it) => {
  it.effect.skipIf(!nvimAvailable)("does not become the file the client is shown", () =>
    withNvim((bridge) =>
      Effect.gen(function* () {
        yield* openFile(bridge, "/tmp/mesura-mirror-test/the-file.txt", THE_FILE);
        yield* bridge.settle;
        assert.deepStrictEqual(bridge.lines, THE_FILE, "the file did not open");

        // What every plugin does: a scratch buffer, in the window, announced
        // by `BufEnter` exactly as a file would be.
        yield* bridge.request("nvim_exec_lua", [
          `local buffer = vim.api.nvim_create_buf(false, true)
           vim.bo[buffer].buftype = "nofile"
           vim.api.nvim_buf_set_lines(buffer, 0, -1, false, { "PLUGIN UI", "not your file" })
           vim.api.nvim_set_current_buf(buffer)`,
          [],
        ]);
        yield* bridge.settle;

        assert.deepStrictEqual(
          bridge.lines,
          THE_FILE,
          "the mirror followed a plugin into its own buffer: the panel now shows that buffer as the file, and the next save writes it over the source",
        );
      }),
    ),
  );

  it.effect.skipIf(!nvimAvailable)("is what the mirror holds the moment `open` returns", () =>
    withNvim((bridge) =>
      Effect.gen(function* () {
        // A plugin already owns the window, which is the ordinary state under a
        // configuration that restores a session or opens a picker at start.
        yield* bridge.request("nvim_exec_lua", [
          `local buffer = vim.api.nvim_create_buf(false, true)
           vim.bo[buffer].buftype = "nofile"
           vim.api.nvim_buf_set_lines(buffer, 0, -1, false, { "PICKER PROMPT" })
           vim.api.nvim_set_current_buf(buffer)`,
          [],
        ]);
        yield* bridge.settle;

        // `open` answers with a snapshot built from the mirror, so the mirror
        // has to be on the file by the time it returns — not whenever the
        // `BufEnter` notification happens to be processed.
        const buffer = (yield* openFile(
          bridge,
          "/tmp/mesura-mirror-test/opened.txt",
          THE_FILE,
        )) as number;
        void buffer;

        assert.deepStrictEqual(
          bridge.lines,
          THE_FILE,
          "`open` would answer with the plugin's prompt as the file's contents, and the client would save that over the file",
        );
      }),
    ),
  );

  it.effect.skipIf(!nvimAvailable)(
    "takes an agent's write to the file, not to whatever holds the window",
    () =>
      withNvim((bridge) =>
        Effect.gen(function* () {
          yield* openFile(bridge, "/tmp/mesura-mirror-test/written.txt", THE_FILE);

          // A plugin takes the window. The mirror stays on the file, which is
          // the whole point of the rule above — and it is also what makes the
          // mirror's buffer and Neovim's *current* buffer disagree.
          yield* bridge.request("nvim_exec_lua", [
            `local buffer = vim.api.nvim_create_buf(false, true)
           vim.bo[buffer].buftype = "nofile"
           vim.api.nvim_buf_set_lines(buffer, 0, -1, false, { "PLUGIN UI" })
           vim.api.nvim_set_current_buf(buffer)`,
            [],
          ]);
          yield* bridge.settle;

          // What an agent's write does. Aimed at buffer `0` it lands in the
          // plugin's buffer: the edit never reaches the file, and the lines
          // event it causes is dropped by the mirror's own buffer guard, so
          // nothing anywhere reports that the write was lost.
          yield* bridge.request("nvim_exec_lua", [
            APPLY_EDITS_LUA,
            [bridge.attachedBuffer, [[0, 0, 0, 5, ["FIRST"]]]],
          ]);
          yield* bridge.settle;

          assert.deepStrictEqual(
            bridge.lines,
            ["FIRST", "second", "third"],
            "the write went somewhere other than the file the mirror is on",
          );
        }),
      ),
  );

  it.effect.skipIf(!nvimAvailable)("still lets the host move between its own files", () =>
    withNvim((bridge) =>
      Effect.gen(function* () {
        yield* openFile(bridge, "/tmp/mesura-mirror-test/one.txt", ["one"]);
        yield* bridge.settle;
        assert.deepStrictEqual(bridge.lines, ["one"]);

        // The guard must not cost the thing it protects: switching file is the
        // ordinary case and the mirror has to follow that.
        yield* openFile(bridge, "/tmp/mesura-mirror-test/two.txt", ["two", "lines"]);
        yield* bridge.settle;
        assert.deepStrictEqual(
          bridge.lines,
          ["two", "lines"],
          "the guard is too strict: the host can no longer follow its own file switch",
        );
      }),
    ),
  );
});
