/**
 * Mesura: the Hosts screen's sources — every environment's presentation and
 * its `hostStats` subscription, with the last readings held across a release.
 * Mirror of `apps/web/src/state/hostStats.ts` over mobile's atom wiring; the
 * projection itself is the shared model's (`projectHostStats`).
 *
 * @module state/hostStats
 */
import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import {
  readHostStatsSubscription,
  type HostStatsHistory,
  type HostStatsSubscription,
} from "@t3tools/client-runtime/host-stats";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useContext, useEffect, useMemo } from "react";

import {
  holdLastReadings,
  hostsToResubscribe,
  nextHeldReadings,
} from "../features/hosts/hostsScreen.logic";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

export interface HostStatsSources {
  readonly presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentation>;
  readonly subscriptions: ReadonlyMap<EnvironmentId, HostStatsSubscription>;
}

interface HostStatsReads extends HostStatsSources {
  /** What the live subscriptions hold, before the held readings fill their gaps. */
  readonly live: ReadonlyMap<EnvironmentId, HostStatsSubscription>;
}

const NO_SUBSCRIPTIONS: ReadonlyMap<EnvironmentId, HostStatsSubscription> = new Map();

/**
 * The last history each environment delivered, for the life of the app.
 * Mobile's `hostStats` streams close as soon as the screen lets go (idle TTL
 * 0, see `state/server.ts`), so this is what a return shows, with its age,
 * until the new snapshot replaces it. A dozen hosts of 144 buckets is small.
 */
const heldReadingsAtom = Atom.make<ReadonlyMap<EnvironmentId, HostStatsHistory>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-host-stats:held-readings"),
);

const hostStatsTarget = (environmentId: EnvironmentId) =>
  serverEnvironment.hostStats({ environmentId, input: {} });

/**
 * Subscribes to every environment only while `active`, which the screen sets
 * while it is focused and the app is in the foreground. Inactive, it reads no
 * subscription at all, so every stream is released, and shows the held
 * readings instead.
 */
export function useHostStatsSources(active: boolean): HostStatsSources {
  const readsAtom = useMemo(
    () =>
      Atom.make((get): HostStatsReads => {
        const presentations = get(environmentPresentations.presentationsAtom);
        const held = get(heldReadingsAtom);
        if (!active) {
          return {
            presentations,
            live: NO_SUBSCRIPTIONS,
            subscriptions: holdLastReadings(held, NO_SUBSCRIPTIONS),
          };
        }
        const live = new Map<EnvironmentId, HostStatsSubscription>();
        for (const environmentId of presentations.keys()) {
          live.set(environmentId, readHostStatsSubscription(get(hostStatsTarget(environmentId))));
        }
        return { presentations, live, subscriptions: holdLastReadings(held, live) };
      }),
    [active],
  );
  const reads = useAtomValue(readsAtom);
  const held = useAtomValue(heldReadingsAtom);
  const setHeld = useAtomSet(heldReadingsAtom);
  useEffect(() => {
    const next = nextHeldReadings(held, reads.live);
    if (next !== held) setHeld(next);
  }, [held, reads.live, setHeld]);
  return reads;
}

/** Restarts the stream of every connected environment: the snapshot then lands anew. */
export function useResubscribeHostStats(): (
  presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentation>,
) => void {
  const registry = useContext(RegistryContext);
  return (presentations) => {
    for (const environmentId of hostsToResubscribe(presentations)) {
      registry.refresh(hostStatsTarget(environmentId));
    }
  };
}
