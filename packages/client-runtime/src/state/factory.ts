import { WS_METHODS, type FactoryReadSnapshotResult } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

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

export type FactorySnapshotState =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | { readonly status: "ready"; readonly markdown: string };

const LOADING_FACTORY_SNAPSHOT: FactorySnapshotState = { status: "loading" };
const FAILED_FACTORY_SNAPSHOT: FactorySnapshotState = { status: "failed" };
// A query's success object is replaced only when its value changes, so one
// state per success keeps a card's memo on it from reparsing a 90 KB plan on
// every render.
const readySnapshotBySuccess = new WeakMap<object, FactorySnapshotState>();

/**
 * What a client renders from a `factorySnapshot` query: its body, or why there
 * is none. The same success yields the same state object.
 *
 * A digest names fixed bytes, so a body loaded once stays true. When the query
 * fails later, typically because the device went offline and the connection
 * supervisor reports the environment `offline`, the failure's previous success
 * still renders instead of discarding a plan the reader already had.
 */
export function readFactorySnapshotState<E>(
  result: AsyncResult.AsyncResult<FactoryReadSnapshotResult, E>,
): FactorySnapshotState {
  const success = AsyncResult.isSuccess(result)
    ? result
    : AsyncResult.isFailure(result)
      ? Option.getOrNull(result.previousSuccess)
      : null;
  if (success === null) {
    return AsyncResult.isFailure(result) ? FAILED_FACTORY_SNAPSHOT : LOADING_FACTORY_SNAPSHOT;
  }
  let state = readySnapshotBySuccess.get(success);
  if (state === undefined) {
    state = { status: "ready", markdown: success.value.markdown };
    readySnapshotBySuccess.set(success, state);
  }
  return state;
}
