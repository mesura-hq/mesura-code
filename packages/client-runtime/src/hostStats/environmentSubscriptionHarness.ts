/**
 * Test harness: mounts one environment subscription atom from
 * `createEnvironmentSubscriptionAtomFamily`, the factory `state/server.ts`
 * builds `hostStats` with, over a queue the test offers messages to. The
 * connection is always connected; the harness proves what the atom hands a
 * listener, not how the connection behaves.
 */
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type * as RpcSession from "../rpc/session.ts";
import { createEnvironmentSubscriptionAtomFamily } from "../state/runtime.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-subscription-harness"),
  label: "Harness environment",
  httpBaseUrl: "https://harness.example.test",
  wsBaseUrl: "wss://harness.example.test",
});

const makeConnectedSupervisor = Effect.gen(function* () {
  return EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      network: "online",
      phase: "connected",
      attempt: 1,
      generation: 1,
    }),
    session: yield* SubscriptionRef.make(Option.some({} as RpcSession.RpcSession)),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
});

/** Lets the atom runtime drain what was offered before the test reads. */
const settle = () => Effect.runPromise(Effect.sleep("1 millis"));

export interface MountedEnvironmentSubscription<M, A> {
  /** Offers the messages as one burst, in one chunk, then lets the atom settle. */
  readonly offerBurst: (messages: ReadonlyArray<M>) => Promise<void>;
  /** Every value the mounted listener saw, in order. */
  readonly seen: ReadonlyArray<A>;
  /** The atom's current value. */
  readonly current: () => A | null;
  /** The atom's whole result, failure included. */
  readonly result: () => AsyncResult.AsyncResult<A, unknown>;
  readonly dispose: () => void;
}

export async function mountEnvironmentSubscription<M, A>(
  transform: (messages: Stream.Stream<M>) => Stream.Stream<A>,
): Promise<MountedEnvironmentSubscription<M, A>> {
  const messages = await Effect.runPromise(Queue.unbounded<M>());
  const supervisor = await Effect.runPromise(makeConnectedSupervisor);
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    followStream: <B, E, R>(_environmentId: EnvironmentId, stream: Stream.Stream<B, E, R>) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
  );
  const family = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "test.environment-subscription-harness",
    subscribe: () => transform(Stream.fromQueue(messages)),
  });
  const atom = family({ environmentId: TARGET.environmentId, input: {} });
  const registry = AtomRegistry.make();
  const seen: A[] = [];
  registry.subscribe(
    atom,
    (result) => {
      const value = AsyncResult.value(result);
      if (Option.isSome(value)) seen.push(value.value);
    },
    { immediate: true },
  );
  return {
    offerBurst: async (burst) => {
      await Effect.runPromise(Queue.offerAll(messages, burst));
      await settle();
    },
    seen,
    current: () => Option.getOrNull(AsyncResult.value(registry.get(atom))),
    result: () => registry.get(atom),
    dispose: () => registry.dispose(),
  };
}
