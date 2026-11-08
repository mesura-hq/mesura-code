import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

import { isElectron } from "../../env";
import { useTerminalFocus } from "../../hooks/useTerminalFocus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { useShortcutModifierState } from "../../shortcutModifierState";
import { shouldShowThreadJumpHintsForModifiers } from "../../keybindings";
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
  const showJumpHints = useThreadJumpHintsVisible(shouldShowJumpHintsNow);
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: reports the delayed hint visibility to the parent after commit
  useEffect(() => {
    onChange(showJumpHints);
  }, [showJumpHints, onChange]);
  return null;
}
