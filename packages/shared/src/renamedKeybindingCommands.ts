import type { KeybindingCommand } from "@t3tools/contracts";

/**
 * The loader refuses a command id the contract no longer lists, which also stops the startup backfill,
 * so it rewrites a renamed id before decoding and keeps the user's key and clause. Startup persists
 * the current ids through the keybindings-migrations ledger. Keep an entry while a pre-rename
 * config can exist.
 */
export const RENAMED_KEYBINDING_COMMANDS: Readonly<Record<string, KeybindingCommand>> = {
  // The tree-listing overview became the file manager's Miller columns.
  "fileTree.overview": "fileTree.miller",
  // Upstream's command already settles and unsets settlement; keep saved custom chords working.
  "thread.toggleSettled": "thread.settle",
};

/** A raw config entry with its command id brought up to date; anything else is returned as is. */
export function withCurrentKeybindingCommand(entry: unknown): unknown {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
  const command = (entry as { command?: unknown }).command;
  const renamed = typeof command === "string" ? RENAMED_KEYBINDING_COMMANDS[command] : undefined;
  return renamed === undefined ? entry : { ...entry, command: renamed };
}
