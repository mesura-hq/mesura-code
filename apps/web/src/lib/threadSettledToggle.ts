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
 * The toggle reads the settled state the user is looking at, which lags the
 * command it just sent. Two fast presses would therefore both read "active"
 * and send settle twice, leaving the thread settled when the user asked for
 * settle-then-active. The window is milliseconds on a local server and real
 * over a relay, so a press that arrives while one is in flight for the same
 * thread is dropped instead.
 *
 * A set with one entry per in-flight thread, not a single slot: threads travel
 * independently, so a press on thread B must neither be blocked by thread A's
 * command nor release it. A single slot got both wrong — B's press overwrote
 * A's entry and left A unlocked while its command was still travelling.
 *
 * Note that ChatView's parked-thread banner keeps its own `unsettlingThreadKey`
 * for the button's pending label. The two guards do not see each other, so a
 * shortcut press during a banner un-settle sends a second one. That is harmless
 * because un-settle is idempotent, and unifying them would mean rewriting the
 * banner's pending state in a file upstream rewrites weekly.
 *
 * A command that never settles holds its thread's entry for the life of the
 * page, and every later press on that thread is dropped in silence. No timer
 * guards it, because any timeout here would be an invented constant: the
 * contract that makes this safe is that `runAtomCommand` settles even on
 * interruption. A change to that contract has to revisit this.
 */
export function createThreadSettledToggle(
  deps: ThreadSettledToggleDeps,
): () => ThreadSettledToggleOutcome {
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
