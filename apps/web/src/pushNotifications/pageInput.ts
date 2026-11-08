/**
 * Mesura: page input for the presence report. These capture listeners on `window` must be
 * added before `keys/keyEngine.ts`'s, whose `stopImmediatePropagation` on Vim keys hides
 * them from later listeners. `main.tsx` installs this first.
 */

const PAGE_INPUT_EVENTS = ["pointerdown", "keydown"] as const;

const listeners = new Set<() => void>();
let installed = false;

function notifyPageInput(): void {
  for (const listener of listeners) listener();
}

export function installPageInputObserver(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  for (const type of PAGE_INPUT_EVENTS) {
    window.addEventListener(type, notifyPageInput, { capture: true, passive: true });
  }
}

/**
 * Calls `listener` on every page input until the returned function runs. It
 * installs the observer if `main.tsx` did not, as in a test that mounts the
 * app alone; installed that late, it misses the keys the engine consumes.
 */
export function onPageInput(listener: () => void): () => void {
  installPageInputObserver();
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
