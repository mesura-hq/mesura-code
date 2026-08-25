import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

/**
 * Which way `thread.toggleSettled` moves the open thread, and what stops a
 * second press from doubling the first.
 *
 * A factory rather than a hook: this repository has no `renderHook` anywhere,
 * so behaviour written as a hook would not be testable in its own idiom. The
 * React binding is `useThreadSettledToggle.ts` and decides nothing.
 */

/** The open thread as much as the toggle needs it. */
export type ThreadSettledToggleTarget = {
  readonly threadRef: ScopedThreadRef;
  /** Settled state as the user currently sees it, from `effectiveSettled`. */
  readonly settled: boolean;
};

export type ThreadSettledToggleOutcome =
  | "settle"
  | "unsettle"
  /** No thread is open, so there is nothing to settle. */
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
 * The toggle reads the settled state the user is looking at, which lags the
 * command it just sent. Two fast presses would therefore both read "active"
 * and send settle twice, leaving the thread settled when the user asked for
 * settle-then-active. The window is milliseconds on a local server and real
 * over a relay, so a press that arrives while one is in flight for the same
 * thread is dropped instead.
 *
 * The lock is keyed by thread, not a boolean: switching threads mid-flight
 * must leave the new thread free, and a command resolving for thread A must
 * never unlock thread B. Same reasoning as ChatView's `unsettlingThreadKey`.
 */
export function createThreadSettledToggle(deps: ThreadSettledToggleDeps): {
  readonly toggle: () => ThreadSettledToggleOutcome;
} {
  let pendingThreadKey: string | null = null;

  return {
    toggle: () => {
      const target = deps.readTarget();
      if (target === null) return "no-thread";

      const threadKey = scopedThreadKey(target.threadRef);
      if (pendingThreadKey === threadKey) return "in-flight";

      const outcome = target.settled ? "unsettle" : "settle";
      const run = target.settled ? deps.unsettle : deps.settle;
      pendingThreadKey = threadKey;
      void (async () => {
        try {
          await run(target.threadRef);
        } finally {
          // Guarded so a slow command for a thread the user already left
          // cannot unlock whichever thread holds the key now.
          if (pendingThreadKey === threadKey) pendingThreadKey = null;
        }
      })();
      return outcome;
    },
  };
}
