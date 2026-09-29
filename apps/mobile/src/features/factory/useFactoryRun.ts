import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  readFactoryRunStreamState,
  type FactoryRunStreamState,
} from "@t3tools/client-runtime/state/factory";

import { factoryEnvironment } from "../../state/factory";

/**
 * A run's live state from the `subscribeFactoryRun` stream. The subscription
 * lives exactly as long as a component calls this, so only a focused Run or
 * Report tab may. After a failure the last item received still renders.
 */
export function useFactoryRun(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  runId: string,
): FactoryRunStreamState {
  return readFactoryRunStreamState(
    useAtomValue(factoryEnvironment.factoryRun({ environmentId, input: { threadId, runId } })),
  );
}
