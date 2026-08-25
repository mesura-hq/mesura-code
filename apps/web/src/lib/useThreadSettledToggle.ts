import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";

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

  // Read through a ref so the returned callback keeps a stable identity. It is
  // a dependency of ChatView's capture-phase window keydown effect, and the
  // target changes on every settled-state edge: depending on the value directly
  // would tear down and re-add that global listener as the thread runs.
  //
  // Written in an effect rather than during render, matching the sibling
  // useChatReadingScroll. React flushes pending passive effects before a
  // discrete input event, so a keydown cannot observe a stale target.
  const latestRef = useRef({ target, settleThread, unsettleThread });
  useEffect(() => {
    latestRef.current = { target, settleThread, unsettleThread };
  });

  return useMemo(
    () =>
      createThreadSettledToggle({
        readTarget: () => latestRef.current.target,
        settle: async (threadRef: ScopedThreadRef) => {
          reportThreadActionFailure(
            "Failed to settle thread",
            await latestRef.current.settleThread(threadRef),
          );
        },
        unsettle: async (threadRef: ScopedThreadRef) => {
          reportThreadActionFailure(
            "Failed to un-settle thread",
            await latestRef.current.unsettleThread(threadRef),
          );
        },
      }),
    [],
  );
}
