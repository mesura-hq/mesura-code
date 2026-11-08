import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

/**
 * Points `stdpath('config')` at the configured directory through `XDG_CONFIG_HOME`: a scratch
 * config home holds an `nvim` symlink. `-u` breaks `require` of the directory's `lua/`, and
 * `NVIM_APPNAME` also moves data, reinstalling every plugin. Data, state and cache stay put.
 */

export class NvimLaunchError extends Data.TaggedError("NvimLaunchError")<{
  readonly reason:
    | "binary-missing"
    | "version"
    | "config-missing"
    | "spawn-failed"
    | "runtime-unwritable";
  readonly detail: string;
}> {}

export interface NvimLaunchInput {
  /** As the developer typed it, `~` included. */
  readonly configDirectory: string;
  readonly env: Record<string, string | undefined>;
  readonly homeDir: string;
  /** Where the host plugin was written; goes on the front of the runtime path. */
  readonly runtimeDir: string;
  /** The host plugin file itself, sourced by name rather than by position. */
  readonly hostPluginPath: string;
  /** The server's state directory, which the scratch config home lives under. */
  readonly stateDir: string;
  /**
   * A file to open from argv at startup. A dashboard opens from a deferred callback after
   * `VimEnter` and replaces a file opened over RPC; with a file in argv it never runs.
   */
  readonly initialFile?: string | undefined;
}

export interface NvimLaunchPlan {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string | undefined>;
  /** The configuration directory with `~` expanded. */
  readonly configDirectory: string;
  /** The scratch config home that was built, or `null` when none was needed. */
  readonly configHome: string | null;
}

/** Variables that make an embedded Neovim think it is a nested or tmux session. */
const DROPPED_ENV_KEYS = new Set(["NVIM", "NVIM_LISTEN_ADDRESS"]);

/**
 * Every variable Neovim must not see, including the whole `TMUX` family: with
 * `TMUX_PLUGIN_MANAGER_PATH` set, the developer's `init.lua` renames a real terminal's tmux window.
 */
const isDroppedEnvKey = (key: string) => key.startsWith("TMUX") || DROPPED_ENV_KEYS.has(key);

/**
 * Drops trailing separators, so `~/.config/nvim/` matches the default config home and no
 * scratch config home is built for it. Root is left alone, because `/` is all separator.
 */
const withoutTrailingSeparator = (value: string) => {
  const trimmed = value.replace(/[/\\]+$/, "");
  return trimmed === "" ? value : trimmed;
};

/** Where Neovim itself would look, given an environment. */
const defaultConfigHome = (env: Record<string, string | undefined>, homeDir: string) =>
  withoutTrailingSeparator(env["XDG_CONFIG_HOME"] ?? `${homeDir}/.config`);

/**
 * Makes `path` a symlink to `target`. The path is fixed because lazy.nvim keys its cache on
 * `stdpath('config')`, so a correct link stays untouched for Neovims already reading through it.
 * It uses `remove`, not `exists`: `exists` follows a stale link and answers `false`.
 */
const relink = Effect.fn("NvimLaunch.relink")(function* (path: string, target: string) {
  const fs = yield* FileSystem.FileSystem;
  const current = yield* fs.readLink(path).pipe(Effect.orElseSucceed(() => null));
  if (current === target) return;
  yield* fs.remove(path, { force: true, recursive: true });
  yield* fs.symlink(target, path);
});

/**
 * Quotes a path as a Lua string literal. Not a long bracket `[[…]]`: a `]]` in the path
 * would end it and turn the rest of the argument into Lua source.
 */
const luaStringLiteral = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export const resolveNvimLaunch = Effect.fn("NvimLaunch.resolve")(function* (
  input: NvimLaunchInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const configDirectory = withoutTrailingSeparator(
    expandHomePath(withoutTrailingSeparator(input.configDirectory), input.homeDir),
  );

  if (!(yield* fs.exists(configDirectory).pipe(Effect.orElseSucceed(() => false)))) {
    return yield* new NvimLaunchError({
      reason: "config-missing",
      detail: `no Neovim configuration directory at ${configDirectory}`,
    });
  }
  if (!(yield* fs.exists(`${configDirectory}/init.lua`).pipe(Effect.orElseSucceed(() => false)))) {
    return yield* new NvimLaunchError({
      reason: "config-missing",
      detail: `${configDirectory} holds no init.lua`,
    });
  }

  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(input.env)) {
    if (!isDroppedEnvKey(key)) env[key] = value;
  }

  const alreadyTheConfigHome =
    configDirectory === `${defaultConfigHome(input.env, input.homeDir)}/nvim`;

  let configHome: string | null = null;
  if (!alreadyTheConfigHome) {
    configHome = `${input.stateDir}/neovim/config-home`;
    yield* fs.makeDirectory(configHome, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new NvimLaunchError({
            reason: "runtime-unwritable",
            detail: `could not build a config home at ${configHome}: ${String(cause)}`,
          }),
      ),
    );
    yield* relink(`${configHome}/nvim`, configDirectory).pipe(
      Effect.mapError(
        (cause) =>
          new NvimLaunchError({
            reason: "runtime-unwritable",
            detail: `could not link ${configHome}/nvim: ${String(cause)}`,
          }),
      ),
    );

    // WORKAROUND: mirror `$XDG_CONFIG_HOME/git` as a second symlink, because moving
    // XDG_CONFIG_HOME hides the git configuration from gitsigns and lazy.nvim's git.
    // Remove once Neovim has a flag that names the config directory without XDG_CONFIG_HOME.
    const gitConfigHome = `${defaultConfigHome(input.env, input.homeDir)}/git`;
    const hasGitConfig = yield* fs.exists(gitConfigHome).pipe(Effect.orElseSucceed(() => false));
    yield* (
      hasGitConfig
        ? relink(`${configHome}/git`, gitConfigHome)
        : // Removed rather than left behind. The config home outlives a run, so
          // a mirror made when a git configuration existed would keep pointing
          // at it after it moved or went away, and the git that gitsigns and
          // lazy.nvim spawn would read a file the developer no longer has.
          fs.remove(`${configHome}/git`, { force: true, recursive: true })
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not mirror the git config directory", { cause }),
      ),
    );
    env["XDG_CONFIG_HOME"] = configHome;
  }

  return {
    executable: "nvim",
    args: [
      "--embed",
      "-n",
      // Ahead of everything, so the configuration can branch on it in its very
      // first line. `vim.g.neovide` is the same convention.
      "--cmd",
      "lua vim.g.mesura = 1",
      // The host's directory on the front of the runtime path, so host Lua
      // modules are `require`-able. It is deliberately **not** how the host
      // plugin gets loaded: lazy.nvim replaces `runtimepath` while `init.lua`
      // runs, and this entry does not survive that.
      "--cmd",
      `set runtimepath^=${input.runtimeDir}`,
      // The host plugin, sourced by name. `-c` runs after every startup plugin
      // has been sourced and before `VimEnter`, and being argv rather than
      // state, no configuration can drop it.
      "-c",
      `lua dofile(${luaStringLiteral(input.hostPluginPath)})`,
      ...(input.initialFile === undefined ? [] : ["--", input.initialFile]),
    ],
    env,
    configDirectory,
    configHome,
  } satisfies NvimLaunchPlan;
});

/**
 * The oldest Neovim this host will drive.
 *
 * Below it `jumpoptions+=view` restores a jump to the wrong view without
 * reporting anything, so the cursor lands where the host did not put it and
 * nothing says why.
 */
export const NVIM_VERSION_FLOOR = { major: 0, minor: 12, patch: 0 } as const;

interface NvimVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const formatVersion = (version: NvimVersion) =>
  `${version.major}.${version.minor}.${version.patch}`;

/** Pulls the version out of what `nvim_get_api_info` answers, or `null`. */
const readVersion = (apiInfo: unknown): NvimVersion | null => {
  if (!Array.isArray(apiInfo) || apiInfo.length < 2) return null;
  const version = (apiInfo[1] as { version?: unknown } | null)?.version;
  if (typeof version !== "object" || version === null) return null;
  const { major, minor, patch } = version as Record<string, unknown>;
  if (typeof major !== "number" || typeof minor !== "number" || typeof patch !== "number") {
    return null;
  }
  return { major, minor, patch };
};

/**
 * Checks what `nvim_get_api_info` reported against the floor.
 *
 * Field by field rather than by string, because `"0.9.5"` sorts above
 * `"0.12.0"` and the comparison that reads correctly is the one that is wrong.
 */
export const checkNvimVersion = (
  apiInfo: unknown,
  floor: NvimVersion = NVIM_VERSION_FLOOR,
): NvimLaunchError | null => {
  const found = readVersion(apiInfo);
  if (found === null) {
    return new NvimLaunchError({
      reason: "version",
      detail: `could not read a version out of nvim_get_api_info; ${formatVersion(floor)} or newer is required`,
    });
  }
  const below =
    found.major !== floor.major
      ? found.major < floor.major
      : found.minor !== floor.minor
        ? found.minor < floor.minor
        : found.patch < floor.patch;
  if (!below) return null;
  return new NvimLaunchError({
    reason: "version",
    detail: `Neovim ${formatVersion(found)} is below the ${formatVersion(floor)} this editor needs`,
  });
};
