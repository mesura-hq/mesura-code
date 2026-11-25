import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadState } from "@t3tools/client-runtime/state/threads";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadDetails } from "~/state/threads";

/**
 * `data` is satisfied by any snapshot, cached included. `live` needs the synchronized detail: a
 * cached snapshot cannot tell that a request closed.
 */
type ArmedThreadNeed = "data" | "live";
type ArmedThreadAvailability = "loaded" | "loading" | "gone";

/** Only deletion is final: a failed load retries, and the send stays armed meanwhile. */
function availabilityOf(state: EnvironmentThreadState, need: ArmedThreadNeed) {
  if (state.status === "deleted") return "gone";
  const loaded = need === "live" ? state.status === "live" : Option.isSome(state.data);
  return loaded ? "loaded" : "loading";
}

export function armedThreadAvailability(
  ref: ScopedThreadRef,
  need: ArmedThreadNeed = "data",
): ArmedThreadAvailability {
  return availabilityOf(appAtomRegistry.get(environmentThreadDetails.stateAtom(ref)), need);
}

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
      availabilityOf(get(environmentThreadDetails.stateAtom(ref)), options.need),
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
