import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  readFactorySnapshotState,
  type FactorySnapshotState,
} from "@t3tools/client-runtime/state/factory";

import { factoryEnvironment } from "../state/factory";

/** A stored plan body by digest; the answer never changes, so it stays cached. */
export function useFactorySnapshot(
  environmentId: EnvironmentId,
  digest: string,
): FactorySnapshotState {
  return readFactorySnapshotState(
    useAtomValue(factoryEnvironment.factorySnapshot({ environmentId, input: { digest } })),
  );
}
