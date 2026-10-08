/**
 * What ChatView's Diff surface commands (`treeDiff.toggle`, `diff.modeMenu`)
 * need from the mounted DiffPanel. ChatView loads DiffPanel lazily and either
 * one can remount without the other, so the state both read lives here, at
 * module scope, rather than in either component.
 */

let lastAllocatedModeMenuRequestId = 0;
let lastServedModeMenuRequestId = 0;

/**
 * A new `diff.modeMenu` request. Ids only grow, across ChatView remounts too,
 * so a remounted ChatView never reissues an id DiffPanel already served.
 */
export function allocateDiffModeMenuRequestId(): number {
  lastAllocatedModeMenuRequestId += 1;
  return lastAllocatedModeMenuRequestId;
}

/**
 * True once per request: DiffPanel opens its mode menu only for an id it has
 * not served. Zero, ChatView's initial "no request", is never served, so a
 * remount opens nothing.
 */
export function claimDiffModeMenuRequest(requestId: number): boolean {
  if (requestId <= lastServedModeMenuRequestId) return false;
  lastServedModeMenuRequestId = requestId;
  return true;
}

/**
 * Per thread, whether the mounted DiffPanel defaults to Tree diff when the
 * thread has no stored mode. DiffPanel fixes that default at mount, while the
 * working tree's state keeps moving, so ChatView reads the panel's value
 * instead of recomputing one that can disagree with the screen.
 */
const mountedTreeDiffDefaultByThreadKey = new Map<string, { readonly treeDiff: boolean }>();

/** Records the mounted panel's default; the returned function withdraws it. */
export function recordMountedDiffPanelDefault(threadKey: string, treeDiff: boolean): () => void {
  const entry = { treeDiff };
  mountedTreeDiffDefaultByThreadKey.set(threadKey, entry);
  return () => {
    if (mountedTreeDiffDefaultByThreadKey.get(threadKey) === entry) {
      mountedTreeDiffDefaultByThreadKey.delete(threadKey);
    }
  };
}

/** The mounted panel's default for the thread, or undefined when none is mounted. */
export function mountedDiffPanelDefaultsToTreeDiff(threadKey: string): boolean | undefined {
  return mountedTreeDiffDefaultByThreadKey.get(threadKey)?.treeDiff;
}
