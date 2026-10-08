import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { isMacPlatform } from "~/lib/utils";
import { findEffectiveShortcutForCommand } from "~/keybindings";

/**
 * Runs an existing keybinding command from a leader sequence.
 *
 * HACK: replays the command's current chord as a synthetic `keydown`, so the
 * component that already handles that chord runs it. The clean design is a
 * command registry whose entries own their `run()` (Zed actions), but every
 * handler today lives inline in a component's own key listener, and moving
 * them is the implementation phase's work, not the prototype's. Remove once
 * the handlers are registered in the command registry
 * (docs/mesura/adr-009-modal-keys.md, "Command registry").
 */

const syntheticEvents = new WeakSet<Event>();

export function isSyntheticKeybindingReplay(event: Event): boolean {
  return syntheticEvents.has(event);
}

export function replayKeybindingCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
): boolean {
  const shortcut = findEffectiveShortcutForCommand(keybindings, command);
  if (shortcut === null) return false;
  const mac = isMacPlatform(navigator.platform);
  // The matcher lowercases `event.key`, so the stored key works as-is.
  const event = new KeyboardEvent("keydown", {
    key: shortcut.key,
    code: /^[a-z]$/i.test(shortcut.key) ? `Key${shortcut.key.toUpperCase()}` : "",
    ctrlKey: shortcut.ctrlKey || (shortcut.modKey && !mac),
    metaKey: shortcut.metaKey || (shortcut.modKey && mac),
    altKey: shortcut.altKey,
    shiftKey: shortcut.shiftKey,
    bubbles: true,
    cancelable: true,
  });
  syntheticEvents.add(event);
  (document.activeElement ?? document.body).dispatchEvent(event);
  return true;
}
