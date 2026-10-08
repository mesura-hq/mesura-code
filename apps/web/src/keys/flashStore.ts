import { useSyncExternalStore } from "react";

/** The flash labels on screen, in viewport coordinates. Empty when flash is off. */
export interface FlashLabel {
  readonly id: string;
  readonly label: string;
  readonly left: number;
  readonly top: number;
}

export interface FlashSnapshot {
  readonly pattern: string;
  readonly labels: readonly FlashLabel[];
  /** Highlighted match ranges, painted by the CSS Highlight API, not DOM. */
  readonly active: boolean;
}

const IDLE: FlashSnapshot = { pattern: "", labels: [], active: false };
let snapshot = IDLE;
const listeners = new Set<() => void>();

export function setFlashSnapshot(next: FlashSnapshot | null): void {
  snapshot = next ?? IDLE;
  for (const listener of listeners) listener();
}

export function useFlashSnapshot(): FlashSnapshot {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => snapshot,
  );
}
