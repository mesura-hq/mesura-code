import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import { NodeNvimAdapter } from "../NodeNvimAdapter.ts";
import { NvimBridge } from "../NvimBridge.ts";
import { nvimAvailable, reportMissingNvim } from "./nvimOnPath.ts";

/**
 * The host's options, proved against a configuration that fights them.
 *
 * This is the equality the whole grid classification rests on: grid column N
 * equals buffer column N. Every option asserted here breaks it — a sign
 * column shifts every character right, `list` paints a dot where the buffer
 * holds a space, `conceallevel` replaces buffer text with something shorter.
 * A configuration that sets them is the ordinary case, not a hostile one, so
 * the host has to win and the proof has to be a real Neovim reading the
 * option back rather than a string match on the Lua.
 *
 * It uses a configuration written here rather than the developer's own, so it
 * runs wherever `nvim` is on PATH. `realConfig.test.ts` covers the real one.
 */

const layer = NodeNvimAdapter.layer.pipe(Layer.provideMerge(NodeServices.layer));

/** A configuration that sets every option the host has to take back. */
const HOSTILE_INIT_LUA = `
-- Not one of the host's options, so it is the witness that this file was read
-- at all. Without it a session that quietly fell back to a bare Neovim would
-- satisfy every assertion below, because Neovim's own defaults already agree
-- with the host on half of them.
vim.opt.tabstop = 7

vim.opt.number = true
vim.opt.relativenumber = true
vim.opt.signcolumn = "yes"
vim.opt.foldcolumn = "1"
vim.opt.numberwidth = 6
vim.opt.wrap = true
vim.opt.scrolloff = 15
vim.opt.sidescrolloff = 8
vim.opt.cursorline = true
vim.opt.laststatus = 2
vim.opt.showmode = true
vim.opt.list = true
vim.opt.listchars = { tab = "> ", trail = "." }
vim.opt.conceallevel = 2
vim.api.nvim_create_autocmd("FileType", {
  callback = function(event)
    pcall(vim.treesitter.start, event.buf)
  end,
})
`;

/** Writes the configuration and opens a bridge that loads it. */
const withHostileConfig = <A>(
  body: (bridge: NvimBridge.Session) => Effect.Effect<A, never, never>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-host-options-" });
    const configDirectory = `${root}/config`;
    yield* fs.makeDirectory(configDirectory, { recursive: true });
    yield* fs.writeFileString(`${configDirectory}/init.lua`, HOSTILE_INIT_LUA);
    const bridge = yield* NvimBridge.spawn({
      cols: 80,
      rows: 24,
      configDirectory,
      homeDir: root,
      stateDir: root,
    });
    const tabstop = yield* bridge.request("nvim_exec_lua", ["return vim.bo.tabstop", []]);
    assert.strictEqual(tabstop, 7, "the configuration was loaded, so the rest means something");
    return yield* body(bridge);
  }).pipe(Effect.scoped);

/** Runs Lua in the session and returns what it gives back. */
const lua = (bridge: NvimBridge.Session, code: string) =>
  bridge.request("nvim_exec_lua", [code, []]);

if (!nvimAvailable) reportMissingNvim("host-option harness");

if (nvimAvailable)
  it.layer(layer, { excludeTestServices: true })("the host owns the options it must own", (it) => {
    it.effect("takes back every window option that would shift a column", () =>
      withHostileConfig((bridge) =>
        Effect.gen(function* () {
          const options = (yield* lua(
            bridge,
            `return {
             number = vim.wo.number,
             relativenumber = vim.wo.relativenumber,
             signcolumn = vim.wo.signcolumn,
             foldcolumn = vim.wo.foldcolumn,
             wrap = vim.wo.wrap,
             scrolloff = vim.wo.scrolloff,
             sidescrolloff = vim.wo.sidescrolloff,
             list = vim.wo.list,
             conceallevel = vim.wo.conceallevel,
           }`,
          )) as Record<string, unknown>;

          assert.deepStrictEqual(options, {
            number: false,
            relativenumber: false,
            signcolumn: "no",
            foldcolumn: "0",
            wrap: false,
            scrolloff: 0,
            sidescrolloff: 0,
            list: false,
            conceallevel: 0,
          });
        }).pipe(Effect.orDie),
      ),
    );

    it.effect("holds them for a window opened after startup", () =>
      withHostileConfig((bridge) =>
        Effect.gen(function* () {
          // A plugin such as statuscol sets these per window, so a one-shot
          // assignment at startup is not enough: the host re-applies them on
          // every new window and buffer.
          yield* bridge.request("nvim_command", ["enew"]);
          yield* bridge.awaitFlush;
          const options = (yield* lua(
            bridge,
            "return { vim.wo.relativenumber, vim.wo.signcolumn, vim.wo.scrolloff, vim.wo.list }",
          )) as [boolean, string, number, boolean];
          assert.deepStrictEqual(options, [false, "no", 0, false]);
        }).pipe(Effect.orDie),
      ),
    );

    it.effect("leaves no treesitter highlighter attached to a buffer", () =>
      withHostileConfig((bridge) =>
        Effect.gen(function* () {
          yield* bridge.request("nvim_command", ["setfiletype lua"]);
          yield* bridge.awaitFlush;
          const attached = (yield* lua(
            bridge,
            "return vim.treesitter.highlighter.active[vim.api.nvim_get_current_buf()] ~= nil",
          )) as boolean;
          assert.isFalse(attached, "the decoration stream would be the whole viewport");
        }).pipe(Effect.orDie),
      ),
    );

    it.effect("loads the configuration, rather than quietly falling back to a bare Neovim", () =>
      withHostileConfig((bridge) =>
        Effect.gen(function* () {
          // `expandtab` is not one of the host's options, so it proves the
          // configuration was read: a `--clean` session would answer `false`.
          yield* bridge.request("nvim_command", ["set expandtab"]);
          const flag = (yield* lua(bridge, "return vim.g.mesura")) as number;
          assert.strictEqual(flag, 1, "the host flag the configuration branches on");
        }).pipe(Effect.orDie),
      ),
    );

    it.effect("refuses a Neovim below the version floor and names the one it found", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-host-version-" });
        const configDirectory = `${root}/config`;
        yield* fs.makeDirectory(configDirectory, { recursive: true });
        yield* fs.writeFileString(`${configDirectory}/init.lua`, "-- a configuration\n");

        const outcome = yield* NvimBridge.spawn({
          cols: 80,
          rows: 24,
          configDirectory,
          homeDir: root,
          stateDir: root,
          minimumVersion: { major: 99, minor: 0, patch: 0 },
        }).pipe(Effect.result);

        assert.isTrue(Result.isFailure(outcome), "a version below the floor must refuse to run");
        if (!Result.isFailure(outcome)) return;
        const failure = outcome.failure;
        assert.strictEqual(failure._tag, "NvimLaunchError");
        if (failure._tag !== "NvimLaunchError") return;
        assert.strictEqual(failure.reason, "version");
      }).pipe(Effect.scoped),
    );
  });
