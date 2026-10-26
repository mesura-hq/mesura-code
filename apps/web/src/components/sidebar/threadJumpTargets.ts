import type { ResolvedKeybindingsConfig, ThreadJumpKeybindingCommand } from "@t3tools/contracts";
import { useLayoutEffect, useRef, useState } from "react";

import {
  shortcutLabelForCommand,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  type ShortcutMatchContext,
} from "../../keybindings";
import { isPreviewFocused } from "../../lib/previewFocus";
import { readViewportThreadKeys, useViewportThreadKeys } from "../../lib/sidebarThreadViewport";

/**
 * One of the sidebar's number keys: the n-th jump command opens the n-th
 * thread row on screen, and the row shows the command's label while the jump
 * modifier is held.
 */
export interface ThreadJumpTarget {
  readonly threadKey: string;
  readonly command: ThreadJumpKeybindingCommand;
  readonly label: string;
}

/**
 * The jump target of each row, top to bottom. A row whose command has no
 * shortcut in `context` gets none: the command is unbound, or another command
 * claims its chord there, as the preview claims mod+0 while it has focus.
 */
export function resolveThreadJumpTargets(
  threadKeys: readonly string[],
  keybindings: ResolvedKeybindingsConfig,
  context: Partial<ShortcutMatchContext>,
): ThreadJumpTarget[] {
  const targets: ThreadJumpTarget[] = [];
  for (const [index, threadKey] of threadKeys.entries()) {
    const command = threadJumpCommandForIndex(index);
    if (command === null) break;
    const label = shortcutLabelForCommand(keybindings, command, { context });
    if (label !== null) targets.push({ threadKey, command, label });
  }
  return targets;
}

export interface ThreadJumpTargets {
  /** The label each row shows. Empty while the hints are hidden. */
  readonly labelByThreadKey: ReadonlyMap<string, string>;
  /** The thread a resolved jump command opens, or null. */
  readonly threadKeyForJump: (command: string) => string | null;
}

const NO_LABELS: ReadonlyMap<string, string> = new Map();

/**
 * The sidebar's labels and its jumps, from one list: the rows on screen in
 * the order they show. While the hints show, a jump opens the row that shows
 * its label, so a key cannot name one thread and open another. Hidden, a
 * jump reads the rows on screen when its key is pressed.
 */
export function useThreadJumpTargets(input: {
  readonly active: boolean;
  readonly orderedThreadKeys: readonly string[];
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly terminalOpen: boolean;
}): ThreadJumpTargets {
  const { active, orderedThreadKeys, keybindings, terminalOpen } = input;
  const viewportThreadKeys = useViewportThreadKeys(active);
  const previewFocus = usePreviewFocusWhile(active);
  const shownTargets = active
    ? resolveThreadJumpTargets(viewportThreadKeys ?? orderedThreadKeys, keybindings, {
        terminalOpen,
        previewFocus,
      })
    : null;

  const shownTargetsRef = useRef(shownTargets);
  const orderedThreadKeysRef = useRef(orderedThreadKeys);
  useLayoutEffect(() => {
    shownTargetsRef.current = shownTargets;
    orderedThreadKeysRef.current = orderedThreadKeys;
  });
  const threadKeyForJump = (command: string) => {
    const shown = shownTargetsRef.current;
    if (shown !== null) {
      return shown.find((target) => target.command === command)?.threadKey ?? null;
    }
    const index = threadJumpIndexFromCommand(command);
    if (index === null) return null;
    return (readViewportThreadKeys() ?? orderedThreadKeysRef.current)[index] ?? null;
  };

  return {
    labelByThreadKey:
      shownTargets === null
        ? NO_LABELS
        : new Map(shownTargets.map((target) => [target.threadKey, target.label] as const)),
    threadKeyForJump,
  };
}

/**
 * Whether the preview has focus, followed while `active`. Focus moves without
 * rendering the sidebar, so it is read on each focus change.
 */
export function usePreviewFocusWhile(active: boolean): boolean {
  const [previewFocus, setPreviewFocus] = useState(false);
  useLayoutEffect(() => {
    if (!active) return;
    const read = () => setPreviewFocus(isPreviewFocused());
    read();
    document.addEventListener("focusin", read);
    document.addEventListener("focusout", read);
    return () => {
      document.removeEventListener("focusin", read);
      document.removeEventListener("focusout", read);
    };
  }, [active]);
  return active && previewFocus;
}
