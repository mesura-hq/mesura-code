import { useConversationOwnsShortcuts } from "../components/searches/conversationShortcutOwner";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useEffect } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { useCommandHandlers } from "../commands/commandRegistry";
import { resolveShortcutCommand } from "../keybindings";
import { getTerminalFocusOwner } from "../lib/terminalFocus";

/**
 * The header owns the rename state, so the listener lives beside it, not in ChatView.
 * `enabled` is false for drafts, which have no server thread to rename, and while the
 * rename field is open, so a second press does nothing.
 */
export function useThreadRenameShortcut(input: {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly enabled: boolean;
  readonly onStartRename: () => void;
}): void {
  const { keybindings, enabled, onStartRename } = input;
  const ownsShortcuts = useConversationOwnsShortcuts();
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: capture-phase keydown listener for the thread.rename shortcut, removed on unmount
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: getTerminalFocusOwner() !== null },
      });
      if (command !== "thread.rename" || isCommandPaletteOpen() || !ownsShortcuts()) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) onStartRename();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [enabled, keybindings, onStartRename, ownsShortcuts]);
  useCommandHandlers({ "thread.rename": enabled ? onStartRename : undefined });
}
