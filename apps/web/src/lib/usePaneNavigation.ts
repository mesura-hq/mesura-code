import { useEffect } from "react";

import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

import { findLastMatchingBinding, matchesShortcut, type ShortcutEventLike } from "../keybindings";
import { registerDrawerFocusMark, type FocusEventSource } from "./drawerFocusMark";
import { isPreviewFocused } from "./previewFocus";
import { isTerminalFocused } from "./terminalFocus";
import {
  focusPane,
  getFocusedPane,
  getLastFocusedPane,
  isPaneReachable,
  neighbourOf,
  registerPaneEntry,
  type PaneDirection,
  type PaneId,
} from "./paneFocus";
import { closeAgentSearchPopupForWorkspace } from "../components/searches/agentSearchPopupStore";

// Claimed in the capture phase and never forwarded, so the chord means the same in
// Neovim and the terminal; Neovim keeps `<C-w>h`/`<C-w>l` since a prefix chord is
// never captured. Never wraps and is silent at the edge: a chord whose effect
// depends on invisible state is worse than one that does nothing.

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

/** Every pane command, and the way each one moves. */
const PANE_COMMAND_DIRECTIONS: ReadonlyMap<string, PaneDirection> = new Map([
  ["pane.focusLeft", "left"],
  ["pane.focusRight", "right"],
  ["pane.focusUp", "up"],
  ["pane.focusDown", "down"],
]);

export function createPaneNavigationHandler(input: {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly platform?: string;
}): (event: PaneNavigationEvent) => void {
  const platform = input.platform;

  // From the config, not hardcoded `h`/`j`/`k`/`l`, so a rebound chord keeps
  // working; precomputed so the handler declines in a few comparisons.
  const paneBindings = input.keybindings.filter((binding) =>
    PANE_COMMAND_DIRECTIONS.has(binding.command),
  );

  return (event) => {
    // An autorepeat would fly across every pane while the key is held, a
    // composition is mid-word in an IME, and an event somebody already took
    // is not ours to take again.
    if (event.defaultPrevented === true) return;
    if (event.repeat === true || event.isComposing === true) return;

    // The cheap gate. This handler sits on every keystroke in the app,
    // including every one typed into the editor, whose insert-mode latency is
    // measured against a 16.7 ms budget, so nothing below runs for ordinary
    // typing.
    if (!paneBindings.some((binding) => matchesShortcut(event, binding.shortcut, platform))) {
      return;
    }

    // One context for both resolutions below, built only once the chord is
    // plausible. The terminal and preview flags are real rather than left at
    // their defaults: a pane rule may be scoped by either, and so may the
    // rule that outranks it.
    const options = {
      ...(platform === undefined ? {} : { platform }),
      context: { terminalFocus: isTerminalFocused(), previewFocus: isPreviewFocused() },
    };

    const paneMatch = findLastMatchingBinding(event, paneBindings, options);
    if (paneMatch === null) return;
    const direction = PANE_COMMAND_DIRECTIONS.get(paneMatch.command);
    if (direction === undefined) return;

    const from = getFocusedPane() ?? getLastFocusedPane();

    if (direction === "up" || direction === "down") {
      // Declining is the mechanism: `mod+j` is also the terminal toggle, so
      // consuming it where it does not apply would take that meaning away. Not
      // resolved against the whole table, where the toggle wins by last-wins.
      const target = neighbourOf(from, direction);
      if (target === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeAgentSearchPopupForWorkspace();
      focusPane(target);
      return;
    }

    // Horizontal is the opposite case: the application owns the chord in
    // every pane, so it is resolved against the whole table first, because
    // another binding on the same chord may outrank the pane one.
    const winner = findLastMatchingBinding(event, input.keybindings, options);
    if (winner === null) return;
    // Taken from the winner rather than from the pane match above. The two
    // can name different directions where a config binds two pane commands
    // to one chord, and the winner is the one that should decide.
    const winningDirection = PANE_COMMAND_DIRECTIONS.get(winner.command);
    if (winningDirection !== "left" && winningDirection !== "right") return;

    // Consumed even where the move is a no-op. Letting it fall through at the
    // edge would hand the chord a second meaning in exactly the place the
    // first one does not apply, which is the ambiguity being removed.
    event.preventDefault();
    event.stopImmediatePropagation();
    const target = neighbourOf(from, winningDirection);
    if (target === null) return;
    closeAgentSearchPopupForWorkspace();
    focusPane(target);
  };
}

// Invariant: the keyboard is never left in a pane nobody can see. Closing the panel
// unmounts it (a `focusout`); collapsing the sidebar slides it off-screen with no
// blur at all, so the guard rechecks after any layout change. A merely blurred pane
// is left alone: Neovim blurs to <body> on leaving normal mode.
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

// ChatView focuses the composer on every thread change, so without this `j` works
// once and the next one types into the draft. A list chord with the sidebar focused
// arms a claim that refocuses the active row on the next focus loss; any other key
// or `SIDEBAR_CLAIM_WINDOW_MS` disarms it. The mouse path keeps the composer focus.
export interface SidebarListFocusClaim {
  readonly onKeyDown: (event: PaneNavigationEvent) => void;
  readonly onFocusOut: (event: PaneFocusOutEvent) => void;
}

/** Every command that walks the thread list. */
const THREAD_LIST_COMMANDS: ReadonlySet<string> = new Set([
  "thread.next",
  "thread.previous",
  "thread.nextPage",
  "thread.previousPage",
]);

/**
 * How long the claim stays armed. Long enough for the route to change and
 * the composer to ask for focus, short enough that it has always expired
 * before a person could have typed something else on purpose.
 */
const SIDEBAR_CLAIM_WINDOW_MS = 600;

export function createSidebarListFocusClaim(input: {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly platform?: string;
  readonly scheduleFrame: (callback: () => void) => void;
  readonly now?: () => number;
}): SidebarListFocusClaim {
  const platform = input.platform;
  const now = input.now ?? (() => Date.now());
  const listBindings = input.keybindings.filter((binding) =>
    THREAD_LIST_COMMANDS.has(binding.command),
  );

  let armedUntil = 0;

  return {
    onKeyDown: (event) => {
      if (event.repeat === true || event.isComposing === true) return;
      // The same cheap gate the pane handler uses: an ordinary keystroke is
      // a couple of shortcut comparisons and nothing more.
      const matches = listBindings.some((binding) =>
        matchesShortcut(event, binding.shortcut, platform),
      );
      if (!matches) {
        // Any other key means the person moved on, so stop waiting.
        armedUntil = 0;
        return;
      }

      // The first bare letters to read the focus tree: measured at 1.7 us per
      // read, twice per keystroke, negligible against the editor's 16.7 ms budget.
      if (getFocusedPane() === "sidebar") {
        armedUntil = now() + SIDEBAR_CLAIM_WINDOW_MS;
        return;
      }

      // Armed and outside the sidebar: the composer took focus mid double-tap.
      // Refocusing synchronously in the capture phase stops the letter landing
      // in the draft, and the sidebar's own handler then sees the sidebar focused.
      if (now() <= armedUntil && isPaneReachable("sidebar") && focusPane("sidebar")) {
        armedUntil = now() + SIDEBAR_CLAIM_WINDOW_MS;
        return;
      }

      // Elsewhere `j` is a letter, and this must not hold onto anything.
      armedUntil = 0;
    },
    onFocusOut: () => {
      if (now() > armedUntil) return;
      input.scheduleFrame(() => {
        if (now() > armedUntil) return;
        // Only the chat is taken back from, undoing ChatView's composer focus. A
        // dialog, palette or menu opened in the window was opened on purpose.
        if (getFocusedPane() !== "chat") return;
        if (!isPaneReachable("sidebar")) return;
        // Focuses the active row, which by now is the thread just opened.
        focusPane("sidebar");
      });
    },
  };
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
  const listClaim = createSidebarListFocusClaim({
    keybindings: input.keybindings,
    ...(input.platform === undefined ? {} : { platform: input.platform }),
    scheduleFrame: input.scheduleFrame,
  });

  // Both in the capture phase, and the claim second: the pane handler may
  // consume the event, and a consumed pane chord is not a list chord.
  input.window.addEventListener("keydown", onKeyDown as (event: never) => void, true);
  input.window.addEventListener("keydown", listClaim.onKeyDown as (event: never) => void, true);
  input.document.addEventListener("focusout", guard.onFocusOut as (event: never) => void, true);
  input.document.addEventListener("focusout", listClaim.onFocusOut as (event: never) => void, true);
  const stopObserving = input.observeLayout(guard.onLayoutChange);

  return () => {
    input.window.removeEventListener("keydown", onKeyDown as (event: never) => void, true);
    input.window.removeEventListener(
      "keydown",
      listClaim.onKeyDown as (event: never) => void,
      true,
    );
    input.document.removeEventListener(
      "focusout",
      guard.onFocusOut as (event: never) => void,
      true,
    );
    input.document.removeEventListener(
      "focusout",
      listClaim.onFocusOut as (event: never) => void,
      true,
    );
    stopObserving();
  };
}

// Attributes only: `childList` over the document would fire for every row the
// virtualised message list recycles. `data-state` also fires for menus and
// popovers, which is affordable because checks coalesce to one per frame.
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

// Without this, `Ctrl+H` lands on whichever row matches first. Only the route
// knows the open thread's key, so this lives here and not in `paneFocus.ts`.
export function registerSidebarThreadEntry(threadKey: string | null): () => void {
  return registerPaneEntry("sidebar", () => {
    if (threadKey === null || typeof document === "undefined") return false;
    const row = document.querySelector<HTMLElement>(
      `[data-app-sidebar] [data-thread-item][data-thread-key="${threadKey}"] [role="button"]`,
    );
    // False rather than a throw: the row is virtualised away when the list is
    // long and the thread is far down it, and `focusPane` then falls through
    // to the first row, which is a reasonable place to be.
    if (row === null) return false;
    row.focus({ preventScroll: true });
    return true;
  });
}

/** Mounts pane navigation for as long as the component is on screen. */
export function usePaneNavigation(
  keybindings: ResolvedKeybindingsConfig,
  activeThreadKey: string | null = null,
): void {
  // oxlint-disable-next-line t3code/react-effect-budget -- registers the open thread's row in the module's pane-entry registry while it is active
  useEffect(() => registerSidebarThreadEntry(activeThreadKey), [activeThreadKey]);
  // oxlint-disable-next-line t3code/react-effect-budget -- subscribes document focus listeners that mirror drawer focus onto <html>
  useEffect(
    () =>
      registerDrawerFocusMark({
        document: document as unknown as FocusEventSource,
        root: document.documentElement,
        getActiveElement: () => document.activeElement,
      }),
    [],
  );
  // oxlint-disable-next-line t3code/react-effect-budget -- subscribes capture-phase window and document listeners plus a MutationObserver
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
