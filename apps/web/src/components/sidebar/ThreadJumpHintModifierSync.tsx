import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

import { isElectron } from "../../env";
import { useTerminalFocus } from "../../hooks/useTerminalFocus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { useShortcutModifierState } from "../../shortcutModifierState";
import { shouldShowThreadJumpHintsForModifiers } from "../../keybindings";
import { useEffect } from "react";

/**
 * Follows the held modifiers for the sidebar's thread jump hints, and renders
 * nothing.
 *
 * Its own component so that a modifier press re-renders this and nothing
 * else. Held in `Sidebar` itself, every Control keydown and keyup re-rendered
 * the whole sidebar, every thread row and every row's tooltips — dnd-kit
 * rebuilds a row's listeners on a sidebar render, so the row memo did not
 * hold. A `Ctrl-d` typed in the modal editor cost 66 row renders twice. The
 * hints themselves still appear through `onChange`, which is the delayed
 * visibility controller: a modifier held past its delay shows them, a chord
 * shows nothing.
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
  useEffect(() => {
    onChange(shouldShowJumpHintsNow);
  }, [shouldShowJumpHintsNow, onChange]);
  return null;
}
