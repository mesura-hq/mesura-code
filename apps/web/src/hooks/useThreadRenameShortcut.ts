import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useEffect } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { resolveShortcutCommand } from "../keybindings";
import { getTerminalFocusOwner } from "../lib/terminalFocus";

/**
 * Fork addition. Opens the chat header's inline title rename from the
 * `thread.rename` shortcut. Upstream reaches that field only by double-click
 * and the thread action menu. The header owns the rename state, so the
 * listener lives beside it rather than in ChatView, and the upstream header
 * carries one call to this hook and nothing else.
 *
 * `enabled` is false for drafts, which have no server thread to rename, and
 * while the rename field is already open, so a second press does nothing.
 */
export function useThreadRenameShortcut(input: {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly enabled: boolean;
  readonly onStartRename: () => void;
}): void {
  const { keybindings, enabled, onStartRename } = input;
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: getTerminalFocusOwner() !== null },
      });
      if (command !== "thread.rename" || isCommandPaletteOpen()) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) onStartRename();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [enabled, keybindings, onStartRename]);
}
