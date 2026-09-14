import type { ScopedThreadRef } from "@t3tools/contracts";

import { focusTarget, isFileTreeFocused } from "~/lib/focusTargets";
import {
  selectActiveRightPanelSurface,
  selectSelectedRightPanelSurface,
  useRightPanelStore,
} from "~/rightPanelStore";

import { decideFileTreeShortcut, decideOverviewShortcut } from "./fileTreeShortcutDecision";
import { useFileTreeStore } from "./fileTreeStore";

/**
 * Leaves the tree: to the editor when one is mounted, hiding the tree behind
 * it; otherwise to the composer, with the tree left in place. `Ctrl+E` from
 * inside the tree and `Escape` in it both come here, so the two routes cannot
 * drift. A file surface without an editor (an image, a rendered markdown) has
 * no editor target, and hiding the tree while the keyboard is still in it
 * would drop focus on `body`.
 */
export function leaveFileTree(): void {
  const store = useFileTreeStore.getState();
  store.clearPendingFocus();
  if (focusTarget("editor")) {
    // Focus moved before the element goes away.
    store.setExplorerOpen(false);
    return;
  }
  focusTarget("composer");
}

export function runFileTreeToggle(routeThreadRef: ScopedThreadRef | null): void {
  const store = useFileTreeStore.getState();
  const panels = useRightPanelStore.getState();
  const active = selectActiveRightPanelSurface(panels.byThreadKey, routeThreadRef);
  const action = decideFileTreeShortcut({
    hasThread: routeThreadRef !== null,
    surfaceKind: active?.kind ?? null,
    explorerOpen: store.explorerOpen,
    treeFocused: isFileTreeFocused(),
  });
  switch (action) {
    case "none":
      return;
    case "open-surface": {
      if (!routeThreadRef) return;
      showFilesSurface(routeThreadRef);
      store.setExplorerOpen(true);
      store.requestFocus();
      return;
    }
    case "show-and-focus":
      store.setExplorerOpen(true);
      if (focusTarget("tree")) store.clearPendingFocus();
      else store.requestFocus();
      return;
    case "hide-and-focus-editor":
    case "focus-composer":
      leaveFileTree();
      return;
  }
}

/**
 * A hidden panel that still holds a file keeps it; showing beats replacing
 * the developer's open file with the bare files surface.
 */
function showFilesSurface(routeThreadRef: ScopedThreadRef): void {
  const panels = useRightPanelStore.getState();
  const selected = selectSelectedRightPanelSurface(panels.byThreadKey, routeThreadRef);
  if (selected?.kind === "file" || selected?.kind === "files") panels.show(routeThreadRef);
  else panels.open(routeThreadRef, "files");
}

export function runOverviewToggle(routeThreadRef: ScopedThreadRef | null): void {
  const store = useFileTreeStore.getState();
  const panels = useRightPanelStore.getState();
  const active = selectActiveRightPanelSurface(panels.byThreadKey, routeThreadRef);
  const action = decideOverviewShortcut({
    hasThread: routeThreadRef !== null,
    surfaceKind: active?.kind ?? null,
    overviewOpen: store.overviewOpen,
  });
  switch (action) {
    case "none":
      return;
    case "close":
      store.setOverviewOpen(false);
      return;
    case "open-surface-and-overview":
      if (!routeThreadRef) return;
      showFilesSurface(routeThreadRef);
      store.setOverviewOpen(true);
      return;
    case "open":
      store.setOverviewOpen(true);
      return;
  }
}
