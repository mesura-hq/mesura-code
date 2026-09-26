import type { ScopedThreadRef } from "@t3tools/contracts";

import { useFileManagerStore } from "./fileManagerStore";
import { focusFileManager } from "./isFileManagerOpen";

/**
 * `fileTree.miller`: the file manager over the window, or away again. The
 * layer starts at the thread's project, so without a thread on the route
 * there is nowhere to start and the chord does nothing.
 */
export function runFileManagerToggle(routeThreadRef: ScopedThreadRef | null): void {
  if (routeThreadRef === null) return;
  useFileManagerStore.getState().toggle();
}

/**
 * Opens the layer, from an entry point that only opens: the command palette.
 * The same rule as the chord: no thread on the route, nowhere to start.
 */
export function openFileManager(routeThreadRef: ScopedThreadRef | null): void {
  if (routeThreadRef === null) return;
  useFileManagerStore.getState().setOpen(true);
}

/** The layer's ways out: a stray Escape, a file opened, a lost session, the thread leaving the route. */
export function closeFileManager(): void {
  useFileManagerStore.getState().setOpen(false);
}

/**
 * For a surface that restores focus as it closes, such as the command
 * palette: true when the file manager is open and should keep the keyboard,
 * so the surface must not hand it to the composer. Reads the store, not the
 * page, so the answer holds whether or not the layer has mounted yet; one
 * that has not takes focus itself when it mounts.
 */
export function keepFocusInFileManager(): boolean {
  if (!useFileManagerStore.getState().open) return false;
  focusFileManager();
  return true;
}
