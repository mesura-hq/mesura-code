import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

/**
 * A factory rather than a hook, because the repository has no `renderHook` to test a
 * hook with. The React binding, `useThreadSettledToggle.ts`, decides nothing.
 */

/** The open thread as much as the toggle needs it. */
export type ThreadSettledToggleTarget = {
  readonly threadRef: ScopedThreadRef;
  /** Settled state as the user currently sees it, from `effectiveSettled`. */
  readonly settled: boolean;
};

/**
 * ChatView discards this: its window handler already returns early with no
 * thread open, and there is nothing for it to do about the other two. The
 * outcomes exist so the factory is testable and so a future caller can react —
 * do not "wire up" a guard in ChatView on the strength of them.
 */
export type ThreadSettledToggleOutcome =
  | "settle"
  | "unsettle"
  /** No thread the server knows, so there is nothing to settle. */
  | "no-thread"
  /** A press for this thread is still in flight; see below. */
  | "in-flight";

export interface ThreadSettledToggleDeps {
  /**
   * Read at press time, never captured. The settled state changes under the
   * toggle constantly — a turn starting un-settles server-side — and a stale
   * capture would move the thread the wrong way.
   */
  readonly readTarget: () => ThreadSettledToggleTarget | null;
  /**
   * Both must report their own failures and must not reject. A rejection here
   * escapes as an unhandled rejection, which is the right noise for a broken
   * contract but is not a path the toggle handles.
   */
  readonly settle: (threadRef: ScopedThreadRef) => Promise<void>;
  readonly unsettle: (threadRef: ScopedThreadRef) => Promise<void>;
}

/**
 * The settled state the user sees lags the command just sent, so two fast presses would
 * both send settle. A press while one is in flight for the same thread is dropped. No
 * timer releases a stuck entry: this relies on `runAtomCommand` settling even on interruption.
 */
export function createThreadSettledToggle(
  deps: ThreadSettledToggleDeps,
): () => ThreadSettledToggleOutcome {
  // One entry per thread, not a single slot: a single slot let B's press release A's lock.
  // ChatView's banner keeps its own `unsettlingThreadKey`; a double un-settle is idempotent.
  const pendingThreadKeys = new Set<string>();

  return () => {
    const target = deps.readTarget();
    if (target === null) return "no-thread";

    const threadKey = scopedThreadKey(target.threadRef);
    if (pendingThreadKeys.has(threadKey)) return "in-flight";

    const outcome = target.settled ? "unsettle" : "settle";
    const run = target.settled ? deps.unsettle : deps.settle;
    pendingThreadKeys.add(threadKey);
    void (async () => {
      try {
        await run(target.threadRef);
      } finally {
        // Delete by key, so a command completing can only ever release the
        // thread it was sent for.
        pendingThreadKeys.delete(threadKey);
      }
    })().catch((error: unknown) => {
      // The deps contract says they report their own failures and do not
      // reject. Keep a violation loud, but carry the thread it happened on —
      // a bare unhandled rejection names nothing a debugger can use.
      console.error("thread settled toggle command rejected", { threadKey, error });
    });
    return outcome;
  };
}
