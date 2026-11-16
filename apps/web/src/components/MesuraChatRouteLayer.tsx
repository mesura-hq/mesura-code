import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useEffectEvent } from "react";

import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { useCommandHandlers } from "~/commands/commandRegistry";
import { MesuraFileManagerLayer } from "~/components/files/mesuraFileManager/MesuraFileManagerLayer";
import { runFileManagerToggle } from "~/components/files/mesuraFileManager/fileManagerToggle";
import { runFileTreeToggle } from "~/components/files/mesuraTree/fileTreeFocusMoves";
import { useThreadRouteRef } from "~/hooks/useThreadRouteTarget";
import { usePaneNavigation } from "~/lib/usePaneNavigation";
import { selectActiveRightPanel, useRightPanelStore } from "~/rightPanelStore";
import { registerCommands } from "~/shortcuts/dispatcher";
import { useQuietThreadShell } from "~/state/entities";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "~/terminalUiStateStore";

/** The fork's chat-route keys and the file manager, mounted while no modal page covers the chat. */
export function MesuraChatRouteLayer() {
  const routeThreadRef = useThreadRouteRef();
  const activeThread = useQuietThreadShell(routeThreadRef);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const toggleTree = useEffectEvent(() => runFileTreeToggle(routeThreadRef));
  const toggleManager = useEffectEvent(() => runFileManagerToggle(routeThreadRef));
  const readContext = useEffectEvent(() => ({
    terminalOpen: selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      routeThreadRef,
    ).terminalOpen,
    previewOpen:
      selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, routeThreadRef) ===
      "preview",
  }));
  // The Vim leader keys and upstream's chord dispatcher call the same file-manager actions.
  useCommandHandlers({
    "fileTree.toggle": toggleTree,
    "fileTree.miller": toggleManager,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers route commands with upstream's dispatcher; cleanup removes their capture scope
  useEffect(() => {
    const toggle = (run: () => void) => (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) run();
    };
    return registerCommands(
      { "fileTree.toggle": toggle(toggleTree), "fileTree.miller": toggle(toggleManager) },
      {
        capture: true,
        keybindings: () => keybindings,
        when: (event) =>
          !isCommandPaletteOpen() &&
          !(event.target instanceof Element && event.target.closest("[data-keybinding-capture]")),
        context: readContext,
      },
    );
  }, [keybindings]);
  // Pane navigation also reaches the fork's file manager and editor panes.
  usePaneNavigation(keybindings, routeThreadRef ? scopedThreadKey(routeThreadRef) : null);
  return <MesuraFileManagerLayer routeThreadRef={routeThreadRef} activeThread={activeThread} />;
}
