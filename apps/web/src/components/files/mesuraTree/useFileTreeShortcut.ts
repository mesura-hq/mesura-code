import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { resolveShortcutCommand } from "~/keybindings";
import { isPreviewFocused } from "~/lib/previewFocus";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { selectActiveRightPanel, useRightPanelStore } from "~/rightPanelStore";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "~/terminalUiStateStore";

import { runFileTreeToggle, runOverviewToggle } from "./fileTreeFocusMoves";

/**
 * `fileTree.toggle` and `fileTree.overview`, dispatched from a window
 * capture-phase listener.
 *
 * Capture, because the tree consumes bare letters and the editor consumes
 * everything: a bubbling handler would never see the chord from either. The
 * shortcut context mirrors the chat route's own listener so `when` clauses
 * read the same.
 */
export function useFileTreeShortcut(routeThreadRef: ScopedThreadRef | null): void {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const terminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  const previewOpen = useRightPanelStore((state) =>
    routeThreadRef
      ? selectActiveRightPanel(state.byThreadKey, routeThreadRef) === "preview"
      : false,
  );
  const latest = useRef({ routeThreadRef, keybindings, terminalOpen, previewOpen });
  useEffect(() => {
    latest.current = { routeThreadRef, keybindings, terminalOpen, previewOpen };
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isCommandPaletteOpen()) return;
      const current = latest.current;
      const command = resolveShortcutCommand(event, current.keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: current.terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen: current.previewOpen,
        },
      });
      if (command !== "fileTree.toggle" && command !== "fileTree.overview") return;
      event.preventDefault();
      event.stopPropagation();
      // A held chord toggles once, not at the key-repeat rate.
      if (event.repeat) return;
      if (command === "fileTree.toggle") runFileTreeToggle(current.routeThreadRef);
      else runOverviewToggle(current.routeThreadRef);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
