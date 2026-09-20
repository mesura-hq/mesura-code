import type { ScopedThreadRef } from "@t3tools/contracts";

import { useFileManagerStore } from "./fileManagerStore";

/**
 * `fileTree.miller`: the file manager over the window, or away again. The
 * layer starts at the thread's project, so without a thread on the route
 * there is nowhere to start and the chord does nothing.
 */
export function runFileManagerToggle(routeThreadRef: ScopedThreadRef | null): void {
  if (routeThreadRef === null) return;
  useFileManagerStore.getState().toggle();
}
