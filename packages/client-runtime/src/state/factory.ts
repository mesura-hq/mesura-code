import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/** A day: a digest names fixed bytes, so its answer never goes stale. */
const FACTORY_SNAPSHOT_CACHE_MS = 86_400_000;

export function createFactoryEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** A stored plan or report body, read on demand by its sha256 digest. */
    factorySnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:factory:snapshot",
      tag: WS_METHODS.factoryReadSnapshot,
      staleTimeMs: FACTORY_SNAPSHOT_CACHE_MS,
      idleTtlMs: 300_000,
    }),
  };
}
