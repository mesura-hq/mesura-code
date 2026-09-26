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

  // Whatever this config binds the pane commands to, computed once. Matching
  // an event against these is what lets the handler decline in a couple of
  // comparisons instead of scanning the whole table.
  //
  // Derived from the config rather than hardcoded to `h`, `j`, `k` and `l`,
  // because a rebound pane chord has to keep working and a hardcoded key
  // would silently stop honouring it.
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
      // The vertical chords disable themselves, and that is the mechanism
      // rather than an omission. Both share their key with something else —
      // `mod+j` with the terminal toggle by design — so consuming one where
      // it does not apply would take that other meaning away. Declining
      // leaves the event untouched and the other owner runs.
      //
      // Not resolved against the whole table, deliberately: `mod+j` answers
      // the toggle by last-wins, so asking would always decline and the
      // chord would never work at all.
      const target = neighbourOf(from, direction);
      if (target === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
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
 * A list chord leaves the keyboard in the list.
 *
 * `j` and `k` walk the sidebar's thread list, and opening a thread focuses
 * the composer — ChatView does that on every change of the active thread.
 * That is right when you clicked the row and wrong when you walked to it:
 * without this, `j` works exactly once and the second one types a letter into
 * the composer. Observed in the running app; no unit test sees it, because
 * the two behaviours live in different components and only meet on screen.
 *
 * Putting the keyboard back beats stopping the composer from taking it. The
 * mouse path wants that focus — click a thread, start typing — and the two
 * paths are indistinguishable at the moment the composer asks, so a guard
 * there would have to break one of them.
 *
 * The claim is armed by a list chord typed with the sidebar focused, and it
 * answers the next focus loss out of the sidebar by focusing the sidebar's
 * active row again. It disarms on the first key that is not another list
 * chord, and in any case once `SIDEBAR_CLAIM_WINDOW_MS` has passed, so it can
 * never sit waiting to snatch focus back from something unrelated.
 */
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

      // Past this point the key is `j` or `k`, and those are the first bare
      // letters the app has ever bound, so this is the first time a common
      // letter reads the focus tree at all. Measured in the running app
      // against the real tree: 1.699 microseconds per read over 200,000
      // reads, twice per keystroke because the sidebar's own handler asks
      // again. Against the editor's 16.7 ms insert-mode budget that is two
      // hundredths of one percent, and autorepeat is already filtered out
      // above, so holding a key costs nothing at all.
      if (getFocusedPane() === "sidebar") {
        armedUntil = now() + SIDEBAR_CLAIM_WINDOW_MS;
        return;
      }

      // The keyboard is not in the sidebar. Either this is an ordinary `j`
      // typed somewhere else, or it is the second chord of a fast run and the
      // composer has taken focus in between without the rescue frame having
      // run yet.
      //
      // The claim being armed is what tells the two apart, and it is the case
      // worth catching: without this, the second `j` of a double tap types a
      // letter into the draft and leaves the keyboard there. Moving focus back
      // now — synchronously, inside the capture phase — fixes both halves at
      // once. The sidebar's own handler runs later in the same event and so
      // sees the sidebar focused, and the character never lands, because the
      // element it would have gone into no longer has the keyboard.
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
        // Only the chat is taken back from, and this is the whole of the
        // narrowness. The one theft being undone is ChatView focusing the
        // composer on every change of the active thread. Anything else that
        // takes the keyboard inside the window — a dialog, the command
        // palette, a context menu, all of which render outside every pane
        // root — the person opened on purpose, and yanking focus out of it
        // would be far worse than the problem this fixes.
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

/**
 * Names the open thread's row as the way into the sidebar.
 *
 * Without this the sidebar's entry is whatever selector matches first, and
 * arriving by `Ctrl+H` puts the keyboard on a row you were not looking at.
 * The row is found by the key the list already renders on it; the route is
 * the only thing that knows which key that is, which is why this is here and
 * not in `paneFocus.ts`.
 */
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
  useEffect(() => registerSidebarThreadEntry(activeThreadKey), [activeThreadKey]);
  useEffect(
    () =>
      registerDrawerFocusMark({
        document: document as unknown as FocusEventSource,
        root: document.documentElement,
        getActiveElement: () => document.activeElement,
      }),
    [],
  );
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
