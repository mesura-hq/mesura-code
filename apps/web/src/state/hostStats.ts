/**
 * Mesura: the Hosts dock's sources — every environment's presentation and its
 * `hostStats` subscription. The projection itself is the shared model's
 * (`projectHostStats`); the dock runs it on its own clock so ages can move.
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import {
  readHostStatsSubscription,
  type HostStatsSubscription,
} from "@t3tools/client-runtime/host-stats";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useMemo, useState } from "react";

import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

export interface HostStatsSources {
  readonly presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentation>;
  readonly subscriptions: ReadonlyMap<EnvironmentId, HostStatsSubscription>;
}

const NO_SUBSCRIPTIONS: ReadonlyMap<EnvironmentId, HostStatsSubscription> = new Map();

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
            readHostStatsSubscription(
              get(serverEnvironment.hostStats({ environmentId, input: {} })),
            ),
          );
        }
        return { presentations, subscriptions };
      }),
    [enabled],
  );
  const sources = useAtomValue(sourcesAtom);
  // React's "store information from previous renders" pattern: a conditional
  // set during render, which React applies before it paints.
  const [lastRead, setLastRead] = useState<HostStatsSources | null>(null);
  if (enabled && sources !== lastRead) setLastRead(sources);
  return enabled || lastRead === null ? sources : lastRead;
}
