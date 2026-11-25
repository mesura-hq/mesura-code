import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadDetails } from "~/state/threads";

/**
 * Mesura: a thread's detail streams only while something mounts it, so a thread the user left
 * reads as not loaded and an armed send there was refused. A hold keeps each armed thread's detail
 * open until its send settles, and calls `onChange` when a held thread's load status moves.
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
        held.set(
          key,
          appAtomRegistry.subscribe(environmentThreadDetails.statusAtom(ref), onChange),
        );
      }
    },
    releaseAll(): void {
      for (const release of held.values()) release();
      held.clear();
    },
  };
}

/** `loading` waits for the detail; `gone` means it will not come (deleted, or failed to load). */
export function armedThreadAvailability(ref: ScopedThreadRef): "loaded" | "loading" | "gone" {
  const state = appAtomRegistry.get(environmentThreadDetails.stateAtom(ref));
  if (Option.isSome(state.data)) return "loaded";
  return state.status === "deleted" || Option.isSome(state.error) ? "gone" : "loading";
}
