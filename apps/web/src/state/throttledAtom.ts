import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

/**
 * Mesura: for views that need shell state eventually, not on every streamed update that would
 * otherwise commit inside the WebSocket message task ahead of editor keys. A change after a quiet
 * `intervalMs` publishes at once; a burst publishes its latest value at most once per `intervalMs`.
 * Readers hear only of values that differ from the one they hold.
 */
export function throttledAtom<A>(source: Atom.Atom<A>, intervalMs: number): Atom.Atom<A> {
  let publishedAt = Number.NEGATIVE_INFINITY;
  return Atom.make((get) => {
    const next = get(source);
    const held = get.self<A>();
    const now = performance.now();
    const wait = publishedAt + intervalMs - now;
    if (Option.isNone(held) || wait <= 0) {
      publishedAt = now;
      return next;
    }
    // Recomputed on every change of `source`; the timer it leaves behind is
    // cleared when the next change or the last reader arrives first.
    const timer = setTimeout(() => get.refreshSelf(), wait);
    get.addFinalizer(() => clearTimeout(timer));
    return held.value;
  });
}

/** How stale a throttled shell view may be. */
export const SHELL_VIEW_INTERVAL_MS = 1_000;
