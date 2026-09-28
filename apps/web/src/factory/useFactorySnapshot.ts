import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { factoryEnvironment } from "../state/factory";

export type FactorySnapshotState =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | { readonly status: "ready"; readonly markdown: string };

/** A stored plan body by digest; the answer never changes, so it stays cached. */
export function useFactorySnapshot(
  environmentId: EnvironmentId,
  digest: string,
): FactorySnapshotState {
  const result = useAtomValue(
    factoryEnvironment.factorySnapshot({ environmentId, input: { digest } }),
  );
  if (result._tag === "Success") return { status: "ready", markdown: result.value.markdown };
  if (result._tag === "Failure") return { status: "failed" };
  return { status: "loading" };
}
