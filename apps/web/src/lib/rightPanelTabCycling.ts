import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef, type RefObject } from "react";

import { resolveShortcutCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import { openPanelLauncher } from "./panelLauncher";
import { isTerminalFocused } from "./terminalFocus";

/**
 * `rightPanel.nextTab` / `rightPanel.previousTab` (`Ctrl+Tab`,
 * `Ctrl+Shift+Tab` while the right panel has focus): the active tab moves to
 * the next or previous one, wrapping at the ends. Outside the panel the same
 * chords walk the threads; the `panelFocus` clause on these rules and
 * last-wins resolution are what tell the two apart. `rightPanel.newTab`
 * (`Ctrl+T` in the panel) opens the panel launcher. Focus then follows into
 * the surface that is active (`usePanelSurfaceKeys`).
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
      if (command === "rightPanel.newTab") {
        const panel = latest.current.tabBarRef.current?.closest("[data-preview-panel-mode]");
        if (event.defaultPrevented || !panel?.contains(document.activeElement)) return;
        event.preventDefault();
        event.stopPropagation();
        openPanelLauncher();
        return;
      }
      if (command !== "rightPanel.nextTab" && command !== "rightPanel.previousTab") return;
      if (event.defaultPrevented) return;
      const { tabBarRef, surfaces, activeSurfaceId, onActivate } = latest.current;
      const panel = tabBarRef.current?.closest("[data-preview-panel-mode]");
      if (!panel?.contains(document.activeElement)) return;
      if (surfaces.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const index = surfaces.findIndex((surface) => surface.id === activeSurfaceId);
      const step = command === "rightPanel.nextTab" ? 1 : -1;
      const next = surfaces[(index + step + surfaces.length) % surfaces.length];
      if (!next) return;
      onActivate(next);
    };
    // Capture: a tree or the editor in the panel would take the chord first.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings]);
}
