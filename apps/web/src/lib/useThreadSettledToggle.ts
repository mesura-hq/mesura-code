import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useThreadActions } from "../hooks/useThreadActions";
import {
  createThreadSettledToggle,
  type ThreadSettledToggleOutcome,
  type ThreadSettledToggleTarget,
} from "./threadSettledToggle";

/**
 * Local copy of the failure toast the thread action menu also uses. Shared with
 * nothing on purpose: the other copy lives in `useThreadActionMenu.ts`, one of
 * the files upstream rewrites most often, and lifting it out would put a
 * conflict there every week for one function of four lines.
 */
function reportThreadActionFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/**
 * React binding for `thread.toggleSettled`. The behaviour lives in
 * `threadSettledToggle.ts`; this supplies the two commands and the failure
 * reporting.
 *
 * It sends through `useThreadActions` rather than the raw mutations so the
 * shortcut inherits the same guards the menus have: an environment whose server
 * predates settlement is rejected before the round trip, and settling a thread
 * with live work — a running session, a pending approval, a queued turn — is
 * refused instead of hiding it.
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
  const latestRef = useRef({ target, settleThread, unsettleThread });
  useEffect(() => {
    latestRef.current = { target, settleThread, unsettleThread };
  });

  const toggle = useMemo(
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

  return toggle.toggle;
}
