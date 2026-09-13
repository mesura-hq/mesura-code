// @effect-diagnostics nodeBuiltinImport:off - reads a symlink without following it.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";

import { checkNvimVersion, resolveNvimLaunch, type NvimLaunchInput } from "./NvimLaunch.ts";

/**
 * Launching the developer's own Neovim, decided before anything is spawned.
 *
 * Every case here runs against a real temporary directory rather than a mocked
 * filesystem, because the whole point of the resolution is what is on disk:
 * whether the configuration directory is there, whether it holds an
 * `init.lua`, and whether the scratch config home can be written.
 */

const layer = NodeServices.layer;

/** A configuration directory with an `init.lua`, and the scratch state beside it. */
const scratch = Effect.fn("scratch")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "nvim-launch-" });
  const configDirectory = `${root}/config`;
  yield* fs.makeDirectory(configDirectory, { recursive: true });
  yield* fs.writeFileString(`${configDirectory}/init.lua`, "-- a configuration\n");
  const stateDir = `${root}/state`;
  yield* fs.makeDirectory(stateDir, { recursive: true });
  const runtimeDir = `${root}/runtime`;
  yield* fs.makeDirectory(runtimeDir, { recursive: true });
  return { root, configDirectory, stateDir, runtimeDir };
});

const input = (
  overrides: Partial<NvimLaunchInput> & Pick<NvimLaunchInput, "configDirectory">,
): NvimLaunchInput => {
  const runtimeDir = overrides.runtimeDir ?? "/tmp/unused-runtime";
  return {
    env: {},
    homeDir: "/home/nobody",
    stateDir: "/tmp/unused-state",
    hostPluginPath: `${runtimeDir}/mesura_host.lua`,
    ...overrides,
    runtimeDir,
  };
};

const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => {
      assert.isTrue(Result.isFailure(result), "expected the launch to be refused");
      return (result as Result.Failure<A, E>).failure;
    }),
  );

it.layer(layer, { excludeTestServices: true })("resolveNvimLaunch", (it) => {
  it.effect("refuses a configuration directory that is not there, without spawning", () =>
    Effect.gen(function* () {
      const { root } = yield* scratch();
      const error = yield* failureOf(
        resolveNvimLaunch(input({ configDirectory: `${root}/nowhere` })),
      );
      assert.strictEqual(error.reason, "config-missing");
      assert.include(error.detail, `${root}/nowhere`);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a directory that holds no init.lua", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root } = yield* scratch();
      const empty = `${root}/empty`;
      yield* fs.makeDirectory(empty, { recursive: true });
      const error = yield* failureOf(resolveNvimLaunch(input({ configDirectory: empty })));
      assert.strictEqual(error.reason, "config-missing");
      assert.include(error.detail, "init.lua");
    }).pipe(Effect.scoped),
  );

  it.effect("expands a leading tilde against the home directory it is given", () =>
    Effect.gen(function* () {
      const { root, configDirectory, stateDir, runtimeDir } = yield* scratch();
      const plan = yield* resolveNvimLaunch(
        input({ configDirectory: "~/config", homeDir: root, stateDir, runtimeDir }),
      );
      assert.strictEqual(plan.configDirectory, configDirectory);
    }).pipe(Effect.scoped),
  );

  it.effect("sets no XDG_CONFIG_HOME when the directory already is the one Neovim reads", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, stateDir, runtimeDir } = yield* scratch();
      const configHome = `${root}/xdg`;
      const nvimDirectory = `${configHome}/nvim`;
      yield* fs.makeDirectory(nvimDirectory, { recursive: true });
      yield* fs.writeFileString(`${nvimDirectory}/init.lua`, "-- a configuration\n");

      const plan = yield* resolveNvimLaunch(
        input({
          configDirectory: nvimDirectory,
          env: { XDG_CONFIG_HOME: configHome },
          stateDir,
          runtimeDir,
        }),
      );
      assert.strictEqual(plan.configHome, null, "nothing had to be built");
      assert.strictEqual(plan.env["XDG_CONFIG_HOME"], configHome, "left exactly as it was");
    }).pipe(Effect.scoped),
  );

  it.effect("sets no XDG_CONFIG_HOME for ~/.config/nvim when the variable is unset", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, stateDir, runtimeDir } = yield* scratch();
      const nvimDirectory = `${root}/.config/nvim`;
      yield* fs.makeDirectory(nvimDirectory, { recursive: true });
      yield* fs.writeFileString(`${nvimDirectory}/init.lua`, "-- a configuration\n");

      const plan = yield* resolveNvimLaunch(
        input({ configDirectory: nvimDirectory, homeDir: root, stateDir, runtimeDir }),
      );
      assert.strictEqual(plan.configHome, null);
      assert.isUndefined(plan.env["XDG_CONFIG_HOME"]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "points XDG_CONFIG_HOME at a scratch home whose nvim entry links to the directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { configDirectory, stateDir, runtimeDir } = yield* scratch();
        const plan = yield* resolveNvimLaunch(input({ configDirectory, stateDir, runtimeDir }));

        assert.isNotNull(plan.configHome);
        assert.strictEqual(plan.env["XDG_CONFIG_HOME"], plan.configHome);
        const linked = yield* fs.readLink(`${plan.configHome!}/nvim`);
        assert.strictEqual(linked, configDirectory);
        // The link has to resolve to the real configuration, not merely exist.
        const through = yield* fs.readFileString(`${plan.configHome!}/nvim/init.lua`);
        assert.include(through, "a configuration");
      }).pipe(Effect.scoped),
  );

  it.effect("mirrors an existing git config directory beside it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, configDirectory, stateDir, runtimeDir } = yield* scratch();
      const outerConfigHome = `${root}/xdg`;
      const gitDirectory = `${outerConfigHome}/git`;
      yield* fs.makeDirectory(gitDirectory, { recursive: true });

      const plan = yield* resolveNvimLaunch(
        input({
          configDirectory,
          env: { XDG_CONFIG_HOME: outerConfigHome },
          stateDir,
          runtimeDir,
        }),
      );
      const linked = yield* fs.readLink(`${plan.configHome!}/git`);
      assert.strictEqual(linked, gitDirectory);
    }).pipe(Effect.scoped),
  );

  it.effect("mirrors ~/.config/git when XDG_CONFIG_HOME is unset", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, configDirectory, stateDir, runtimeDir } = yield* scratch();
      const gitDirectory = `${root}/.config/git`;
      yield* fs.makeDirectory(gitDirectory, { recursive: true });

      const plan = yield* resolveNvimLaunch(
        input({ configDirectory, homeDir: root, stateDir, runtimeDir }),
      );
      const linked = yield* fs.readLink(`${plan.configHome!}/git`);
      assert.strictEqual(linked, gitDirectory);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves no git entry when there is no git config directory to mirror", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, configDirectory, stateDir, runtimeDir } = yield* scratch();
      const plan = yield* resolveNvimLaunch(
        input({ configDirectory, homeDir: `${root}/no-home`, stateDir, runtimeDir }),
      );
      assert.isFalse(yield* fs.exists(`${plan.configHome!}/git`));
    }).pipe(Effect.scoped),
  );

  it.effect("treats a trailing slash as the same directory, and builds nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, stateDir, runtimeDir } = yield* scratch();
      const configHome = `${root}/xdg`;
      const nvimDirectory = `${configHome}/nvim`;
      yield* fs.makeDirectory(nvimDirectory, { recursive: true });
      yield* fs.writeFileString(`${nvimDirectory}/init.lua`, "-- a configuration\n");

      // A shell that completes a directory name adds the slash, so this is the
      // ordinary spelling rather than a contrived one. Compared as raw strings
      // it is not the config home, and the launch takes the long way round:
      // a scratch home and a git mirror for a directory that needed neither.
      const plan = yield* resolveNvimLaunch(
        input({
          configDirectory: `${nvimDirectory}/`,
          env: { XDG_CONFIG_HOME: `${configHome}/` },
          stateDir,
          runtimeDir,
        }),
      );
      assert.strictEqual(plan.configHome, null, "nothing had to be built");
      assert.strictEqual(plan.configDirectory, nvimDirectory, "and the slash is gone");
    }).pipe(Effect.scoped),
  );

  it.effect("takes down a git mirror once there is no git configuration to mirror", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, configDirectory, stateDir, runtimeDir } = yield* scratch();
      const gitDirectory = `${root}/.config/git`;
      yield* fs.makeDirectory(gitDirectory, { recursive: true });

      const first = yield* resolveNvimLaunch(
        input({ configDirectory, homeDir: root, stateDir, runtimeDir }),
      );
      // `readLink` and not `exists`, and that distinction is the whole test:
      // `exists` follows the link, so once the target is gone it answers
      // `false` for a link that is still very much there — which is how this
      // guard first passed against the defect it was written to catch.
      assert.strictEqual(
        yield* fs.readLink(`${first.configHome!}/git`),
        gitDirectory,
        "mirrored while it existed",
      );

      // The config home outlives a run. A mirror left behind after the git
      // configuration moved would keep pointing the git that gitsigns and
      // lazy.nvim spawn at a file the developer no longer has.
      yield* fs.remove(gitDirectory, { recursive: true });
      const second = yield* resolveNvimLaunch(
        input({ configDirectory, homeDir: root, stateDir, runtimeDir }),
      );
      const dangling = yield* fs
        .readLink(`${second.configHome!}/git`)
        .pipe(Effect.result, Effect.map(Result.isSuccess));
      assert.isFalse(dangling, "and the link itself is taken down after");
    }).pipe(Effect.scoped),
  );

  it.effect("leaves an already-correct link alone rather than replacing it", () =>
    Effect.gen(function* () {
      const { configDirectory, stateDir, runtimeDir } = yield* scratch();
      const first = yield* resolveNvimLaunch(input({ configDirectory, stateDir, runtimeDir }));
      // `lstatSync`, because the link's own identity is the subject. Effect's
      // `stat` follows it and reports the configuration directory instead,
      // whose inode never changes however often the link is recreated — which
      // is how this guard first passed against the defect it was written for.
      const before = NodeFS.lstatSync(`${first.configHome!}/nvim`).ino;

      const second = yield* resolveNvimLaunch(input({ configDirectory, stateDir, runtimeDir }));
      const after = NodeFS.lstatSync(`${second.configHome!}/nvim`).ino;

      // Two launches share this path, and removing a link to put back an
      // identical one opens a window in which a running Neovim reading through
      // it finds nothing there.
      assert.strictEqual(after, before, "the link was not recreated");
    }).pipe(Effect.scoped),
  );

  it.effect("quotes the host plugin path so a bracket in it cannot end the Lua string", () =>
    Effect.gen(function* () {
      const { configDirectory, stateDir, runtimeDir } = yield* scratch();
      const plan = yield* resolveNvimLaunch(
        input({
          configDirectory,
          stateDir,
          runtimeDir,
          hostPluginPath: '/tmp/od]]d/me"sura_host.lua',
        }),
      );
      const sourced = plan.args[plan.args.indexOf("-c") + 1] ?? "";
      // A long bracket ends at the first `]]` in the path, which would turn the
      // rest of the argument into Lua source rather than a file name.
      assert.notInclude(sourced, "[[");
      assert.include(sourced, '\\"sura_host.lua');
      assert.include(sourced, "od]]d");
    }).pipe(Effect.scoped),
  );

  it.effect("puts a file to open at the end of argv, after the option terminator", () =>
    Effect.gen(function* () {
      const { configDirectory, stateDir, runtimeDir } = yield* scratch();
      const plan = yield* resolveNvimLaunch(
        input({ configDirectory, stateDir, runtimeDir, initialFile: "/tmp/a file.ts" }),
      );
      // `--` so a file whose name begins with a dash is a file rather than an
      // option, and last so the `--cmd` and `-c` arguments are unaffected.
      assert.deepStrictEqual(plan.args.slice(-2), ["--", "/tmp/a file.ts"]);
    }).pipe(Effect.scoped),
  );

  it.effect("drops every TMUX variable and the nested-session variables", () =>
    Effect.gen(function* () {
      const { configDirectory, stateDir, runtimeDir } = yield* scratch();
      const plan = yield* resolveNvimLaunch(
        input({
          configDirectory,
          stateDir,
          runtimeDir,
          env: {
            TMUX: "/tmp/tmux-1000/default,123,0",
            TMUX_PANE: "%7",
            TMUX_PLUGIN_MANAGER_PATH: "/home/nobody/.tmux/plugins",
            NVIM: "/run/user/1000/nvim.1.0",
            NVIM_LISTEN_ADDRESS: "/tmp/nvimsocket",
            PATH: "/usr/bin",
          },
        }),
      );
      for (const dropped of [
        "TMUX",
        "TMUX_PANE",
        "TMUX_PLUGIN_MANAGER_PATH",
        "NVIM",
        "NVIM_LISTEN_ADDRESS",
      ]) {
        assert.isUndefined(plan.env[dropped], `${dropped} should not reach Neovim`);
      }
      assert.strictEqual(plan.env["PATH"], "/usr/bin", "the rest of the environment survives");
    }).pipe(Effect.scoped),
  );

  it.effect("puts the host flag and the runtime path ahead of the configuration", () =>
    Effect.gen(function* () {
      const { configDirectory, stateDir, runtimeDir } = yield* scratch();
      const plan = yield* resolveNvimLaunch(input({ configDirectory, stateDir, runtimeDir }));
      assert.strictEqual(plan.executable, "nvim");
      // The host plugin is sourced by name rather than found on the runtime
      // path, and that is measured rather than stylistic: lazy.nvim replaces
      // `runtimepath` while `init.lua` runs, so a `plugin/` or `after/plugin/`
      // file under a directory added with `--cmd` is never sourced and every
      // forced option quietly does nothing.
      assert.deepStrictEqual(plan.args, [
        "--embed",
        "-n",
        "--cmd",
        "lua vim.g.mesura = 1",
        "--cmd",
        `set runtimepath^=${runtimeDir}`,
        "-c",
        `lua dofile("${runtimeDir}/mesura_host.lua")`,
      ]);
    }).pipe(Effect.scoped),
  );
});

describe("checkNvimVersion", () => {
  const apiInfo = (major: number, minor: number, patch: number) => [
    1,
    { version: { major, minor, patch } },
  ];

  it("accepts the floor itself and everything above it", () => {
    assert.isNull(checkNvimVersion(apiInfo(0, 12, 0)));
    assert.isNull(checkNvimVersion(apiInfo(0, 12, 4)));
    assert.isNull(checkNvimVersion(apiInfo(1, 0, 0)));
  });

  it("refuses a version below the floor and names the one it found", () => {
    const error = checkNvimVersion(apiInfo(0, 11, 9));
    assert.strictEqual(error?.reason, "version");
    assert.include(error?.detail ?? "", "0.11.9");
    assert.include(error?.detail ?? "", "0.12.0");
  });

  it("refuses api info it cannot read a version out of", () => {
    const error = checkNvimVersion([1, {}]);
    assert.strictEqual(error?.reason, "version");
  });

  it("compares by field rather than by string, so 0.9 is below 0.12", () => {
    assert.strictEqual(checkNvimVersion(apiInfo(0, 9, 5))?.reason, "version");
  });
});
