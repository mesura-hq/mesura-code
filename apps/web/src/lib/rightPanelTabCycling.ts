import { useAtomValue } from "@effect/atom-react";
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import { resolveShortcutCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import { isPanelLauncherKeyboardAvailable, openPanelLauncher } from "./panelLauncher";
import { isTerminalFocused } from "./terminalFocus";

// Outside the panel the same chords walk the threads; the `panelFocus` clause and
// last-wins resolution tell the two apart. Only the panel holding focus acts, so a
// second tab bar mounted for another layout stays quiet.
export function useRightPanelTabCycling<const Surface extends { readonly id: string }>(input: {
  readonly tabBarRef: RefObject<HTMLElement | null>;
  readonly panelOpen?: boolean;
  readonly surfaces: readonly Surface[];
  readonly activeSurfaceId: string | null;
  readonly onActivate: (surface: Surface) => void;
}): void {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const latest = useRef(input);
  // oxlint-disable-next-line t3code/react-effect-budget -- latest-ref: the window listener reads the newest surfaces and callbacks without resubscribing
  useLayoutEffect(() => {
    latest.current = input;
  });

  // oxlint-disable-next-line t3code/react-effect-budget -- subscribes the capture-phase window keydown listener for the tab bar's lifetime
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused() },
      });
      if (command === "rightPanel.newTab") {
        const panel = latest.current.tabBarRef.current?.closest("[data-preview-panel-mode]");
        // A closed panel keeps its surfaces mounted and can still contain focus.
        if (
          event.defaultPrevented ||
          !isPanelLauncherKeyboardAvailable(latest.current.panelOpen !== false) ||
          !panel?.contains(document.activeElement)
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        openPanelLauncher(panel);
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
