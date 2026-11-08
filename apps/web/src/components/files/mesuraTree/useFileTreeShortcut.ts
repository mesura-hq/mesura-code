import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { useCommandHandlers } from "~/commands/commandRegistry";
import { resolveShortcutCommand } from "~/keybindings";
import { isPreviewFocused } from "~/lib/previewFocus";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { selectActiveRightPanel, useRightPanelStore } from "~/rightPanelStore";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "~/terminalUiStateStore";

import { runFileManagerToggle } from "../mesuraFileManager/fileManagerToggle";
import { runFileTreeToggle } from "./fileTreeFocusMoves";

/**
 * `fileTree.toggle` and `fileTree.miller` on a window capture-phase listener: the tree eats
 * bare letters and the editor eats everything, so bubbling would never see the chord. The
 * context mirrors the chat route's listener so `when` clauses read the same.
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
  // oxlint-disable-next-line t3code/react-effect-budget -- fork: latest-value ref so the window listener attaches once
  useEffect(() => {
    latest.current = { routeThreadRef, keybindings, terminalOpen, previewOpen };
  });

  // oxlint-disable-next-line t3code/react-effect-budget -- fork: window capture-phase keydown subscription
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
      if (command !== "fileTree.toggle" && command !== "fileTree.miller") return;
      event.preventDefault();
      event.stopPropagation();
      // A held chord toggles once, not at the key-repeat rate.
      if (event.repeat) return;
      if (command === "fileTree.toggle") runFileTreeToggle(current.routeThreadRef);
      else runFileManagerToggle(current.routeThreadRef);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  useCommandHandlers({
    "fileTree.toggle": () => runFileTreeToggle(latest.current.routeThreadRef),
    "fileTree.miller": () => runFileManagerToggle(latest.current.routeThreadRef),
  });
}
