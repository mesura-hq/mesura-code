import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

import type { ScopedThreadRef } from "@t3tools/contracts";
import { useThreadJumpHintsVisible } from "../Sidebar.logic";
import { useEffect } from "react";

/**
 * Follows the held modifiers for the sidebar's thread jump hints, and renders nothing. Its own
 * component so a modifier press re-renders only this: held in `Sidebar`, every Control key event
 * re-rendered every thread row (dnd-kit defeats the row memo). The show delay runs here too, so
 * `onChange` hears only a real change: a modifier held past the delay, never a quick chord.
 */
export function ThreadJumpHintModifierSync(props: {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly terminalOpen: boolean;
  readonly routeThreadRef?: ScopedThreadRef | null;
  readonly onChange: (shouldShow: boolean) => void;
}) {
  const { keybindings, onChange, routeThreadRef = null } = props;
  const showJumpHints = useThreadJumpHintsVisible(keybindings, routeThreadRef);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fork: reports the delayed hint visibility to the parent after commit
  useEffect(() => {
    onChange(showJumpHints);
  }, [showJumpHints, onChange]);
  return null;
}
