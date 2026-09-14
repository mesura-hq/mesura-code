import { useEffect } from "react";

import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

import { matchesShortcut, resolveShortcutCommand, type ShortcutEventLike } from "../keybindings";
import { isPreviewFocused } from "./previewFocus";
import { isTerminalFocused } from "./terminalFocus";
import {
  focusPane,
  getFocusedPane,
  getLastFocusedPane,
  isPaneReachable,
  neighbourOf,
  type PaneId,
} from "./paneFocus";

/**
 * Directional pane navigation, claimed at the window before any pane sees it.
 *
 * The chord has one meaning wherever it is typed, including inside the
 * embedded Neovim editor and inside a terminal. That is the whole point: a
 * chord whose meaning depends on what happens to have focus is the problem
 * this exists to remove, so it is consumed in the capture phase and never
 * forwarded. Neovim's own window commands stay reachable as `<C-w>h` and
 * `<C-w>l`, because a prefix chord is never captured here.
 *
 * Directional, never wrapping, silent at the edge: `Ctrl+L` from the
 * rightmost pane does nothing rather than jumping to the leftmost, because a
 * chord whose effect depends on invisible state is worse than one that does
 * nothing.
 */

export interface PaneNavigationEvent extends ShortcutEventLike {
  readonly repeat?: boolean;
  readonly isComposing?: boolean;
  readonly defaultPrevented?: boolean;
  preventDefault(): void;
  stopImmediatePropagation(): void;
}

export interface PaneFocusOutEvent {
  readonly relatedTarget: unknown;
}

interface MinimalEventTarget {
  addEventListener(type: string, listener: (event: never) => void, capture: boolean): void;
  removeEventListener(type: string, listener: (event: never) => void, capture: boolean): void;
}

/** The commands this handler claims. Not every pane command: see phase notes. */
const HORIZONTAL_PANE_COMMANDS: ReadonlySet<string> = new Set([
  "pane.focusLeft",
  "pane.focusRight",
]);

export function createPaneNavigationHandler(input: {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly platform?: string;
}): (event: PaneNavigationEvent) => void {
  const platform = input.platform;

  // Whatever this config binds the pane commands to, computed once. Matching
  // an event against these two is what lets the handler decline in a couple
  // of comparisons instead of scanning the whole table.
  //
  // Derived from the config rather than hardcoded to `h` and `l`, because a
  // rebound pane chord has to keep working and a hardcoded key would silently
  // stop honouring it.
  const paneBindings = input.keybindings.filter((binding) =>
    HORIZONTAL_PANE_COMMANDS.has(binding.command),
  );

  return (event) => {
    // An autorepeat would fly across every pane while the key is held, a
    // composition is mid-word in an IME, and an event somebody already took
    // is not ours to take again.
    if (event.defaultPrevented === true) return;
    if (event.repeat === true || event.isComposing === true) return;

    // The cheap gate. This handler sits on every keystroke in the app,
    // including every one typed into the editor, whose insert-mode latency is
    // measured against a 16.7 ms budget, so the full resolution below must
    // not run for ordinary typing.
    if (!paneBindings.some((binding) => matchesShortcut(event, binding.shortcut, platform))) {
      return;
    }

    // Resolved properly now that the chord is plausible, because another
    // binding on the same chord may outrank the pane one. The terminal and
    // preview flags are supplied for the same reason: a user rule scoped by
    // one of them has to be able to win here, or this handler would swallow
    // it before the handler that honours it ever runs.
    const command = resolveShortcutCommand(event, input.keybindings, {
      ...(platform === undefined ? {} : { platform }),
      context: { terminalFocus: isTerminalFocused(), previewFocus: isPreviewFocused() },
    });
    if (command !== "pane.focusLeft" && command !== "pane.focusRight") return;

    // Consumed even where the move is a no-op. Letting it fall through at the
    // edge would hand the chord a second meaning in exactly the place the
    // first one does not apply, which is the ambiguity being removed.
    event.preventDefault();
    event.stopImmediatePropagation();

    const from = getFocusedPane() ?? getLastFocusedPane();
    const target = neighbourOf(from, command === "pane.focusLeft" ? "left" : "right");
    if (target !== null) focusPane(target);
  };
}

/**
 * The invariant: the keyboard is never left in a pane nobody can see.
 *
 * Two different things break it, and they look nothing alike:
 *
 * - **The pane unmounts.** Closing the right panel removes its subtree, focus
 *   falls to the document body, and a `focusout` fires.
 * - **The pane stays but goes away.** Collapsing the sidebar keeps every row
 *   mounted, focusable and in the tab order, and slides the container
 *   off-screen. No blur happens, no `focusout` fires, and the focused row
 *   keeps the keyboard while being invisible. Observed in the running app,
 *   which is the only reason this second trigger exists.
 *
 * So the guard is keyed on the invariant rather than on either event: after
 * anything that could change the layout, if the pane holding focus is no
 * longer reachable, move the keyboard somewhere it can be seen.
 *
 * A pane that merely blurred is left alone. Leaving Neovim's normal mode
 * blurs the editor to the body on purpose, and a rescue there would yank the
 * keyboard out of the pane the developer is working in.
 */
export interface PaneFocusGuard {
  /** Focus left an element. Only interesting when it went nowhere. */
  readonly onFocusOut: (event: PaneFocusOutEvent) => void;
  /** Something that could have opened or closed a pane happened. */
  readonly onLayoutChange: () => void;
}

export function createPaneFocusGuard(input: {
  readonly scheduleFrame: (callback: () => void) => void;
}): PaneFocusGuard {
  let scheduled = false;

  // Coalesced to one check per frame: a single collapse emits several
  // attribute mutations, and they all ask the same question.
  const check = (): void => {
    if (scheduled) return;
    scheduled = true;
    input.scheduleFrame(() => {
      scheduled = false;
      rescueIfStranded();
    });
  };

  return {
    onFocusOut: (event) => {
      // Focus went somewhere real, so nothing was dropped.
      if (event.relatedTarget !== null && event.relatedTarget !== undefined) return;
      check();
    },
    onLayoutChange: check,
  };
}

/** The pane the keyboard goes to when its own pane is gone. */
const RESCUE_ORDER: ReadonlyArray<PaneId> = ["chat", "sidebar", "panel"];

function rescueIfStranded(): void {
  if (typeof document === "undefined") return;

  const focused = getFocusedPane();
  if (focused !== null) {
    // Focus is somewhere. Only a pane that has gone away is a problem, and
    // this is the branch that catches the collapsed sidebar.
    if (isPaneReachable(focused)) return;
    rescueToFirstReachablePane();
    return;
  }

  const active = document.activeElement;
  // Something took the keyboard in the meantime, a dialog most likely.
  if (active !== null && active !== undefined && active !== document.body) return;
  // The pane is still there and simply has no focus. That is ordinary.
  if (isPaneReachable(getLastFocusedPane())) return;
  rescueToFirstReachablePane();
}

function rescueToFirstReachablePane(): void {
  for (const pane of RESCUE_ORDER) {
    if (isPaneReachable(pane) && focusPane(pane)) return;
  }
}

/**
 * Wires both handlers up and returns the function that takes them down.
 *
 * Separate from the hook so the capture flags can be asserted without a
 * renderer: capture is the arbitration, not a detail of it.
 */
export function registerPaneNavigation(input: {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly platform?: string;
  readonly window: MinimalEventTarget;
  readonly document: MinimalEventTarget;
  readonly scheduleFrame: (callback: () => void) => void;
  readonly observeLayout: (onChange: () => void) => () => void;
}): () => void {
  const onKeyDown = createPaneNavigationHandler({
    keybindings: input.keybindings,
    ...(input.platform === undefined ? {} : { platform: input.platform }),
  });
  const guard = createPaneFocusGuard({ scheduleFrame: input.scheduleFrame });

  input.window.addEventListener("keydown", onKeyDown as (event: never) => void, true);
  input.document.addEventListener("focusout", guard.onFocusOut as (event: never) => void, true);
  const stopObserving = input.observeLayout(guard.onLayoutChange);

  return () => {
    input.window.removeEventListener("keydown", onKeyDown as (event: never) => void, true);
    input.document.removeEventListener(
      "focusout",
      guard.onFocusOut as (event: never) => void,
      true,
    );
    stopObserving();
  };
}

/**
 * Attributes worth watching, and no others.
 *
 * `data-state` is how the sidebar reports being collapsed, and the other two
 * are how the chat column and the right panel report being closed. Attributes
 * only: watching `childList` over the whole document would fire for every row
 * the virtualised message list recycles, which is constantly.
 *
 * `data-state` is a common attribute, so unrelated menus and popovers trigger
 * this too. That is affordable because the callback is coalesced to one check
 * per frame and the check itself is a handful of selector matches.
 */
const LAYOUT_ATTRIBUTES = [
  "data-state",
  "data-preview-panel-mode",
  "data-chat-column-maximized-away",
];

function observeLayoutWithMutations(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: LAYOUT_ATTRIBUTES,
  });
  return () => {
    observer.disconnect();
  };
}

/** Mounts pane navigation for as long as the component is on screen. */
export function usePaneNavigation(keybindings: ResolvedKeybindingsConfig): void {
  useEffect(
    () =>
      registerPaneNavigation({
        keybindings,
        window: window as unknown as MinimalEventTarget,
        document: document as unknown as MinimalEventTarget,
        scheduleFrame: (callback) => {
          requestAnimationFrame(callback);
        },
        observeLayout: observeLayoutWithMutations,
      }),
    [keybindings],
  );
}
