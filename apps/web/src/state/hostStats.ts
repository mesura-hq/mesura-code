/**
 * Mesura: the Hosts dock's sources — every environment's presentation and its
 * `hostStats` subscription. The projection itself is the shared model's
 * (`projectHostStats`); the dock runs it on its own clock so ages can move.
 */
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import {
  readHostStatsSubscription,
  type HostStatsSubscription,
} from "@t3tools/client-runtime/host-stats";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useContext, useEffect, useMemo, useState } from "react";

import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

export interface HostStatsSources {
  readonly presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentation>;
  readonly subscriptions: ReadonlyMap<EnvironmentId, HostStatsSubscription>;
}

const NO_SUBSCRIPTIONS: ReadonlyMap<EnvironmentId, HostStatsSubscription> = new Map();

const hostStatsTarget = (environmentId: EnvironmentId) =>
  serverEnvironment.hostStats({ environmentId, input: {} });

/**
 * Subscribes only while `enabled`, which the dock sets while it is open. A
 * closed dock keeps the last sources it read, so it never repaints as
 * "pending" behind its collapse; the atoms' five-minute idle TTL keeps a
 * re-peek instant without holding a stream for the whole session.
 */
export function useHostStatsSources(enabled: boolean): HostStatsSources {
  const sourcesAtom = useMemo(
    () =>
      Atom.make((get): HostStatsSources => {
        const presentations = get(environmentPresentations.presentationsAtom);
        if (!enabled) return { presentations, subscriptions: NO_SUBSCRIPTIONS };
        const subscriptions = new Map<EnvironmentId, HostStatsSubscription>();
        for (const environmentId of presentations.keys()) {
          subscriptions.set(
            environmentId,
            readHostStatsSubscription(get(hostStatsTarget(environmentId))),
          );
        }
        return { presentations, subscriptions };
      }),
    [enabled],
  );
  const sources = useAtomValue(sourcesAtom);
  // A refused subscription ends its stream (`accumulateHostStatsMessages`) and
  // outlives a closed dock for its idle TTL. Opening the dock starts it again,
  // so a device paired again in Settings, where the dock does not exist, reads
  // its hosts on return. Nothing else restarts: the TTL keeps a re-peek instant.
  const registry = useContext(RegistryContext);
  useEffect(() => {
    if (!enabled) return;
    for (const environmentId of registry.get(environmentPresentations.presentationsAtom).keys()) {
      const target = hostStatsTarget(environmentId);
      if (readHostStatsSubscription(registry.get(target)).unauthorized === true) {
        registry.refresh(target);
      }
    }
  }, [enabled, registry]);
  // React's "store information from previous renders" pattern: a conditional
  // set during render, which React applies before it paints.
  const [lastRead, setLastRead] = useState<HostStatsSources | null>(null);
  if (enabled && sources !== lastRead) setLastRead(sources);
  return enabled || lastRead === null ? sources : lastRead;
}
