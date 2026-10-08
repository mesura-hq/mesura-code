import { useSyncExternalStore } from "react";

/**
 * A block cursor drawn as an element, for the one case a highlight cannot
 * paint: a cursor with no character under it (an empty line, the end of a
 * line). Viewport coordinates; null when no overlay is needed.
 */
export interface CursorOverlay {
  readonly left: number;
  readonly top: number;
  readonly height: number;
}

let overlay: CursorOverlay | null = null;
const listeners = new Set<() => void>();

export function setCursorOverlay(next: CursorOverlay | null): void {
  if (overlay === next) return;
  overlay = next;
  for (const listener of listeners) listener();
}

export function useCursorOverlay(): CursorOverlay | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => overlay,
    () => null,
  );
}
