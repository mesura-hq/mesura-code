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
 * Sends through `useThreadActions`, not the raw mutations, so the shortcut keeps the
 * menus' guards (old servers, threads with live work). That hook is heavier, but ChatView
 * mostly holds its subscriptions already, and duplicating the guards would let them drift.
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
