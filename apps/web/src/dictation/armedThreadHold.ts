import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadState } from "@t3tools/client-runtime/state/threads";
import { sessionDeniesScope } from "@t3tools/client-runtime/state/session";
import {
  AuthOrchestrationReadScope,
  type AuthSessionState,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentSession } from "~/state/session";
import { environmentThreadDetails } from "~/state/threads";

/**
 * `data` is satisfied by any snapshot, cached included. `live` needs the synchronized detail: a
 * cached snapshot cannot tell that a request closed.
 */
type ArmedThreadNeed = "data" | "live";
/** `unreadable`: this device's session may not read the thread, so its detail never loads. */
type ArmedThreadAvailability = "loaded" | "loading" | "gone" | "unreadable";

/**
 * Only deletion and a session without the read scope are final: a failed load retries, and the
 * send stays armed meanwhile. The thread stream does not retry an authorization failure, and its
 * error text does not tell one apart, so the session itself is asked.
 */
function availabilityOf(
  state: EnvironmentThreadState,
  session: AsyncResult.AsyncResult<AuthSessionState, unknown>,
  need: ArmedThreadNeed,
): ArmedThreadAvailability {
  if (state.status === "deleted") return "gone";
  const loaded = need === "live" ? state.status === "live" : Option.isSome(state.data);
  if (loaded) return "loaded";
  // Only a settled denial counts: a session being replaced still carries the previous answer,
  // and a network failure is not the host saying no.
  return !session.waiting && sessionDeniesScope(session, AuthOrchestrationReadScope)
    ? "unreadable"
    : "loading";
}

export function armedThreadAvailability(
  ref: ScopedThreadRef,
  need: ArmedThreadNeed = "data",
): ArmedThreadAvailability {
  return availabilityOf(
    appAtomRegistry.get(environmentThreadDetails.stateAtom(ref)),
    appAtomRegistry.get(environmentSession.sessionStateAtom(ref.environmentId)),
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
