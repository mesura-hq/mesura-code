// @effect-diagnostics nodeBuiltinImport:off -- `hyprctl` is a native compositor boundary, as in CaptureShortcutConfig.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

/**
 * Runtime `hyprctl keyword` calls shared by the dictation session binds and the widget's window
 * rules. They last until Hyprland reloads its config, and touch nothing in the user's files.
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
