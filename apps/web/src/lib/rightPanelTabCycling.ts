import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef, type RefObject } from "react";

import { resolveShortcutCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import { isTerminalFocused } from "./terminalFocus";

/**
 * `rightPanel.nextTab` / `rightPanel.previousTab` (`Ctrl+Tab`,
 * `Ctrl+Shift+Tab` while the right panel has focus): the active tab moves to
 * the next or previous one, wrapping at the ends. Outside the panel the same
 * chords walk the threads; the `panelFocus` clause on these rules and
 * last-wins resolution are what tell the two apart.
 *
 * `tabBarRef` is any element inside the panel's tab bar. Only the panel that
 * holds focus acts, so a second tab bar mounted for another layout stays
 * quiet.
 */
export function useRightPanelTabCycling<const Surface extends { readonly id: string }>(input: {
  readonly tabBarRef: RefObject<HTMLElement | null>;
  readonly surfaces: readonly Surface[];
  readonly activeSurfaceId: string | null;
  readonly onActivate: (surface: Surface) => void;
}): void {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const latest = useRef(input);
  useEffect(() => {
    latest.current = input;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused() },
      });
      const cycles = command === "rightPanel.nextTab" || command === "rightPanel.previousTab";
      // A close may arrive already handled (ChatView prevents its default);
      // a cycle that something else handled is not ours.
      if (cycles ? event.defaultPrevented : command !== "rightPanel.close") return;
      const { tabBarRef, surfaces, activeSurfaceId, onActivate } = latest.current;
      const panel = tabBarRef.current?.closest("[data-preview-panel-mode]");
      if (!panel?.contains(document.activeElement)) return;
      // Closing is the panel's own handler; focus only has to survive it.
      if (!cycles) {
        focusActiveTabAfterRender(panel);
        return;
      }
      if (surfaces.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const index = surfaces.findIndex((surface) => surface.id === activeSurfaceId);
      const step = command === "rightPanel.nextTab" ? 1 : -1;
      const next = surfaces[(index + step + surfaces.length) % surfaces.length];
      if (!next) return;
      onActivate(next);
      focusActiveTabAfterRender(panel);
    };
    // Capture: ChatView handles the close in the capture phase and stops
    // propagation, which a bubble listener would never see past.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings]);
}

/** Frames to wait for the panel to render its new active tab after a key. */
const ACTIVE_TAB_WAIT_FRAMES = 10;

/**
 * Focus follows the active tab, onto its title button (the close button is
 * the one with a label). Left where it was, it would sit on the old tab, or
 * drop to <body> with an unmounted or closed surface, and the next Ctrl+Tab
 * would walk the threads instead. The store renders the change a frame or
 * more later, so this waits until the active tab's button is a different one
 * from the button focused at the key. A panel closed with its last tab is
 * gone, and focus is left to whatever the close chose.
 */
function focusActiveTabAfterRender(panel: Element): void {
  const before = document.activeElement;
  let frames = 0;
  const attempt = () => {
    if (!panel.isConnected) return;
    const target = panel.querySelector<HTMLElement>(
      '[data-right-panel-tabbar] [data-active-tab="true"] button:not([aria-label])',
    );
    if (target !== null && target !== before) {
      target.focus({ preventScroll: true });
      return;
    }
    if (++frames < ACTIVE_TAB_WAIT_FRAMES) window.requestAnimationFrame(attempt);
  };
  window.requestAnimationFrame(attempt);
}
