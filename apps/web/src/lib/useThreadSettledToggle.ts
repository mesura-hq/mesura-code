import type { ScopedThreadRef } from "@t3tools/contracts";
import { useMemo } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";

import { useThreadActions } from "../hooks/useThreadActions";
import { reportThreadActionFailure } from "./threadActionFailureToast";
import {
  createThreadSettledToggle,
  type ThreadSettledToggleOutcome,
  type ThreadSettledToggleTarget,
} from "./threadSettledToggle";

/**
 * React binding for `thread.toggleSettled`. The behaviour lives in
 * `threadSettledToggle.ts`; this supplies the two commands and the failure
 * reporting.
 *
 * It sends through `useThreadActions` rather than the raw mutations so the
 * shortcut inherits the same guards the menus have: an environment whose server
 * predates settlement is rejected before the round trip, and settling a thread
 * with live work — a running session, a pending approval, a queued turn — is
 * refused instead of hiding it. That hook is heavier than the two mutations
 * alone, and ChatView was not a consumer of it before. The cost was weighed and
 * taken: its subscriptions are ones ChatView mostly already holds, and the
 * cheaper alternative duplicates the guard bodies, which is how the shortcut
 * and the menus would drift apart.
 *
 * The file sits beside ChatView rather than inside it because ChatView is one
 * of the files upstream rewrites most often, and a self-contained hook keeps
 * the weekly merge surface to a single call.
 */
export function useThreadSettledToggle(
  target: ThreadSettledToggleTarget | null,
): () => ThreadSettledToggleOutcome {
  const { settleThread, unsettleThread } = useThreadActions();

  // Stable callbacks preserve the in-flight guard and the window keydown
  // listener across settled-state changes. They read the latest committed target.
  const readTarget = useStableCallback(() => target);
  const settle = useStableCallback(async (threadRef: ScopedThreadRef) => {
    reportThreadActionFailure("Failed to settle thread", await settleThread(threadRef));
  });
  const unsettle = useStableCallback(async (threadRef: ScopedThreadRef) => {
    reportThreadActionFailure("Failed to un-settle thread", await unsettleThread(threadRef));
  });

  return useMemo(
    () => createThreadSettledToggle({ readTarget, settle, unsettle }),
    [readTarget, settle, unsettle],
  );
}
