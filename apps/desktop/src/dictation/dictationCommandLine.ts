import type { DictationKeybindingCommand } from "@t3tools/contracts";

/**
 * `mesura-code --dictation <action> [mode]`, run while Mesura is open, steers the dictation in
 * the running window: the single-instance lock hands the argv to the first instance, which
 * forwards the command to its renderer. The Hyprland session binds launch the same lines.
 */
export const DICTATION_FLAG = "--dictation";

const COMMAND_LINE_ACTIONS: Record<DictationKeybindingCommand, ReadonlyArray<string>> = {
  "dictation.toggle": ["toggle"],
  "dictation.mode.clipboard": ["mode", "clipboard"],
  "dictation.mode.inject": ["mode", "inject"],
  "dictation.mode.submit": ["mode", "submit"],
  "dictation.pause": ["pause"],
  "dictation.restart": ["restart"],
  "dictation.cancel": ["cancel"],
};

const ACTION_WORDS = new Set(Object.values(COMMAND_LINE_ACTIONS).map(([action]) => action));

/** The arguments that run `command`, after the binary. */
export function dictationCommandLineArguments(
  command: DictationKeybindingCommand,
): ReadonlyArray<string> {
  return [DICTATION_FLAG, ...COMMAND_LINE_ACTIONS[command]];
}

/**
 * The dictation command in a second instance's argv, or `null` for any other launch.
 *
 * Electron documents that `second-instance` argv may be reordered and extended: Chromium puts
 * switches first and positionals last, so the action need not follow the flag directly. Paths
 * (the app path of a development launch) are skipped; any other word first is not a command.
 */
export function parseDictationCommandLine(
  argv: ReadonlyArray<string>,
): DictationKeybindingCommand | null {
  const flagIndex = argv.indexOf(DICTATION_FLAG);
  if (flagIndex < 0) return null;
  const words = argv
    .slice(flagIndex + 1)
    .filter((argument) => !argument.startsWith("-") && !argument.includes("/"));
  const [action, argument] = words;
  if (action === undefined || !ACTION_WORDS.has(action)) return null;
  const expected = action === "mode" ? [action, argument] : [action];
  for (const [command, words] of Object.entries(COMMAND_LINE_ACTIONS)) {
    if (words.length === expected.length && words.every((word, index) => word === expected[index]))
      return command as DictationKeybindingCommand;
  }
  return null;
}
