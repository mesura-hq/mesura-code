import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { useContext, useEffect, useEffectEvent } from "react";

import { useCommandHandlers } from "~/commands/commandRegistry";
import { BackgroundThreadContext } from "~/components/chat/backgroundThread";
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
 * window, so the sidebar and right panel stay visible around it. A side chat or a thread kept
 * mounted in the background stands down, so one action never mounts two editors.
 */
export function ScratchpadHost(props: ScratchpadHostProps) {
  const background = useContext(BackgroundThreadContext);
  return background ? null : <ActiveScratchpadHost {...props} />;
}

function ActiveScratchpadHost({ environmentId, owner, composerDraftTarget }: ScratchpadHostProps) {
  const root = useScratchpadRoot(environmentId);
  const mounted = useScratchpadStore((state) => state.phase !== "closed");
  const openCount = useScratchpadStore((state) => state.openCount);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  // Nothing to open on a host without the scratchpad folder; a store left "open" there would
  // have no overlay to close it again.
  const toggle = useEffectEvent(() => {
    if (root !== undefined) useScratchpadStore.getState().toggleScratchpad();
  });
  const canOpen = useEffectEvent(() => root !== undefined);
  // The key engine's leader row and the palette run the command through the registry.
  useCommandHandlers({ "scratchpad.toggle": () => toggle() });

  // The chord itself: each command owner listens on the window, as the sidebar's host does. The
  // scratchpad's Neovim lets it through because the command outranks Neovim.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown listener for the scratchpad chord while the chat view is mounted
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !canOpen()) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused(), previewFocus: isPreviewFocused() },
      });
      if (command !== "scratchpad.toggle") return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) toggle();
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
