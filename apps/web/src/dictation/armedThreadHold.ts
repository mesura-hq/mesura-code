import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadDetails } from "~/state/threads";

/**
 * Mesura: a thread's detail streams only while something mounts it, so a thread the user left
 * reads as not loaded and an armed send there was refused. A hold keeps each armed thread's detail
 * open until its send settles, and calls `onChange` when its load status or pending requests move.
 */
export function createArmedThreadHold(onChange: () => void) {
  const held = new Map<string, () => void>();
  return {
    /** Holds exactly `refs`: new ones open, ones no longer listed are let go. */
    set(refs: Iterable<ScopedThreadRef>): void {
      const wanted = new Map<string, ScopedThreadRef>();
      for (const ref of refs) wanted.set(scopedThreadKey(ref), ref);
      for (const [key, release] of held) {
        if (wanted.has(key)) continue;
        release();
        held.delete(key);
      }
      for (const [key, ref] of wanted) {
        if (held.has(key)) continue;
        // Neither changes with streamed text. Pending requests also move when the data arrives.
        const releaseStatus = appAtomRegistry.subscribe(
          environmentThreadDetails.statusAtom(ref),
          onChange,
        );
        const releaseRequests = appAtomRegistry.subscribe(
          environmentThreadDetails.pendingRequestsAtom(ref),
          onChange,
        );
        held.set(key, () => {
          releaseStatus();
          releaseRequests();
        });
      }
    },
    releaseAll(): void {
      for (const release of held.values()) release();
      held.clear();
    },
  };
}

/**
 * `loading` waits for the detail; `gone` means it will not come (deleted, or failed to load).
 * `live` needs the synchronized detail: a cached snapshot cannot tell that a request closed.
 */
export function armedThreadAvailability(
  ref: ScopedThreadRef,
  need: "data" | "live" = "data",
): "loaded" | "loading" | "gone" {
  const state = appAtomRegistry.get(environmentThreadDetails.stateAtom(ref));
  if (state.status === "deleted") return "gone";
  if (need === "live" ? state.status === "live" : Option.isSome(state.data)) return "loaded";
  return Option.isSome(state.error) && Option.isNone(state.data) ? "gone" : "loading";
}
