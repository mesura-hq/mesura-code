import type {
  KeybindingCommand,
  KeybindingShortcut,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";

import {
  findEffectiveShortcutForCommand,
  matchesShortcut,
  matchesShortcutKey,
  type ShortcutMatchContext,
  type ShortcutEventLike,
} from "../../keybindings";

export interface UsagePeekKeyboardEvent extends ShortcutEventLike {
  readonly repeat: boolean;
}

export interface UsagePeekState {
  readonly held: boolean;
  readonly shortcut: KeybindingShortcut | null;
}

export interface UsagePeekTransition {
  readonly state: UsagePeekState;
  readonly handled: boolean;
}

export interface UsagePeekKeyboardLifecycle {
  readonly keyDown: (event: UsagePeekKeyboardEvent) => UsagePeekTransition;
  readonly keyUp: (event: UsagePeekKeyboardEvent) => UsagePeekTransition;
  readonly close: () => void;
  readonly visibilityChange: (visible: boolean) => void;
  readonly dispose: () => void;
  readonly getState: () => UsagePeekState;
}

/** The held-chord commands of the sidebar's docks: Alt+U for usage, Alt+S for hosts. */
export type SidebarPeekCommand = Extract<KeybindingCommand, "usage.peek" | "hosts.peek">;

export function createUsagePeekKeyboardLifecycle(input: {
  /** Defaults to the usage dock's `usage.peek`. */
  readonly command?: SidebarPeekCommand;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly platform: string;
  readonly getContext: () => Partial<ShortcutMatchContext>;
  readonly onStateChange: (state: UsagePeekState) => void;
}): UsagePeekKeyboardLifecycle {
  let state = INITIAL_USAGE_PEEK_STATE;
  const update = (next: UsagePeekState) => {
    state = next;
    input.onStateChange(next);
  };
  const close = () => update(closeHeldUsagePeek());
  return {
    keyDown: (event) => {
      const transition = transitionUsagePeekKeyDown(
        state,
        event,
        input.keybindings,
        input.platform,
        input.getContext(),
        input.command,
      );
      update(transition.state);
      return transition;
    },
    keyUp: (event) => {
      const transition = transitionUsagePeekKeyUp(state, event, input.platform);
      update(transition.state);
      return transition;
    },
    close,
    visibilityChange: (visible) => {
      if (!visible) close();
    },
    dispose: close,
    getState: () => state,
  };
}

export interface UsagePeekHoverBridge {
  readonly enter: () => void;
  readonly leave: () => void;
  readonly dispose: () => void;
}

export function createUsagePeekHoverBridge(input: {
  readonly delayMs: number;
  readonly schedule: (callback: () => void, delayMs: number) => unknown;
  readonly cancel: (handle: unknown) => void;
  readonly onHoverChange: (hovered: boolean) => void;
}): UsagePeekHoverBridge {
  let pending: unknown | null = null;
  const cancelPending = () => {
    if (pending === null) return;
    input.cancel(pending);
    pending = null;
  };
  return {
    enter: () => {
      cancelPending();
      input.onHoverChange(true);
    },
    leave: () => {
      cancelPending();
      pending = input.schedule(() => {
        pending = null;
        input.onHoverChange(false);
      }, input.delayMs);
    },
    dispose: () => {
      cancelPending();
      input.onHoverChange(false);
    },
  };
}

export const INITIAL_USAGE_PEEK_STATE: UsagePeekState = {
  held: false,
  shortcut: null,
};

export function isKeybindingCaptureTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== "object") return false;
  const closest = "closest" in target ? target.closest : undefined;
  return (
    typeof closest === "function" && closest.call(target, "[data-keybinding-capture]") !== null
  );
}

export function closeHeldUsagePeek(): UsagePeekState {
  return INITIAL_USAGE_PEEK_STATE;
}

export function transitionUsagePeekKeyDown(
  state: UsagePeekState,
  event: UsagePeekKeyboardEvent,
  keybindings: ResolvedKeybindingsConfig,
  platform: string,
  context?: Partial<ShortcutMatchContext>,
  // Trailing and defaulted so the usage dock's calls read as they always did.
  command: SidebarPeekCommand = "usage.peek",
): UsagePeekTransition {
  const shortcut = findEffectiveShortcutForCommand(keybindings, command, {
    platform,
    ...(context ? { context } : {}),
  });
  if (shortcut === null || !matchesShortcut(event, shortcut, platform)) {
    return { state, handled: false };
  }
  if (event.repeat) return { state, handled: true };
  return { state: { held: true, shortcut }, handled: true };
}

function releasedRequiredModifier(
  event: UsagePeekKeyboardEvent,
  shortcut: KeybindingShortcut,
  platform: string,
): boolean {
  const key = event.key.toLowerCase();
  const code = event.code?.toLowerCase() ?? "";
  const isMac = /mac|iphone|ipad|ipod/i.test(platform);
  const expectsMeta = shortcut.metaKey || (shortcut.modKey && isMac);
  const expectsCtrl = shortcut.ctrlKey || (shortcut.modKey && !isMac);
  return (
    (shortcut.altKey && (key === "alt" || code.startsWith("alt"))) ||
    (shortcut.shiftKey && (key === "shift" || code.startsWith("shift"))) ||
    (expectsCtrl && (key === "control" || code.startsWith("control"))) ||
    (expectsMeta && (key === "meta" || code.startsWith("meta")))
  );
}

export function transitionUsagePeekKeyUp(
  state: UsagePeekState,
  event: UsagePeekKeyboardEvent,
  platform: string,
): UsagePeekTransition {
  if (!state.held || state.shortcut === null) return { state, handled: false };
  const closes =
    matchesShortcutKey(event, state.shortcut) ||
    releasedRequiredModifier(event, state.shortcut, platform);
  return closes ? { state: closeHeldUsagePeek(), handled: true } : { state, handled: false };
}

/** A duration as its two largest units: "3m", "2h 5m", "1d 3h". Shared by both sidebar docks. */
export function formatCompactDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 1) return "less than 1m";
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const remainingMinutes = minutes % 60;
  if (days > 0) return `${days}d${hours > 0 ? ` ${hours}h` : ""}`;
  if (hours > 0) return `${hours}h${remainingMinutes > 0 ? ` ${remainingMinutes}m` : ""}`;
  return `${minutes}m`;
}
