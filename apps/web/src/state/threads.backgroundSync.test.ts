/**
 * Drives `createRunningThreadKeepAliveAtom` with the real thread state and detail atoms; only each
 * thread's `subscribeThread` stream is fake. Guards that a background thread kept alive is current
 * when opened (no second subscription, no snapshot reload), and that background streams neither
 * rebuild the keep-alive set nor notify the open thread.
 */
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  type ConnectionCatalogEntry,
  type NetworkStatus,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { Persistence } from "@t3tools/client-runtime/platform";
import type { RpcSession, WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadStateAtoms,
  ThreadSnapshotLoader,
  type EnvironmentThreadState,
} from "@t3tools/client-runtime/state/threads";
import {
  EnvironmentId,
  EventId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "@effect/vitest";

import { makeThreadProjectionFixture } from "../test-fixtures";
import { createRunningThreadKeepAliveAtom } from "./threads";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-background-sync"),
  label: "Background sync environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const ENVIRONMENT_ID = TARGET.environmentId;
const RUNNING_THREADS = 10;
/** Streamed updates per running thread: a turn's text growing a few words at a time. */
const UPDATES_PER_THREAD = 40;
const AT = DateTime.makeUnsafe("2026-10-19T00:00:00.000Z");

const runningThreadId = (index: number) => ThreadId.make(`thread-running-${index}`);
const OPEN_THREAD_ID = ThreadId.make("thread-open-idle");

function projectionFor(threadId: ThreadId) {
  const projection = makeThreadProjectionFixture();
  return { ...projection, thread: { ...projection.thread, id: threadId } };
}

function streamedText(threadId: ThreadId, update: number) {
  return `${threadId} streamed update ${update}`;
}

/** The assistant message of a streaming turn, as `turn-item.updated` carries it. */
function assistantMessage(threadId: ThreadId, update: number): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(`${threadId}:assistant`),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "running",
    title: null,
    startedAt: AT,
    completedAt: null,
    updatedAt: AT,
    type: "assistant_message",
    messageId: MessageId.make(`${threadId}:message`),
    text: streamedText(threadId, update),
    streaming: true,
  };
}

function streamEvent(threadId: ThreadId, update: number): OrchestrationV2ThreadStreamItem {
  return {
    kind: "event",
    sequence: 1 + update,
    event: {
      id: EventId.make(`${threadId}:event:${update}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: AT,
      payload: assistantMessage(threadId, update),
    },
  };
}

interface ThreadSubscription {
  readonly threadId: ThreadId;
  readonly events: Queue.Queue<OrchestrationV2ThreadStreamItem>;
}

/**
 * One environment whose transport answers `subscribeThread` per thread with a
 * queue, plus the keep-alive over ten running threads and one idle thread the
 * developer can have open.
 */
const makeHarness = Effect.fn("BackgroundSyncTest.makeHarness")(function* () {
  const subscriptions = yield* Queue.unbounded<ThreadSubscription>();
  const opened = new Map<string, number>();
  const snapshotLoads = new Map<string, number>();
  const count = (counts: Map<string, number>, threadId: ThreadId) =>
    counts.set(threadId, (counts.get(threadId) ?? 0) + 1);

  const client = {
    [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input: { readonly threadId: ThreadId }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
          count(opened, input.threadId);
          yield* Queue.offer(subscriptions, { threadId: input.threadId, events });
          return Stream.fromQueue(events);
        }),
      ),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.succeed({ threadResumeCompletionMarker: true } as never),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
      Option.some({
        environmentId: ENVIRONMENT_ID,
        label: TARGET.label,
        httpBaseUrl: TARGET.httpBaseUrl,
        socketUrl: TARGET.wsBaseUrl,
        httpAuthorization: null,
        target: TARGET,
      }),
    ),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const unexpected = (what: string) => () => Effect.die(`Unexpected ${what}`);
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map(),
    ),
    networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
    start: Effect.void,
    register: unexpected("environment registration"),
    registerPlatform: unexpected("environment registration"),
    reconcilePlatform: unexpected("environment reconciliation"),
    remove: unexpected("environment removal"),
    removeRoute: unexpected("route removal"),
    reorderRoutes: unexpected("route reorder"),
    removeRelayEnvironments: unexpected("environment removal"),
    retryNow: () => Effect.void,
    setEnabled: unexpected("environment toggle"),
    setCompatibility: unexpected("compatibility update"),
    state: () => SubscriptionRef.get(supervisor.state),
    stateChanges: () => SubscriptionRef.changes(supervisor.state),
    run: (_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    runStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  });
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
      Layer.succeed(
        Persistence.EnvironmentCacheStore,
        Persistence.EnvironmentCacheStore.of({
          loadShell: () => Effect.succeedNone,
          saveShell: () => Effect.void,
          loadThread: () => Effect.succeedNone,
          saveThread: () => Effect.void,
          removeThread: () => Effect.void,
          loadServerConfig: () => Effect.succeedNone,
          saveServerConfig: () => Effect.void,
          loadVcsRefs: () => Effect.succeedNone,
          saveVcsRefs: () => Effect.void,
          removeVcsRefs: () => Effect.void,
          clearVcsRefs: () => Effect.void,
          clear: () => Effect.void,
        }),
      ),
      Layer.succeed(
        ThreadSnapshotLoader,
        ThreadSnapshotLoader.of({
          load: (_prepared, threadId) =>
            Effect.sync(() => {
              count(snapshotLoads, threadId);
              return {
                _tag: "present" as const,
                snapshot: { snapshotSequence: 1, projection: projectionFor(threadId) },
              };
            }),
        }),
      ),
    ),
  );

  const threadStates = createEnvironmentThreadStateAtoms(runtime);
  const details = createEnvironmentThreadDetailAtoms(threadStates.stateAtom);
  const shells = Atom.make<ReadonlyArray<Pick<OrchestrationV2ThreadShell, "id" | "status">>>([
    ...Array.from({ length: RUNNING_THREADS }, (_, index) => ({
      id: runningThreadId(index),
      status: "running" as const,
    })),
    { id: OPEN_THREAD_ID, status: "idle" as const },
  ]).pipe(Atom.keepAlive);
  const keepAlive = createRunningThreadKeepAliveAtom({
    environmentIdsAtom: Atom.make<ReadonlyArray<EnvironmentId>>([ENVIRONMENT_ID]).pipe(
      Atom.keepAlive,
    ),
    threadsAtom: () => shells,
    stateAtom: threadStates.stateAtom,
  });
  const registry = yield* Effect.acquireRelease(
    Effect.sync(() => AtomRegistry.make({ defaultIdleTTL: 60_000, timeoutResolution: 1 })),
    (value) => Effect.sync(() => value.dispose()),
  );

  /** Takes the next `n` subscriptions the client opens, keyed by thread. */
  const takeSubscriptions = (n: number) =>
    Effect.gen(function* () {
      const taken = new Map<string, ThreadSubscription>();
      for (let index = 0; index < n; index++) {
        const subscription = yield* Queue.take(subscriptions);
        taken.set(subscription.threadId, subscription);
      }
      return taken;
    });

  /**
   * Resolves once the raw state of `threadId` shows `update`, from a listener on
   * the raw atom the keep-alive already holds mounted — not from a thread view.
   */
  const awaitFolded = (threadId: ThreadId, update: number) =>
    Effect.gen(function* () {
      const folded = yield* Deferred.make<void>();
      const atom = threadStates.stateAtom(ENVIRONMENT_ID, threadId);
      const shows = (result: AsyncResult.AsyncResult<EnvironmentThreadState, unknown>) =>
        Option.exists(
          Option.flatMap(AsyncResult.value(result), (state) => state.data),
          (projection) =>
            projection.turnItems.some(
              (item) =>
                item.type === "assistant_message" && item.text === streamedText(threadId, update),
            ),
        );
      const unsubscribe = registry.subscribe(
        atom,
        (result) => {
          if (shows(result)) Deferred.doneUnsafe(folded, Effect.void);
        },
        { immediate: true },
      );
      yield* Deferred.await(folded).pipe(Effect.ensuring(Effect.sync(unsubscribe)));
    });

  return {
    registry,
    keepAlive,
    details,
    takeSubscriptions,
    awaitFolded,
    opened: (threadId: ThreadId) => opened.get(threadId) ?? 0,
    snapshotLoads: (threadId: ThreadId) => snapshotLoads.get(threadId) ?? 0,
  };
});

/** Interleaves every thread's updates, as ten providers streaming at once would arrive. */
const streamAllThreads = (subscriptions: ReadonlyMap<string, ThreadSubscription>) =>
  Effect.gen(function* () {
    for (const subscription of subscriptions.values()) {
      yield* Queue.offer(subscription.events, { kind: "synchronized" });
    }
    for (let update = 1; update <= UPDATES_PER_THREAD; update++) {
      for (const subscription of subscriptions.values()) {
        yield* Queue.offer(subscription.events, streamEvent(subscription.threadId, update));
      }
    }
  });

describe("desktop background thread sync (phase 6 guards)", () => {
  it.effect(
    "shows a background-synced running thread's latest streamed text the moment it is opened",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness();
          h.registry.mount(h.keepAlive);
          const subscriptions = yield* h.takeSubscriptions(RUNNING_THREADS);
          expect([...subscriptions.keys()].toSorted()).toEqual(
            Array.from({ length: RUNNING_THREADS }, (_, index) =>
              runningThreadId(index),
            ).toSorted(),
          );

          yield* streamAllThreads(subscriptions);
          for (const threadId of subscriptions.keys()) {
            yield* h.awaitFolded(ThreadId.make(threadId), UPDATES_PER_THREAD);
          }

          // The developer switches to one of the running threads.
          const switchedTo = runningThreadId(7);
          const ref = { environmentId: ENVIRONMENT_ID, threadId: switchedTo };
          const unmountView = h.registry.mount(h.details.stateAtom(ref));
          const firstRead = h.registry.get(h.details.stateAtom(ref));
          expect(firstRead.status).toBe("live");
          expect(
            Option.getOrThrow(firstRead.data).turnItems.map((item) =>
              item.type === "assistant_message" ? item.text : item.type,
            ),
          ).toEqual([streamedText(switchedTo, UPDATES_PER_THREAD)]);
          // Opening the thread reuses the background stream: no new subscription,
          // no snapshot reload, no replay.
          expect(h.opened(switchedTo)).toBe(1);
          expect(h.snapshotLoads(switchedTo)).toBe(1);
          unmountView();
        }),
      ),
  );

  it.effect(
    "keeps ten background streams from rebuilding the keep-alive set or notifying the open thread",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness();
          h.registry.mount(h.keepAlive);
          const subscriptions = yield* h.takeSubscriptions(RUNNING_THREADS);

          // The developer has another thread open (its view mounts its own stream).
          const openRef = { environmentId: ENVIRONMENT_ID, threadId: OPEN_THREAD_ID };
          const viewNotifications: Array<EnvironmentThreadState> = [];
          const openLive = yield* Deferred.make<void>();
          const unmountView = h.registry.subscribe(
            h.details.stateAtom(openRef),
            (value) => {
              viewNotifications.push(value);
              if (value.status === "live") Deferred.doneUnsafe(openLive, Effect.void);
            },
            { immediate: true },
          );
          const openSubscription = (yield* h.takeSubscriptions(1)).get(OPEN_THREAD_ID)!;
          yield* Queue.offer(openSubscription.events, { kind: "synchronized" });
          yield* Deferred.await(openLive);
          const keptBefore = h.registry.get(h.keepAlive);
          const notificationsBefore = viewNotifications.length;

          yield* streamAllThreads(subscriptions);
          for (const threadId of subscriptions.keys()) {
            yield* h.awaitFolded(ThreadId.make(threadId), UPDATES_PER_THREAD);
          }

          expect(h.registry.get(h.keepAlive)).toBe(keptBefore);
          expect(viewNotifications.length - notificationsBefore).toBe(0);
          unmountView();
        }),
      ),
  );
});
