import { useSyncExternalStore } from "react";

/**
 * A label for the time since `startedMs`, from one shared one-second clock.
 *
 * Mesura, phase 6 of the editor latency cycle: each working row in the sidebar
 * ran its own one-second interval, so ten running agents rendered ten separate
 * React commits every second, each one a task the editor's keys could land
 * behind. One timer ticks every reader in the same task, so they render in one
 * commit, and a reader whose label did not change (`3m` for a minute) does not
 * render at all: the label itself is the snapshot.
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
