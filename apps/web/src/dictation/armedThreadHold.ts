import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "~/connection/catalog";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentSession } from "~/state/session";
import { environmentThreadDetails } from "~/state/threads";
import {
  availabilityOf,
  type ArmedThreadAvailability,
  type ArmedThreadNeed,
} from "./armedThreadAvailability";

export function armedThreadAvailability(
  ref: ScopedThreadRef,
  need: ArmedThreadNeed = "data",
): ArmedThreadAvailability {
  return availabilityOf(
    appAtomRegistry.get(environmentThreadDetails.stateAtom(ref)),
    appAtomRegistry.get(environmentSession.sessionStateAtom(ref.environmentId)),
    appAtomRegistry.get(environmentCatalog.stateAtom(ref.environmentId)),
    need,
  );
}

/** What the user is told when an armed send stops waiting for good. */
export const ARMED_THREAD_UNREADABLE =
  "This device's session cannot read the thread. Pair it again, then send by hand.";

/**
 * Mesura: a thread's detail streams only while something mounts it, so a thread the user left
 * reads as not loaded and an armed send there was refused. A hold keeps each armed thread's detail
 * open until its send settles, and calls `onChange` when its availability (or, with
 * `watchRequests`, its pending requests) moves. Neither changes with streamed text.
 */
export function createArmedThreadHold(
  onChange: () => void,
  options: { readonly need: ArmedThreadNeed; readonly watchRequests: boolean },
) {
  const held = new Map<string, () => void>();
  const holdOne = (ref: ScopedThreadRef) => {
    const availability = Atom.make((get) =>
      availabilityOf(
        get(environmentThreadDetails.stateAtom(ref)),
        get(environmentSession.sessionStateAtom(ref.environmentId)),
        get(environmentCatalog.stateAtom(ref.environmentId)),
        options.need,
      ),
    );
    const releases = [appAtomRegistry.subscribe(availability, onChange)];
    if (options.watchRequests) {
      releases.push(
        appAtomRegistry.subscribe(environmentThreadDetails.pendingRequestsAtom(ref), onChange),
      );
    }
    return () => {
      for (const release of releases) release();
    };
  };
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
        if (!held.has(key)) held.set(key, holdOne(ref));
      }
    },
    releaseAll(): void {
      for (const release of held.values()) release();
      held.clear();
    },
  };
}
