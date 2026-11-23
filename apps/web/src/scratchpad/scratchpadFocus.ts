/** Set by the mounted, open overlay: moves the keyboard into it (editor, or the shell meanwhile). */
let focusScratchpad: (() => void) | null = null;

export function registerScratchpadFocus(focus: () => void): () => void {
  focusScratchpad = focus;
  return () => {
    if (focusScratchpad === focus) focusScratchpad = null;
  };
}

/**
 * For the command palette's focus return: an open scratchpad takes the keyboard back and the
 * palette restores nothing. False when no overlay is mounted and open.
 */
export function handOffFocusToScratchpad(): boolean {
  if (focusScratchpad === null) return false;
  focusScratchpad();
  return true;
}
