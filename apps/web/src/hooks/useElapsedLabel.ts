import { useSyncExternalStore } from "react";

/**
 * One shared timer ticks every reader in the same task, so they render in one commit
 * instead of one commit per row that the editor's keys can land behind. The label is
 * the snapshot, so a reader whose label did not change does not render.
 */
export function useElapsedLabel(startedMs: number, format: (elapsedMs: number) => string): string {
  return useSyncExternalStore(subscribe, () => format(nowMs - startedMs));
}

let nowMs = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    nowMs = Date.now();
    timer = setInterval(() => {
      nowMs = Date.now();
      for (const notify of listeners) notify();
    }, 1_000);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}
