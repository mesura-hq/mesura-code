// @effect-diagnostics nodeBuiltinImport:off -- `hyprctl` is a native compositor boundary, as in CaptureShortcutConfig.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

/**
 * Runtime `hyprctl` calls shared by the dictation session binds and the widget's window rules.
 * They last until Hyprland reloads its config, and touch nothing in the user's files. A Hyprlang
 * config takes `hyprctl keyword`; a Lua config rejects it with `unknown request` and takes
 * `hyprctl eval` instead, so every caller asks which one is active.
 */

/** Whether this process runs under Hyprland. */
export const isHyprlandSession = (env: Readonly<Record<string, string | undefined>>) =>
  Boolean(env.HYPRLAND_INSTANCE_SIGNATURE?.trim());

export type HyprctlExecute = (
  file: string,
  args: ReadonlyArray<string>,
) => Promise<{ readonly stdout: string } | undefined>;

export const executeHyprctl: HyprctlExecute = (file, args) =>
  NodeUtil.promisify(NodeChildProcess.execFile)(file, [...args], {
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });

/**
 * One `hyprctl keyword` command. `--batch` splits its input on `;`, and shell quoting does not
 * protect it, so a command that carries text from the user's config (a restored bind) or any
 * `;` runs as its own `hyprctl keyword` call with an argument vector instead.
 */
export interface KeywordCommand {
  readonly keyword: string;
  readonly value: string;
  readonly userText: boolean;
}

export const generatedKeyword = (keyword: string, value: string): KeywordCommand => ({
  keyword,
  value,
  userText: false,
});

/**
 * Hyprlang drops everything from a `#` as a comment, inside shell quotes too, in `keyword` and
 * `--batch` alike; `##` is its literal hash (checked on Hyprland 0.56.2). `hyprctl -j binds`
 * reports the unescaped text, so a restored bind needs it as much as a generated one.
 */
const escapeHyprlang = (value: string) => value.replaceAll("#", "##");

/**
 * The rejections in a `keyword` or `--batch` reply. Hyprland 0.56.2 exits 0 either way and
 * prints `ok` per accepted command, the error text (`config option <…> does not exist.`) per
 * rejected one, with blank lines between a batch's results.
 */
export const hyprctlRejections = (stdout: string | undefined): ReadonlyArray<string> =>
  (stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && line !== "ok");

/**
 * Runs `commands` in order: plain generated ones in batches, the rest one call each. Resolves
 * with what Hyprland rejected; throws only when `hyprctl` itself fails.
 */
export async function runKeywordCommands(
  execute: HyprctlExecute,
  commands: ReadonlyArray<KeywordCommand>,
): Promise<ReadonlyArray<string>> {
  const rejections: string[] = [];
  let batch: KeywordCommand[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const lines = batch.map(
      (command) => `keyword ${command.keyword} ${escapeHyprlang(command.value)}`,
    );
    batch = [];
    const output = await execute("hyprctl", ["--batch", lines.join(" ; ")]);
    rejections.push(...hyprctlRejections(output?.stdout));
  };
  for (const command of commands) {
    if (command.userText || command.value.includes(";")) {
      await flush();
      const output = await execute("hyprctl", [
        "keyword",
        command.keyword,
        escapeHyprlang(command.value),
      ]);
      rejections.push(...hyprctlRejections(output?.stdout));
    } else {
      batch.push(command);
    }
  }
  await flush();
  return rejections;
}

/** How the running Hyprland reads its config, which decides how runtime changes are sent. */
export type HyprlandConfigProvider = "hyprlang" | "lua";

/**
 * What `hyprctl -j status` says, or `null` when the read failed and says nothing. It names the
 * provider since Hyprland 0.57; an older Hyprland answers `unknown request` and reads Hyprlang.
 */
async function readReportedConfigProvider(
  execute: HyprctlExecute,
): Promise<HyprlandConfigProvider | null> {
  let stdout: string;
  try {
    stdout = (await execute("hyprctl", ["-j", "status"]))?.stdout ?? "";
  } catch {
    return null;
  }
  if (stdout.trim() === "unknown request") return "hyprlang";
  try {
    const status: unknown = JSON.parse(stdout);
    if (typeof status !== "object" || status === null) return null;
    return (status as Record<string, unknown>).configProvider === "lua" ? "lua" : "hyprlang";
  } catch {
    return null;
  }
}

/**
 * Reads the provider on each use, because a config migrated while the app runs switches it at
 * the next reload. A failed read keeps the last provider Hyprland reported: guessing Hyprlang on
 * a Lua config would send keywords it rejects.
 */
export function createHyprlandConfigProviderReader(
  execute: HyprctlExecute,
): () => Promise<HyprlandConfigProvider> {
  let last: HyprlandConfigProvider | null = null;
  return async () => {
    last = (await readReportedConfigProvider(execute)) ?? last;
    return last ?? "hyprlang";
  };
}

/**
 * A Lua string literal. Control characters use a three-digit decimal escape, so a digit after
 * one cannot extend it.
 */
export const luaString = (value: string) =>
  `"${[...value]
    .map((character) => {
      if (character === "\\") return "\\\\";
      if (character === '"') return '\\"';
      const code = character.codePointAt(0)!;
      return code < 0x20 || code === 0x7f ? `\\${String(code).padStart(3, "0")}` : character;
    })
    .join("")}"`;

/** A Lua value for a window rule effect or a bind option. */
export const luaValue = (value: string | number | boolean) =>
  typeof value === "string" ? luaString(value) : String(value);

/** A Lua table with identifier keys, in the order given. */
export const luaTable = (fields: ReadonlyArray<readonly [key: string, value: string]>) =>
  `{ ${fields.map(([key, value]) => `${key} = ${value}`).join(", ")} }`;

/**
 * Runs Lua in Hyprland. Resolves with what Hyprland rejected: Hyprland 0.57.1 prints `ok` and
 * exits 0 on success, and prints `error: …` and exits 7 on failure, which `execFile` turns into
 * a rejection carrying that output. Throws only when `hyprctl` itself fails.
 */
export async function runLuaEval(
  execute: HyprctlExecute,
  code: string,
): Promise<ReadonlyArray<string>> {
  try {
    const output = await execute("hyprctl", ["eval", code]);
    return hyprctlRejections(output?.stdout);
  } catch (cause) {
    const stdout =
      typeof cause === "object" && cause !== null && "stdout" in cause ? cause.stdout : undefined;
    if (typeof stdout === "string" && stdout.trim() !== "") return hyprctlRejections(stdout);
    throw cause;
  }
}

/**
 * Calls `method` with `args` on every handle in the Lua table `handles` evaluates to, if any. A
 * handle a reload made stale fails inside `pcall` and is skipped.
 */
export const releaseLuaHandles = (
  handles: string,
  method: string,
  ...args: ReadonlyArray<string>
) =>
  `for _, handle in ipairs(${handles} or {}) do pcall(${[`handle.${method}`, "handle", ...args].join(", ")}) end`;
