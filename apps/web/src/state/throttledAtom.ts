import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

/**
 * Mesura, phase 6 of the editor latency cycle: views that need the shell state
 * eventually, not on every streamed update, read through this. Each streamed
 * shell update otherwise re-rendered them inside the WebSocket message task that
 * delivered it, a React commit per update that the editor's keys queued behind.
 *
 * The one place that decides when a view sees a change. A change after a quiet
 * `intervalMs` is published at once; a burst publishes its latest value at most
 * once per `intervalMs`, from a timer of its own. Readers hear only of values
 * that differ from the one they hold. How a reader renders it — urgently, or as
 * a React transition — is the reader's (`useAtomValueInTransition`).
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
