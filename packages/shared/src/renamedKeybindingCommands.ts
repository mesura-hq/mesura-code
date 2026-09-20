import type { KeybindingCommand } from "@t3tools/contracts";

/**
 * Commands this fork renamed after they had shipped.
 *
 * A stored rule names its command by id, and the loader refuses an id the
 * contract no longer lists — as an invalid entry, which also stops the
 * startup backfill from installing anything, the renamed command's default
 * included. So a rename would leave everyone who ran the app before with a
 * dead chord and a config issue on every start. The loader rewrites the id
 * before it decodes the rule, and the rule keeps the user's key and clause.
 *
 * The rewrite is not written back: the file keeps the old id until the user
 * next edits a binding, which is what lets a downgrade read it again. An
 * entry here therefore stays as long as a config from before the rename can
 * still exist. Beside upstream's `keybindings.ts` rather than inside it: the
 * table is this fork's alone.
 */
export const RENAMED_KEYBINDING_COMMANDS: Readonly<Record<string, KeybindingCommand>> = {
  // The tree-listing overview became the file manager's Miller columns.
  "fileTree.overview": "fileTree.miller",
};

/** A raw config entry with its command id brought up to date; anything else is returned as is. */
export function withCurrentKeybindingCommand(entry: unknown): unknown {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
  const command = (entry as { command?: unknown }).command;
  const renamed = typeof command === "string" ? RENAMED_KEYBINDING_COMMANDS[command] : undefined;
  return renamed === undefined ? entry : { ...entry, command: renamed };
}
