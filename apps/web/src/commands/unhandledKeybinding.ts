import type { KeybindingCommand } from "@t3tools/contracts";
import type { ShortcutEventLike } from "@t3tools/shared/keybindings";

const pendingEvents = new WeakMap<KeyboardEvent, Set<KeybindingCommand>>();

/**
 * Legacy window listeners, the registry, and Electron forwarding share resolution but not dispatch.
 * Observe the event after all listeners run. A microtask can run between native event listeners,
 * so the next task is required. An unclaimed shortcut can also mean its owner is unavailable here.
 */
export function diagnoseUnhandledKeybinding(
  event: ShortcutEventLike,
  command: KeybindingCommand,
): void {
  if (
    !import.meta.env.DEV ||
    typeof KeyboardEvent === "undefined" ||
    !(event instanceof KeyboardEvent) ||
    event.type !== "keydown" ||
    !event.cancelable ||
    event.repeat ||
    event.defaultPrevented
  )
    return;
  const pending = pendingEvents.get(event);
  if (pending) {
    pending.add(command);
    return;
  }
  const commands = new Set([command]);
  pendingEvents.set(event, commands);
  setTimeout(() => {
    pendingEvents.delete(event);
    if (!event.defaultPrevented) {
      console.warn(
        "[keybindings] No handler claimed a resolved shortcut; check command ownership and the active view",
        {
          commands: [...commands],
        },
      );
    }
  }, 0);
}
