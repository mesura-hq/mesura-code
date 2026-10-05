/**
 * Phase 2, criterion 4: a client-runtime subscription atom exposes the
 * environment's dictation jobs, newest first. Entry point: the `jobs` atom
 * family from `createDictationEnvironmentAtoms`, fed by a fake
 * `subscribeDictationJobs` stream, plus the reducer that shapes its value.
 */
import {
  DictationJobId,
  EnvironmentId,
  WS_METHODS,
  type DictationJob,
  type DictationJobEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
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
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createDictationEnvironmentAtoms, reduceDictationJobs } from "./jobs.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("dictation-environment"),
  label: "Dictation environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

function job(id: string, createdAt: string, overrides: Partial<DictationJob> = {}): DictationJob {
  return {
    id: DictationJobId.make(id),
    target: null,
    mode: "clipboard",
    status: "transcribing",
    durationMs: 1_000,
    createdAt,
    ...overrides,
  } as DictationJob;
}

const OLDEST = job("job-oldest", "2026-10-03T08:00:00.000Z");
const MIDDLE = job("job-middle", "2026-10-03T09:00:00.000Z");
const NEWEST = job("job-newest", "2026-10-03T10:00:00.000Z");

const ids = (jobs: ReadonlyArray<DictationJob>) => jobs.map((entry) => entry.id);

describe("dictation jobs reducer", () => {
  it("dictation jobs reducer: a snapshot replaces the whole list", () => {
    const previous = [OLDEST, MIDDLE];
    const next = reduceDictationJobs(previous, { type: "snapshot", jobs: [NEWEST] });
    expect(ids(next)).toEqual(["job-newest"]);
  });

  it("dictation jobs reducer: a snapshot arrives ordered newest first whatever the server order", () => {
    const next = reduceDictationJobs([], { type: "snapshot", jobs: [OLDEST, NEWEST, MIDDLE] });
    expect(ids(next)).toEqual(["job-newest", "job-middle", "job-oldest"]);
  });

  it("dictation jobs reducer: an upsert of a known job updates it in place", () => {
    const previous = reduceDictationJobs([], {
      type: "snapshot",
      jobs: [NEWEST, MIDDLE, OLDEST],
    });
    const completed = { ...MIDDLE, status: "completed", text: "hello" } as DictationJob;
    const next = reduceDictationJobs(previous, { type: "upsert", job: completed });
    expect(ids(next)).toEqual(["job-newest", "job-middle", "job-oldest"]);
    expect(next[1]).toEqual(completed);
  });

  it("dictation jobs reducer: an upsert of an unknown job is inserted newest first", () => {
    const previous = reduceDictationJobs([], { type: "snapshot", jobs: [MIDDLE, OLDEST] });
    const next = reduceDictationJobs(previous, { type: "upsert", job: NEWEST });
    expect(ids(next)).toEqual(["job-newest", "job-middle", "job-oldest"]);
  });
});

const makeHarness = Effect.fn("DictationJobsTest.makeHarness")(function* () {
  const events = yield* Queue.unbounded<DictationJobEvent>();
  const client = {
    [WS_METHODS.subscribeDictationJobs]: () => Stream.fromQueue(events),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: () => Stream.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected",
    }),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const environments = EnvironmentRegistry.of({
    run: (_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor, supervisor),
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry, environments));
  const atoms = createDictationEnvironmentAtoms(runtime);
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  return { events, registry, jobs: atoms.jobs({ environmentId: TARGET.environmentId, input: {} }) };
});

function waitForJobIds(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<DictationJob>, unknown>>,
  expected: ReadonlyArray<string>,
) {
  return AtomRegistry.toStream(registry, atom).pipe(
    Stream.filter(
      (result) =>
        AsyncResult.isSuccess(result) &&
        JSON.stringify(ids(result.value)) === JSON.stringify(expected),
    ),
    Stream.runHead,
  );
}

it.effect(
  "dictation jobs atom: exposes the subscription as a list of jobs, newest first, folding upserts",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const unmount = harness.registry.mount(harness.jobs);

        yield* Queue.offer(harness.events, { type: "snapshot", jobs: [OLDEST, MIDDLE] });
        yield* waitForJobIds(harness.registry, harness.jobs, ["job-middle", "job-oldest"]);

        yield* Queue.offer(harness.events, { type: "upsert", job: NEWEST });
        yield* waitForJobIds(harness.registry, harness.jobs, [
          "job-newest",
          "job-middle",
          "job-oldest",
        ]);

        yield* Queue.offer(harness.events, { type: "snapshot", jobs: [MIDDLE] });
        yield* waitForJobIds(harness.registry, harness.jobs, ["job-middle"]);
        unmount();
      }),
    ),
);
