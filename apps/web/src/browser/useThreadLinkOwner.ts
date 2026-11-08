import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useLayoutEffect, useRef } from "react";

const UNMOUNTED_OWNER = AbortSignal.abort();

/** Retained menu callbacks cannot borrow a later route's controller, including
 * a return to the same thread. Layout cleanup cancels at the committed boundary.
 */
export function useThreadLinkOwner(threadRef: ScopedThreadRef | null | undefined) {
  const key = threadRef ? scopedThreadKey(threadRef) : null;
  const identity = { key };
  const receipt = useRef<{ identity: typeof identity; controller: AbortController } | null>(null);
  // oxlint-disable-next-line t3code/react-effect-budget -- the abort must fire at the commit that leaves this thread, which only layout cleanup observes
  useLayoutEffect(() => {
    const controller = new AbortController();
    receipt.current = { identity, controller };
    return () => controller.abort();
  }, [identity]);
  return () =>
    receipt.current?.identity === identity ? receipt.current.controller.signal : UNMOUNTED_OWNER;
}
