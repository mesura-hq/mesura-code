import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { retainBackgroundScope } from "~/lib/backgroundActivityReporter";

/**
 * Reports that this client is looking at a thread, for as long as the route
 * showing it stays mounted.
 *
 * The other background scopes derive from an open subscription, because a
 * subscription exists exactly while a view needs the data. A thread cannot use
 * that rule. `orchestration.subscribeThread` is opened for any live thread
 * detail atom, including the ones list views hold, and thread retention keeps
 * it open for five minutes after the last subscriber drops. Deriving the scope
 * from it would report a thread as watched long after the user left it, and
 * would report threads nobody ever opened.
 *
 * The route that renders the thread is the honest source, so the retain is
 * explicit. The reader this exists for is per-thread editor hibernation, which
 * has to distinguish "somebody is looking at this" from "something is cached".
 *
 * The id comes from the route and is not checked against a thread that exists.
 * A mistyped or deleted id is reported like any other, and gating the retain on
 * the thread having loaded would drop the scope during hydration — exactly when
 * the user is looking hardest. Whatever consumes this scope has to treat an
 * unknown thread id as a no-op rather than an error.
 *
 * The mobile twin of this hook lives at
 * `apps/mobile/src/state/use-thread-background-scope.ts`. The two stay separate
 * because the reporter and scope store they call are already platform-local
 * twins, and the shared client package carries no React dependency.
 */
export function useThreadBackgroundScope(threadRef: ScopedThreadRef | null): void {
  const environmentId = threadRef?.environmentId ?? null;
  const threadId = threadRef?.threadId ?? null;

  useEffect(() => {
    if (environmentId === null || threadId === null) return;
    return retainBackgroundScope(environmentId, { type: "thread", threadId });
  }, [environmentId, threadId]);
}
