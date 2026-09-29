import {
  WS_METHODS,
  type FactoryReadSnapshotResult,
  type FactoryRunStreamItem,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import {
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * How long a run subscription outlives the last pane that read it. The plan
 * asks for the stream to end when the Run tab unmounts; a few seconds lets a
 * quick Plan-and-back switch reuse one server tail instead of restarting it,
 * and the pane unmounting still interrupts the stream shortly after.
 */
export const FACTORY_RUN_IDLE_TTL_MS = 3_000;

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
    /** A run's full state and live role progress, for a visible Run tab only. */
    factoryRun: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:factory:run",
      tag: WS_METHODS.subscribeFactoryRun,
      idleTtlMs: FACTORY_RUN_IDLE_TTL_MS,
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

export type FactoryRunStreamState =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | { readonly status: "ready"; readonly item: FactoryRunStreamItem };

const LOADING_FACTORY_RUN: FactoryRunStreamState = { status: "loading" };
const FAILED_FACTORY_RUN: FactoryRunStreamState = { status: "failed" };

/**
 * What a Run tab renders from a `factoryRun` subscription: the latest item,
 * or why there is none. After a failure the last item received still renders.
 */
export function readFactoryRunStreamState<E>(
  result: AsyncResult.AsyncResult<FactoryRunStreamItem, E>,
): FactoryRunStreamState {
  const item = Option.getOrNull(AsyncResult.value(result));
  if (item !== null) return { status: "ready", item };
  return AsyncResult.isFailure(result) ? FAILED_FACTORY_RUN : LOADING_FACTORY_RUN;
}
