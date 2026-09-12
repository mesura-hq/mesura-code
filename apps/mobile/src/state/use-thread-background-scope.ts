import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { retainMobileBackgroundScope } from "../connection/background-activity-scopes";

/**
 * Reports that this phone is looking at a thread, for as long as the screen
 * showing it stays mounted.
 *
 * The twin of `apps/web/src/hooks/useThreadBackgroundScope.ts`, which carries
 * the reasoning for why this scope is retained explicitly instead of derived
 * from a subscription, and for why an unvalidated route id is acceptable here.
 * Read that one first; do not restate it.
 *
 * Tablets reach the same screen through the adaptive layout, so one call there
 * covers both the phone and the tablet arrangement.
 */
export function useThreadBackgroundScope(threadRef: ScopedThreadRef | null): void {
  const environmentId = threadRef?.environmentId ?? null;
  const threadId = threadRef?.threadId ?? null;

  useEffect(() => {
    if (environmentId === null || threadId === null) return;
    return retainMobileBackgroundScope(environmentId, { type: "thread", threadId });
  }, [environmentId, threadId]);
}
