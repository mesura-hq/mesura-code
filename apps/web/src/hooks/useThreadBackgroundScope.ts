import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { retainBackgroundScope } from "~/lib/backgroundActivityReporter";

/**
 * Not derived from `subscribeThread`: list views open it too and retention keeps it for
 * five minutes, so it would report threads nobody is looking at. The route id is not
 * checked, because gating on a loaded thread drops the scope during hydration, so a
 * consumer must treat an unknown thread id as a no-op.
 */
export function useThreadBackgroundScope(threadRef: ScopedThreadRef | null): void {
  const environmentId = threadRef?.environmentId ?? null;
  const threadId = threadRef?.threadId ?? null;

  // oxlint-disable-next-line t3code/react-effect-budget -- holds the background-scope retain for as long as the thread route is mounted
  useEffect(() => {
    if (environmentId === null || threadId === null) return;
    return retainBackgroundScope(environmentId, { type: "thread", threadId });
  }, [environmentId, threadId]);
}
