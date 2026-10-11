import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { NodeNvimAdapter } from "../NodeNvimAdapter.ts";
import { NvimBridge } from "../NvimBridge.ts";
import { nvimAvailable, reportMissingNvim } from "./nvimOnPath.ts";

/**
 * The host plugin's buffer module, run rather than read.
 *
 * `Manager.test.ts` drives the manager against a fake Neovim that matches on
 * the string `mesura.open` and answers with a made-up buffer number. That
 * proves the manager sends the right call; it proves nothing at all about what
 * the call does, because no Lua runs. This file is the other half, and it is
 * the half where the mistakes were: the first version looked buffers up with
 * `vim.fn.bufnr`, which treats its argument as a Vim pattern whenever nothing
 * matches exactly — which is always, the first time a path is opened.
 */

const layer = NodeNvimAdapter.layer.pipe(Layer.provideMerge(NodeServices.layer));

/** Opens a bare session with the host plugin loaded, and nothing else. */
const withHost = <A>(body: (bridge: NvimBridge.Session, root: string) => Effect.Effect<A, never>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-host-buffers-" });
    const bridge = yield* NvimBridge.spawn({ cols: 80, rows: 24, cwd: root });
    yield* bridge.settle;
    return yield* body(bridge, root);
  }).pipe(Effect.scoped);

const lua = (bridge: NvimBridge.Session, code: string, args: ReadonlyArray<unknown> = []) =>
  bridge.request("nvim_exec_lua", [code, [...args]]);

if (!nvimAvailable) reportMissingNvim("host-buffer harness");

if (nvimAvailable)
  it.layer(layer, { excludeTestServices: true })("the host's buffers", (it) => {
    it.effect("opens a file's lines into a buffer the host owns", () =>
      withHost((bridge, root) =>
        Effect.gen(function* () {
          const path = `${root}/main.ts`;
          yield* lua(bridge, "return mesura.open(...)", [path, ["const a = 1;", "const b = 2;"]]);

          const state = (yield* lua(
            bridge,
            `return {
               name = vim.api.nvim_buf_get_name(0),
               buftype = vim.bo.buftype,
               filetype = vim.bo.filetype,
               modified = vim.bo.modified,
               lines = vim.api.nvim_buf_get_lines(0, 0, -1, false),
             }`,
          )) as Record<string, unknown>;

          assert.strictEqual(state["name"], path, "the window is on the file's buffer");
          // `acwrite` is what makes `:w` a request rather than a write: it
          // tells Neovim somebody else owns this file's bytes.
          assert.strictEqual(state["buftype"], "acwrite");
          assert.strictEqual(state["filetype"], "typescript", "so ftplugins load");
          assert.strictEqual(state["modified"], false, "a freshly opened file is not dirty");
          assert.deepStrictEqual(state["lines"], ["const a = 1;", "const b = 2;"]);
        }).pipe(Effect.orDie),
      ),
    );

    it.effect("moves the window between two files and back to the same buffer", () =>
      withHost((bridge, root) =>
        Effect.gen(function* () {
          const first = `${root}/first.ts`;
          const second = `${root}/second.ts`;

          const firstBuffer = yield* lua(bridge, "return mesura.open(...)", [first, ["one"]]);
          const secondBuffer = yield* lua(bridge, "return mesura.open(...)", [second, ["two"]]);
          assert.notStrictEqual(firstBuffer, secondBuffer, "two files, two buffers");

          const onSecond = yield* lua(bridge, "return vim.api.nvim_get_current_buf()");
          assert.strictEqual(onSecond, secondBuffer, "the window moved");

          const again = yield* lua(bridge, "return mesura.open(...)", [first, ["one"]]);
          assert.strictEqual(again, firstBuffer, "coming back reuses the buffer");
          assert.strictEqual(
            yield* lua(bridge, "return vim.api.nvim_get_current_buf()"),
            firstBuffer,
            "and the window went with it",
          );
        }).pipe(Effect.orDie),
      ),
    );

    it.effect("looks a buffer up by its exact name, not by pattern", () =>
      withHost((bridge, root) =>
        Effect.gen(function* () {
          // `vim.fn.bufnr(name)` falls back to Vim-pattern matching when no
          // buffer matches exactly — which is always the case the first time a
          // path is opened. Measured, with a real Neovim: with a buffer named
          // `…/plain.ts` open, `bufnr("…/plain")` answers that buffer rather
          // than -1. So a repository holding both `README` and `README.md` —
          // or `index` and `index.ts` — is enough for a lookup to hand back
          // the wrong file under the right name, and the developer edits one
          // believing it is the other.
          const extended = `${root}/README.md`;
          const bare = `${root}/README`;

          const extendedBuffer = yield* lua(bridge, "return mesura.open(...)", [
            extended,
            ["the long one"],
          ]);
          const bareBuffer = yield* lua(bridge, "return mesura.open(...)", [
            bare,
            ["the short one"],
          ]);

          assert.notStrictEqual(bareBuffer, extendedBuffer, "two files, two buffers");
          assert.strictEqual(
            yield* lua(bridge, "return vim.api.nvim_buf_get_name(0)"),
            bare,
            "and the window is on the one that was asked for",
          );
          assert.deepStrictEqual(
            yield* lua(bridge, "return vim.api.nvim_buf_get_lines(0, 0, -1, false)"),
            ["the short one"],
          );
        }).pipe(Effect.orDie),
      ),
    );

    it.effect("leaves the buffer alone when the lines have not changed", () =>
      withHost((bridge, root) =>
        Effect.gen(function* () {
          const path = `${root}/keep.ts`;
          yield* lua(bridge, "return mesura.open(...)", [path, ["one", "two"]]);
          yield* bridge.type("A!");
          yield* bridge.type("<Esc>");
          yield* bridge.settle;

          const before = yield* lua(bridge, "return vim.fn.undotree().seq_cur");
          assert.isAbove(before as number, 0, "there is some history to lose");

          // Read back rather than assumed: the point is to re-open with
          // exactly what the buffer already holds, and writing that out by
          // hand is how this test first failed against correct code.
          const current = (yield* lua(
            bridge,
            "return vim.api.nvim_buf_get_lines(0, 0, -1, false)",
          )) as string[];

          // Setting identical lines still resets undo and moves every mark, so
          // coming back to a file nobody changed would throw away the
          // developer's history for no reason at all.
          yield* lua(bridge, "return mesura.open(...)", [path, current]);
          assert.strictEqual(
            yield* lua(bridge, "return vim.fn.undotree().seq_cur"),
            before,
            "identical lines change nothing",
          );

          yield* lua(bridge, "return mesura.open(...)", [path, ["different"]]);
          assert.deepStrictEqual(
            yield* lua(bridge, "return vim.api.nvim_buf_get_lines(0, 0, -1, false)"),
            ["different"],
            "and different lines are taken",
          );
        }).pipe(Effect.orDie),
      ),
    );

    it.effect("asks for a write on :w rather than writing the file", () =>
      withHost((bridge, root) =>
        Effect.gen(function* () {
          const path = `${root}/save.ts`;
          yield* lua(bridge, "return mesura.open(...)", [path, ["one"]]);

          // The notification the host would receive, captured in Lua so this
          // test does not depend on the manager being wired up.
          yield* lua(
            bridge,
            `_G.mesura_seen = {}
             vim.g.mesura_channel = nil
             vim.rpcnotify = function(_, method, argument)
               table.insert(_G.mesura_seen, method .. ":" .. tostring(argument))
             end
             vim.g.mesura_channel = 1`,
          );

          yield* bridge.type("A!");
          yield* bridge.type("<Esc>");
          yield* lua(bridge, "vim.cmd('write')");

          assert.deepStrictEqual(
            yield* lua(bridge, "return _G.mesura_seen"),
            [`mesura:write:${path}`],
            "one request, naming the file",
          );
          assert.strictEqual(
            yield* lua(bridge, "return vim.bo.modified"),
            false,
            "and the buffer is no longer dirty",
          );
          // Neovim never touches the file. The host owns it.
          assert.strictEqual(
            yield* lua(bridge, "return vim.fn.filereadable(...)", [path]),
            0,
            "nothing was written to disk",
          );
        }).pipe(Effect.orDie),
      ),
    );

    it.effect("closes a buffer the host is finished with", () =>
      withHost((bridge, root) =>
        Effect.gen(function* () {
          const path = `${root}/gone.ts`;
          yield* lua(bridge, "return mesura.open(...)", [path, ["one"]]);
          yield* lua(bridge, "mesura.close(...)", [path]);

          const remaining = (yield* lua(
            bridge,
            `local names = {}
             for _, buffer in ipairs(vim.api.nvim_list_bufs()) do
               table.insert(names, vim.api.nvim_buf_get_name(buffer))
             end
             return names`,
          )) as string[];
          assert.notInclude(remaining, path);
        }).pipe(Effect.orDie),
      ),
    );
  });
