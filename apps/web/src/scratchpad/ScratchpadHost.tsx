import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { useContext, useEffect, useEffectEvent, useState } from "react";

import { useCommandHandlers } from "~/commands/commandRegistry";
import { BackgroundThreadContext } from "~/components/chat/backgroundThread";
import { type DraftId } from "~/composerDraftStore";
import { resolveShortcutCommand } from "~/keybindings";
import { isPreviewFocused } from "~/lib/previewFocus";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { primaryServerKeybindingsAtom } from "~/state/server";

import { ScratchpadOverlay } from "./ScratchpadOverlay";
import { type ScratchpadOwner } from "./scratchpadScopes";
import { scratchpadOwnerKey, useScratchpadStore } from "./scratchpadStore";
import { useScratchpadRoot } from "./useScratchpadFile";

interface ScratchpadHostProps {
  readonly environmentId: EnvironmentId;
  readonly owner: ScratchpadOwner;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
}

/**
 * One per chat view; the overlay covers the thread, not the window. A background view (side chat,
 * thread kept behind Settings) takes no command and mounts no overlay; one that goes to the
 * background with its overlay open closes it and keeps it mounted until the close settles.
 */
export function ScratchpadHost({ environmentId, owner, composerDraftTarget }: ScratchpadHostProps) {
  const background = useContext(BackgroundThreadContext);
  const root = useScratchpadRoot(environmentId);
  const phase = useScratchpadStore((state) => state.phase);
  const openOwner = useScratchpadStore((state) => state.owner);
  const ownerKey = scratchpadOwnerKey(composerDraftTarget);
  const mounted = phase !== "closed";
  // Whether this host's overlay is the one on screen; derived during render, not synced. Claimed
  // only for an open made for this view, then kept until the close ends, even if the view's
  // thread changes meanwhile (the overlay closes itself then, settling its note).
  const [claimedOwner, setClaimedOwner] = useState<string | null>(null);
  if (mounted && openOwner === ownerKey && !background && root !== undefined && !claimedOwner) {
    setClaimedOwner(ownerKey);
  }
  if (!mounted && claimedOwner !== null) setClaimedOwner(null);
  const ownsOverlay = claimedOwner !== null;
  // A view replaced outright (a draft route is keyed) unmounts with its overlay: the open ends
  // with it rather than passing to the next view. A no-op after an ordinary close.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases this view's open in the global store when the view unmounts
  useEffect(() => {
    if (claimedOwner === null) return;
    return () => useScratchpadStore.getState().abandonScratchpad(claimedOwner);
  }, [claimedOwner]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the settling close when this chat view goes to the background
  useEffect(() => {
    if (background && ownsOverlay && phase === "open") {
      useScratchpadStore.getState().closeScratchpad();
    }
  }, [background, ownsOverlay, phase]);
  const openCount = useScratchpadStore((state) => state.openCount);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  // Nothing to open on a host without the scratchpad folder; a store left "open" there would
  // have no overlay to close it again.
  const toggle = useEffectEvent(() => {
    if (!background && root !== undefined) {
      useScratchpadStore.getState().toggleScratchpad(scratchpadOwnerKey(composerDraftTarget));
    }
  });
  const canOpen = useEffectEvent(() => !background && root !== undefined);
  // The key engine's leader row and the palette run the command through the registry.
  useCommandHandlers(background ? {} : { "scratchpad.toggle": () => toggle() });

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

  if (!mounted || !ownsOverlay || root === undefined) return null;
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
