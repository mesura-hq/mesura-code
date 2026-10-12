import type { WorktreeSetupSnapshot } from "@t3tools/contracts";

export interface ChatViewWorktreeSetupHistory {
  readonly routeThreadKey: string;
  readonly lastObservedSnapshot: WorktreeSetupSnapshot | null | undefined;
  readonly heldSnapshot: WorktreeSetupSnapshot | null;
}

/** Preserve the snapshot/reset effect ordering without an extra committed render. */
export function advanceChatViewWorktreeSetupHistory(
  current: ChatViewWorktreeSetupHistory | null,
  routeThreadKey: string,
  snapshot: WorktreeSetupSnapshot | null | undefined,
): ChatViewWorktreeSetupHistory {
  // The route-reset effect ran after snapshot retention, including initial mount.
  // Record this identity so the unchanged snapshot cannot resurrect reset history.
  if (current === null || current.routeThreadKey !== routeThreadKey) {
    return { routeThreadKey, lastObservedSnapshot: snapshot, heldSnapshot: null };
  }
  if (current.lastObservedSnapshot === snapshot) return current;

  const held = current.heldSnapshot;
  const heldSnapshot =
    !snapshot || (held?.threadId === snapshot.threadId && held.sequence > snapshot.sequence)
      ? held
      : snapshot;
  return { routeThreadKey, lastObservedSnapshot: snapshot, heldSnapshot };
}
