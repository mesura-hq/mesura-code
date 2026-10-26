import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

import { isElectron } from "../../env";
import { useTerminalFocus } from "../../hooks/useTerminalFocus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { useShortcutModifierState } from "../../shortcutModifierState";
import { shouldShowThreadJumpHintsForModifiers } from "../../keybindings";
import { useEffect } from "react";

/**
 * Follows the held modifiers for the sidebar's thread jump hints, and renders nothing. Its own
 * component so a modifier press re-renders only this: held in `Sidebar`, every Control key event
 * re-rendered every thread row (dnd-kit defeats the row memo). `onChange` is the delayed
 * visibility controller, so a modifier held past its delay shows hints and a chord shows none.
 */
export function ThreadJumpHintModifierSync(props: {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly terminalOpen: boolean;
  readonly onChange: (shouldShow: boolean) => void;
}) {
  const { keybindings, terminalOpen, onChange } = props;
  // Same predicate as v1: hints show only while the held modifiers exactly
  // match a thread-jump binding. Adding Shift (screenshots) or Alt no
  // longer matches ⌘1..9, so the overlay hides for chords like ⌘⇧4.
  const shortcutModifiers = useShortcutModifierState();
  const terminalFocused = useTerminalFocus();
  const shouldShowJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
    shortcutModifiers,
    keybindings,
    {
      platform: navigator.platform,
      context: {
        terminalFocus: terminalFocused,
        terminalOpen,
        modelPickerOpen: isModelPickerOpen(),
        isWeb: !isElectron,
        isDesktop: isElectron,
      },
    },
  );
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: reports the derived hint state to the parent's delayed visibility controller after commit
  useEffect(() => {
    onChange(shouldShowJumpHintsNow);
  }, [shouldShowJumpHintsNow, onChange]);
  return null;
}
