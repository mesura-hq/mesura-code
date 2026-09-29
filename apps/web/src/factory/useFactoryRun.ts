import { useAtomValue } from "@effect/atom-react";
import type { FactoryRunStreamItem, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";

import { factoryEnvironment } from "../state/factory";

export type FactoryRunStreamState =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | { readonly status: "ready"; readonly item: FactoryRunStreamItem };

/**
 * A run's live state from the `subscribeFactoryRun` stream. The subscription
 * lives exactly as long as a component calls this, so only a visible Run tab
 * may. After a failure the last item received still renders.
 */
export function useFactoryRun(threadRef: ScopedThreadRef, runId: string): FactoryRunStreamState {
  const result = useAtomValue(
    factoryEnvironment.factoryRun({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, runId },
    }),
  );
  const item = Option.getOrNull(AsyncResult.value(result));
  if (item !== null) return { status: "ready", item };
  return AsyncResult.isFailure(result) ? { status: "failed" } : { status: "loading" };
}
