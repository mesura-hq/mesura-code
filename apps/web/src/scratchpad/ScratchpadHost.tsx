import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { useCommandHandlers } from "~/commands/commandRegistry";
import { type DraftId } from "~/composerDraftStore";
import { resolveShortcutCommand } from "~/keybindings";
import { isPreviewFocused } from "~/lib/previewFocus";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { primaryServerKeybindingsAtom } from "~/state/server";

import { ScratchpadOverlay } from "./ScratchpadOverlay";
import { type ScratchpadOwner } from "./scratchpadScopes";
import { useScratchpadStore } from "./scratchpadStore";
import { useScratchpadRoot } from "./useScratchpadFile";

interface ScratchpadHostProps {
  readonly environmentId: EnvironmentId;
  readonly owner: ScratchpadOwner;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
}

/**
 * Mounted once per chat view, inside its positioned canvas: the overlay covers the thread, not the
 * window, so the sidebar and right panel stay visible around it.
 */
export function ScratchpadHost({ environmentId, owner, composerDraftTarget }: ScratchpadHostProps) {
  const root = useScratchpadRoot(environmentId);
  const mounted = useScratchpadStore((state) => state.phase !== "closed");
  const openCount = useScratchpadStore((state) => state.openCount);
  const toggleScratchpad = useScratchpadStore((state) => state.toggleScratchpad);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  // The key engine's leader row and the palette run the command through the registry.
  useCommandHandlers({ "scratchpad.toggle": toggleScratchpad });

  // The chord itself: each command owner listens on the window, as the sidebar's host does. The
  // scratchpad's Neovim lets it through because the command outranks Neovim.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown listener for the scratchpad chord while the chat view is mounted
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused(), previewFocus: isPreviewFocused() },
      });
      if (command !== "scratchpad.toggle") return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) useScratchpadStore.getState().toggleScratchpad();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);

  if (!mounted || root === undefined) return null;
  return (
    <ScratchpadOverlay
      key={`${environmentId}:${root}:${openCount}`}
      environmentId={environmentId}
      root={root}
      owner={owner}
      composerDraftTarget={composerDraftTarget}
    />
  );
}
