/**
 * Phase 3 fence of phone push notifications: acceptance criteria 1 to 6.
 *
 * Entry point: `PushDispatcher.layer` and its `start()`, which `server.ts`
 * runs as a parked fiber. It is built over the real orchestrator stack:
 * `ProviderReplayHarness` (orchestrator, event sink, projections), the real
 * `ThreadManagementService`, in-memory SQLite with upstream's migrations and
 * `MESURA_SCHEMA_STATEMENTS`, and the real `PushSubscriptions`. Domain events
 * are committed through `EventSinkV2.write`, the path every orchestrator
 * decision takes, so the dispatcher reads them from the live
 * `streamDomainEvents` tail and the thread shells from the projections.
 * Only the edges are fakes: `PushSender` records each send instead of
 * reaching a push service, and `ProjectService` and `ServerEnvironment` answer
 * with one project title and one environment id, as in upstream's relay test.
 *
 * What the specs rely on, from the plan:
 * - `PushDispatcher` has `start(): Effect<void, never, Scope>` and
 *   `drain: Effect<void>`, like `AgentAwarenessRelay`.
 * - `start()` returns after the startup keys are recorded and the dispatcher
 *   is subscribed to the domain events, so an event committed after it
 *   returns is never missed.
 * - Project titles come from `ProjectService.getById` and the environment id
 *   from `ServerEnvironment.getEnvironmentId`, as the relay reads them.
 *
 * No sleeps: `flushSends` commits an approval on a fresh barrier thread, waits
 * for the barrier device to receive it, then drains the dispatcher. Events
 * reach the dispatcher in commit order, so every send caused by an earlier
 * event is recorded by then.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_PUSH_PREFERENCES,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type PushNotificationPayload,
  type PushPreferences,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { type AgentAwarenessPhase, projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PushDispatcher from "./PushDispatcher.ts";
import { buildPushPayload } from "./pushPayload.ts";
import * as PushSender from "./PushSender.ts";
import * as PushSubscriptions from "./PushSubscriptions.ts";
import * as VapidKeys from "./vapidKeys.ts";

const ENVIRONMENT_ID = EnvironmentId.make("vigilia-home");
const PROJECT_ID = ProjectId.make("push-project");
const PROJECT_TITLE = "Mesura Code";
const NOW = DateTime.makeUnsafe("2026-10-26T09:00:00.000Z");
const MESSAGE_TEXT = "SECRET: the agent's own words must never leave the host";

const FCM = "https://fcm.googleapis.com/fcm/send";
const ALL_ON: PushPreferences = { approval: true, input: true, failed: true, completed: true };
const DEFAULTS: PushPreferences = {
  approval: true,
  input: true,
  failed: true,
  completed: false,
};
const NONE: PushPreferences = { approval: false, input: false, failed: false, completed: false };

/** The device `flushSends` waits on; its sends are left out of every result. */
const BARRIER_ENDPOINT = `${FCM}/barrier`;
const PHONE = `${FCM}/phone`;
const TABLET = `${FCM}/tablet`;
const QUIET = `${FCM}/quiet`;
const BROKEN = `${FCM}/broken`;

interface RecordedSend {
  readonly endpoint: string;
  readonly payload: PushNotificationPayload;
}

const unused = () => Effect.die("unused in the push dispatcher fence");

const project = {
  id: PROJECT_ID,
  title: PROJECT_TITLE,
  workspaceRoot: "/workspace/mesura-code",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const layerProjectService = Layer.succeed(
  ProjectService.ProjectService,
  ProjectService.ProjectService.of({
    create: unused,
    bootstrap: unused,
    update: unused,
    delete: unused,
    getByWorkspaceRoot: unused,
    snapshot: Effect.succeed({ projects: [project] } as never),
    listPage: unused,
    getShell: unused,
    listShells: unused,
    commitIconDiscovery: unused,
    getById: (projectId) =>
      Effect.succeed(projectId === PROJECT_ID ? Option.some(project as never) : Option.none()),
  } as ProjectService.ProjectService["Service"]),
);

const layerServerEnvironment = Layer.succeed(ServerEnvironment.ServerEnvironment, {
  getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
  getDescriptor: unused(),
} as ServerEnvironment.ServerEnvironment["Service"]);

const decodeAppThread = Schema.decodeUnknownSync(OrchestrationV2AppThread);

const appThread = (
  threadId: ThreadId,
  title: string,
  overrides: Record<string, unknown> = {},
): OrchestrationV2AppThread =>
  decodeAppThread({
    id: threadId,
    projectId: PROJECT_ID,
    title,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  });

const makeHarness = Effect.fnUntraced(function* () {
  const sends = yield* Queue.unbounded<RecordedSend>();
  const fakeSender = Layer.succeed(
    PushSender.PushSender,
    PushSender.PushSender.of({
      send: (target, payload) =>
        target.endpoint === BROKEN
          ? Effect.fail(new PushSender.PushSendError({ detail: "The push service answered 500" }))
          : Queue.offer(sends, { endpoint: target.endpoint, payload }).pipe(
              Effect.as({ _tag: "delivered" } as const),
            ),
    }),
  );
  const runtime = ProviderReplayHarness.layerWithRegistry(
    { name: "push-dispatcher" },
    ProviderAdapterRegistry.layerFromAdapters([]),
    { runEffectWorker: false },
  );
  const base = yield* Layer.build(
    Layer.mergeAll(
      runtime,
      ThreadManagementService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(runtime, CommandReceiptStore.layer, ServerSettings.layerTest({})),
        ),
      ),
      PushSubscriptions.layer.pipe(
        Layer.provideMerge(fakeSender),
        Layer.provideMerge(VapidKeys.layer),
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "push-dispatcher-" })),
      ),
      layerProjectService,
      layerServerEnvironment,
    ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory), Layer.provide(NodeServices.layer)),
  );
  const sink = Context.get(base, EventSinkV2);
  const threads = Context.get(base, ThreadManagementService.ThreadManagementService);
  const subscriptions = Context.get(base, PushSubscriptions.PushSubscriptions);
  const sql = Context.get(base, SqlClient.SqlClient);

  let eventSequence = 0;
  let barrierSequence = 0;
  const runs = new Map<ThreadId, OrchestrationV2Run>();
  const created = new Map<ThreadId, OrchestrationV2AppThread>();
  const live: {
    dispatcher: PushDispatcher.PushDispatcher["Service"] | null;
    scope: Scope.Closeable | null;
  } = { dispatcher: null, scope: null };

  const write = (event: Omit<OrchestrationV2DomainEvent, "id" | "occurredAt">) =>
    sink.write({
      events: [
        {
          ...event,
          id: EventId.make(`push-dispatcher-event-${eventSequence++}`),
          occurredAt: NOW,
        } as OrchestrationV2DomainEvent,
      ],
    });

  const subscribe = (endpoint: string, preferences: PushPreferences) =>
    subscriptions.subscribe({
      endpoint,
      keys: { p256dh: `p256dh-${endpoint}`, auth: `auth-${endpoint}` },
      label: endpoint.slice(FCM.length + 1),
      preferences,
    });

  const createThread = (threadId: ThreadId, title: string, overrides?: Record<string, unknown>) => {
    const thread = appThread(threadId, title, overrides);
    created.set(threadId, thread);
    return write({ type: "thread.created", threadId, payload: thread } as never);
  };

  const startRun = (threadId: ThreadId) => {
    const run: OrchestrationV2Run = {
      id: RunId.make(`run:${threadId}`),
      threadId,
      ordinal: 1,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${threadId}`),
      rootNodeId: NodeId.make(`node:${threadId}`),
      activeAttemptId: null,
      status: "running",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    runs.set(threadId, run);
    return write({ type: "run.created", threadId, runId: run.id, payload: run } as never);
  };

  const finishRun = (threadId: ThreadId, status: "completed" | "failed") => {
    const run = runs.get(threadId)!;
    return write({
      type: "run.updated",
      threadId,
      runId: run.id,
      payload: { ...run, status, completedAt: NOW },
    } as never);
  };

  const runtimeRequest = (
    threadId: ThreadId,
    requestId: string,
    kind: OrchestrationV2RuntimeRequest["kind"],
    status: OrchestrationV2RuntimeRequest["status"],
    createdAt: DateTime.Utc = NOW,
  ) => {
    const run = runs.get(threadId)!;
    const request: OrchestrationV2RuntimeRequest = {
      id: RuntimeRequestId.make(requestId),
      nodeId: run.rootNodeId!,
      providerTurnId: null,
      nativeRequestRef: null,
      kind,
      status,
      // A live provider session makes the request blocking, as a real approval is.
      responseCapability: { type: "live", providerSessionId: ProviderSessionId.make("session") },
      createdAt,
      resolvedAt: status === "pending" ? null : NOW,
    };
    return write({
      type: "runtime-request.updated",
      threadId,
      runId: run.id,
      payload: request,
    } as never);
  };

  /** The newest pending request is the thread's current one; `createdAt` orders them. */
  const requestApproval = (threadId: ThreadId, requestId: string, createdAt?: DateTime.Utc) =>
    runtimeRequest(threadId, requestId, "command", "pending", createdAt);
  const requestInput = (threadId: ThreadId, requestId: string) =>
    runtimeRequest(threadId, requestId, "user_input", "pending");
  const resolveRequest = (
    threadId: ThreadId,
    requestId: string,
    kind: OrchestrationV2RuntimeRequest["kind"] = "command",
  ) => runtimeRequest(threadId, requestId, kind, "resolved");

  /**
   * A secret or link card: a turn item the shell reads as pending input while
   * it is `waiting`, with no runtime request behind it.
   */
  const inputCard = (
    threadId: ThreadId,
    itemId: string,
    type: "secret_request" | "link_request",
    open: boolean,
  ) => {
    const run = runs.get(threadId)!;
    const card =
      type === "secret_request"
        ? {
            type,
            label: "OPENAI_API_KEY",
            reason: "The agent needs a key",
            secretStatus: open ? "pending" : "saved",
          }
        : { type, reason: "Link the laptop", linkStatus: open ? "pending" : "linked" };
    return write({
      type: "turn-item.updated",
      threadId,
      runId: run.id,
      payload: {
        id: TurnItemId.make(itemId),
        threadId,
        runId: run.id,
        nodeId: run.rootNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: open ? "waiting" : "completed",
        title: null,
        startedAt: NOW,
        completedAt: open ? null : NOW,
        updatedAt: NOW,
        ...card,
      },
    } as never);
  };

  const shellOf = (threadId: ThreadId) => threads.getThreadShell(threadId);

  /** A change the awareness filter passes that leaves the phase as it was. */
  const touch = (threadId: ThreadId, title: string) => {
    const thread = { ...created.get(threadId)!, title, updatedAt: NOW };
    created.set(threadId, thread);
    return write({ type: "thread.metadata-updated", threadId, payload: thread } as never);
  };

  const archive = (threadId: ThreadId) =>
    write({
      type: "thread.archived",
      threadId,
      payload: { ...created.get(threadId)!, archivedAt: NOW },
    } as never);

  const assistantMessage = (threadId: ThreadId) =>
    write({
      type: "message.updated",
      threadId,
      runId: runs.get(threadId)!.id,
      payload: {
        createdBy: "agent",
        creationSource: "web",
        id: MessageId.make(`assistant:${threadId}`),
        threadId,
        runId: runs.get(threadId)!.id,
        nodeId: null,
        role: "assistant",
        text: MESSAGE_TEXT,
        attachments: [],
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    } as never);

  /** Fixture check, independent of the dispatcher: the thread reads as `phase`. */
  const expectPhase = (threadId: ThreadId, phase: AgentAwarenessPhase | null) =>
    Effect.gen(function* () {
      const shell = yield* threads.getThreadShell(threadId);
      assert.isNotNull(shell, `thread ${threadId} has a shell`);
      const awareness = projectThreadAwarenessV2({
        environmentId: ENVIRONMENT_ID,
        project,
        thread: shell!,
      });
      assert.strictEqual(awareness?.phase ?? null, phase, `thread ${threadId} reads as ${phase}`);
      return awareness;
    });

  /** One server lifetime: build the dispatcher in its own scope and start it. */
  const startServer = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const dispatcher = yield* Effect.gen(function* () {
      const context = yield* Layer.build(
        PushDispatcher.layer.pipe(Layer.provide(Layer.succeedContext(base))),
      );
      const service = Context.get(context, PushDispatcher.PushDispatcher);
      yield* service.start();
      return service;
    }).pipe(Scope.provide(scope));
    live.dispatcher = dispatcher;
    live.scope = scope;
  });

  const stopServer = Effect.suspend(() => {
    const scope = live.scope;
    live.dispatcher = null;
    live.scope = null;
    return scope === null ? Effect.void : Scope.close(scope, Exit.void);
  });

  const restartServer = stopServer.pipe(Effect.andThen(startServer));

  /**
   * Every send since the last flush, barrier traffic left out. The barrier is
   * an approval on a fresh thread; once the barrier device has it, every
   * earlier event has reached the dispatcher, and `drain` finishes its sends.
   */
  const flushSends = Effect.gen(function* () {
    const dispatcher = live.dispatcher;
    assert.isNotNull(dispatcher, "a dispatcher is running");
    const barrierThreadId = ThreadId.make(`barrier-${barrierSequence++}`);
    yield* createThread(barrierThreadId, "Barrier");
    yield* startRun(barrierThreadId);
    yield* requestApproval(barrierThreadId, `request:${barrierThreadId}`);
    const isBarrier = (send: RecordedSend) =>
      send.endpoint === BARRIER_ENDPOINT || JSON.stringify(send.payload).includes(barrierThreadId);
    const taken: Array<RecordedSend> = [];
    while (
      !taken.some(
        (send) =>
          send.endpoint === BARRIER_ENDPOINT &&
          JSON.stringify(send.payload).includes(barrierThreadId),
      )
    ) {
      taken.push(yield* Queue.take(sends));
    }
    yield* dispatcher!.drain;
    taken.push(...(yield* Queue.clear(sends)));
    return taken.filter((send) => !isBarrier(send));
  });

  const dispatchRows = sql<{ readonly thread_id: string }>`
    SELECT thread_id FROM mesura_push_announced ORDER BY thread_id
  `;

  yield* subscribe(BARRIER_ENDPOINT, { ...NONE, approval: true });
  yield* Effect.addFinalizer(() => stopServer);

  return {
    subscribe,
    createThread,
    startRun,
    finishRun,
    requestApproval,
    requestInput,
    resolveRequest,
    touch,
    archive,
    assistantMessage,
    expectPhase,
    inputCard,
    shellOf,
    startServer,
    restartServer,
    flushSends,
    dispatchRows,
  };
});

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

const endpointsOf = (sent: ReadonlyArray<RecordedSend>) =>
  sent.map((send) => send.endpoint).toSorted();

/** Every send is for `threadId`, checked through the tag the payload spec pins. */
const assertAllFor = (sent: ReadonlyArray<RecordedSend>, threadId: ThreadId) => {
  for (const send of sent) {
    assert.strictEqual(send.payload.tag, `thread:${ENVIRONMENT_ID}:${threadId}`);
  }
};

const withHarness = <E>(body: (harness: Harness) => Effect.Effect<void, E>) =>
  Effect.scoped(Effect.flatMap(makeHarness(), body));

it.effect(
  "push phase 3 AC1: approval, input and failure each push once to every device that wants that kind",
  () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* h.subscribe(PHONE, DEFAULTS);
        yield* h.subscribe(TABLET, { ...NONE, approval: true, completed: true });
        yield* h.subscribe(QUIET, NONE);
        yield* h.startServer;

        const approval = ThreadId.make("ac1-approval");
        yield* h.createThread(approval, "Needs approval");
        yield* h.startRun(approval);
        yield* h.requestApproval(approval, "request:ac1-approval");
        yield* h.expectPhase(approval, "waiting_for_approval");
        const approvalSends = yield* h.flushSends;
        assert.deepStrictEqual(endpointsOf(approvalSends), [PHONE, TABLET].toSorted());
        assertAllFor(approvalSends, approval);

        const input = ThreadId.make("ac1-input");
        yield* h.createThread(input, "Asks a question");
        yield* h.startRun(input);
        yield* h.requestInput(input, "request:ac1-input");
        yield* h.expectPhase(input, "waiting_for_input");
        const inputSends = yield* h.flushSends;
        assert.deepStrictEqual(endpointsOf(inputSends), [PHONE]);
        assertAllFor(inputSends, input);

        const failed = ThreadId.make("ac1-failed");
        yield* h.createThread(failed, "Breaks");
        yield* h.startRun(failed);
        yield* h.expectPhase(failed, "running");
        assert.deepStrictEqual(yield* h.flushSends, [], "a running thread sends nothing");
        yield* h.finishRun(failed, "failed");
        yield* h.expectPhase(failed, "failed");
        const failedSends = yield* h.flushSends;
        assert.deepStrictEqual(endpointsOf(failedSends), [PHONE]);
        assertAllFor(failedSends, failed);
      }),
    ),
);

it.effect(
  "push phase 3 AC1: one device whose push fails does not keep the others from theirs",
  () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* h.subscribe(BROKEN, DEFAULTS);
        yield* h.subscribe(PHONE, DEFAULTS);
        yield* h.subscribe(TABLET, DEFAULTS);
        yield* h.startServer;

        const threadId = ThreadId.make("ac1-broken");
        yield* h.createThread(threadId, "Needs approval");
        yield* h.startRun(threadId);
        yield* h.requestApproval(threadId, "request:ac1-broken");
        const sent = yield* h.flushSends;
        assert.deepStrictEqual(endpointsOf(sent), [PHONE, TABLET].toSorted());

        // The dispatcher keeps working after the failure.
        const next = ThreadId.make("ac1-after-broken");
        yield* h.createThread(next, "Fails later");
        yield* h.startRun(next);
        yield* h.finishRun(next, "failed");
        assert.deepStrictEqual(endpointsOf(yield* h.flushSends), [PHONE, TABLET].toSorted());
      }),
    ),
);

it.effect(
  "push phase 3 AC2: a completed thread pushes only to devices with the completion preference on",
  () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* h.subscribe(PHONE, DEFAULTS);
        yield* h.subscribe(TABLET, { ...NONE, completed: true });
        yield* h.startServer;

        const threadId = ThreadId.make("ac2-completed");
        yield* h.createThread(threadId, "Finishes");
        yield* h.startRun(threadId);
        yield* h.finishRun(threadId, "completed");
        yield* h.expectPhase(threadId, "completed");
        const sent = yield* h.flushSends;
        assert.deepStrictEqual(endpointsOf(sent), [TABLET]);
        assertAllFor(sent, threadId);
      }),
    ),
);

it.effect(
  "push phase 3 AC2: a device subscribed with the default preferences gets no completion push",
  () =>
    withHarness((h) =>
      Effect.gen(function* () {
        assert.isFalse(DEFAULT_PUSH_PREFERENCES.completed, "completion is off by default");
        yield* h.subscribe(PHONE, DEFAULT_PUSH_PREFERENCES);
        yield* h.startServer;

        const threadId = ThreadId.make("ac2-default");
        yield* h.createThread(threadId, "Finishes");
        yield* h.startRun(threadId);
        yield* h.finishRun(threadId, "completed");
        yield* h.expectPhase(threadId, "completed");
        assert.deepStrictEqual(yield* h.flushSends, []);
      }),
    ),
);

it.effect(
  "push phase 3 AC3: the same pending request pushes once, across later events and a restart",
  () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* h.subscribe(PHONE, DEFAULTS);
        yield* h.startServer;

        const threadId = ThreadId.make("ac3-request");
        yield* h.createThread(threadId, "Needs approval");
        yield* h.startRun(threadId);
        yield* h.requestApproval(threadId, "request:ac3-first");
        assert.deepStrictEqual(endpointsOf(yield* h.flushSends), [PHONE]);
        assert.include(
          (yield* h.dispatchRows).map((row) => row.thread_id),
          threadId,
          "the send key is kept in mesura_push_announced",
        );

        // Later events on the thread, and the same request committed again.
        yield* h.touch(threadId, "Needs approval, renamed");
        yield* h.requestApproval(threadId, "request:ac3-first");
        yield* h.expectPhase(threadId, "waiting_for_approval");
        assert.deepStrictEqual(yield* h.flushSends, [], "no second push for the same request");

        yield* h.restartServer;
        yield* h.touch(threadId, "Needs approval, after the restart");
        assert.deepStrictEqual(yield* h.flushSends, [], "no push for it after a restart");

        // A new request on the same thread is a new reason to push.
        yield* h.resolveRequest(threadId, "request:ac3-first");
        yield* h.requestApproval(threadId, "request:ac3-second");
        yield* h.expectPhase(threadId, "waiting_for_approval");
        assert.deepStrictEqual(endpointsOf(yield* h.flushSends), [PHONE]);

        yield* h.restartServer;
        yield* h.touch(threadId, "Second request, after another restart");
        yield* h.requestApproval(threadId, "request:ac3-second");
        assert.deepStrictEqual(yield* h.flushSends, []);
      }),
    ),
);

it.effect("push phase 3 AC3: a failed thread pushes once, however often it is touched", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      yield* h.subscribe(PHONE, DEFAULTS);
      yield* h.startServer;

      const threadId = ThreadId.make("ac3-failed");
      yield* h.createThread(threadId, "Breaks");
      yield* h.startRun(threadId);
      yield* h.finishRun(threadId, "failed");
      assert.deepStrictEqual(endpointsOf(yield* h.flushSends), [PHONE]);

      yield* h.touch(threadId, "Breaks, renamed");
      yield* h.finishRun(threadId, "failed");
      assert.deepStrictEqual(yield* h.flushSends, []);

      yield* h.restartServer;
      yield* h.touch(threadId, "Breaks, after the restart");
      assert.deepStrictEqual(yield* h.flushSends, []);
    }),
  ),
);

it.effect("push phase 3 AC4: threads that already need attention at startup do not push", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      yield* h.subscribe(PHONE, ALL_ON);

      const approval = ThreadId.make("ac4-approval");
      const input = ThreadId.make("ac4-input");
      const failed = ThreadId.make("ac4-failed");
      const completed = ThreadId.make("ac4-completed");
      yield* h.createThread(approval, "Waiting before the boot");
      yield* h.startRun(approval);
      yield* h.requestApproval(approval, "request:ac4-approval");
      yield* h.createThread(input, "Asking before the boot");
      yield* h.startRun(input);
      yield* h.requestInput(input, "request:ac4-input");
      yield* h.createThread(failed, "Failed before the boot");
      yield* h.startRun(failed);
      yield* h.finishRun(failed, "failed");
      yield* h.createThread(completed, "Finished before the boot");
      yield* h.startRun(completed);
      yield* h.finishRun(completed, "completed");
      yield* h.expectPhase(approval, "waiting_for_approval");
      yield* h.expectPhase(input, "waiting_for_input");
      yield* h.expectPhase(failed, "failed");
      yield* h.expectPhase(completed, "completed");

      yield* h.startServer;
      assert.deepStrictEqual(yield* h.flushSends, [], "the boot itself sends nothing");

      for (const threadId of [approval, input, failed, completed]) {
        yield* h.touch(threadId, `${threadId}, touched after the boot`);
      }
      assert.deepStrictEqual(yield* h.flushSends, [], "nor does a later event on those threads");

      // The startup record does not silence what happens next.
      yield* h.resolveRequest(approval, "request:ac4-approval");
      yield* h.requestApproval(approval, "request:ac4-approval-next");
      const sent = yield* h.flushSends;
      assert.deepStrictEqual(endpointsOf(sent), [PHONE]);
      assertAllFor(sent, approval);
    }),
  ),
);

it.effect(
  "push phase 3 AC5: a device receives the payload buildPushPayload makes, with no message text",
  () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* h.subscribe(PHONE, DEFAULTS);
        yield* h.startServer;

        const threadId = ThreadId.make("ac5-thread");
        yield* h.createThread(threadId, "Wire the dispatcher");
        yield* h.startRun(threadId);
        yield* h.assistantMessage(threadId);
        yield* h.requestApproval(threadId, "request:ac5");
        const awareness = yield* h.expectPhase(threadId, "waiting_for_approval");

        const sent = yield* h.flushSends;
        assert.strictEqual(sent.length, 1);
        const payload = sent[0]!.payload;
        assert.deepStrictEqual(payload, buildPushPayload(awareness!));
        assert.strictEqual(payload.title, PROJECT_TITLE);
        assert.include(payload.body, "Wire the dispatcher");
        assert.strictEqual(payload.tag, `thread:${ENVIRONMENT_ID}:${threadId}`);
        assert.strictEqual(
          payload.url,
          `/${encodeURIComponent(ENVIRONMENT_ID)}/${encodeURIComponent(threadId)}`,
        );
        assert.notInclude(JSON.stringify(payload), MESSAGE_TEXT);
      }),
    ),
);

it.effect("push phase 3 AC6: a thread created by a v1 import never pushes", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      yield* h.subscribe(PHONE, ALL_ON);
      yield* h.startServer;

      const threadId = ThreadId.make("ac6-v1-import");
      yield* h.createThread(threadId, "Imported from v1", { historyOrigin: "v1_import" });
      yield* h.startRun(threadId);
      yield* h.requestApproval(threadId, "request:ac6-import");
      yield* h.expectPhase(threadId, "waiting_for_approval");
      assert.deepStrictEqual(yield* h.flushSends, []);

      yield* h.resolveRequest(threadId, "request:ac6-import");
      yield* h.finishRun(threadId, "failed");
      yield* h.expectPhase(threadId, "failed");
      assert.deepStrictEqual(yield* h.flushSends, []);
    }),
  ),
);

it.effect("push phase 3 AC6: a thread the developer archived never pushes", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      yield* h.subscribe(PHONE, ALL_ON);
      yield* h.startServer;

      const threadId = ThreadId.make("ac6-archived");
      yield* h.createThread(threadId, "Archived");
      yield* h.startRun(threadId);
      yield* h.archive(threadId);
      yield* h.requestApproval(threadId, "request:ac6-archived");
      assert.deepStrictEqual(yield* h.flushSends, []);

      yield* h.resolveRequest(threadId, "request:ac6-archived");
      yield* h.finishRun(threadId, "failed");
      assert.deepStrictEqual(yield* h.flushSends, []);

      // The same thread pushed before it was archived: archiving stops it.
      const later = ThreadId.make("ac6-archived-later");
      yield* h.createThread(later, "Archived later");
      yield* h.startRun(later);
      yield* h.requestApproval(later, "request:ac6-later-first");
      assert.deepStrictEqual(endpointsOf(yield* h.flushSends), [PHONE]);
      yield* h.archive(later);
      yield* h.resolveRequest(later, "request:ac6-later-first");
      yield* h.requestApproval(later, "request:ac6-later-second");
      assert.deepStrictEqual(yield* h.flushSends, []);
    }),
  ),
);

const at = (second: number) =>
  DateTime.makeUnsafe(`2026-10-26T09:00:${String(second).padStart(2, "0")}.000Z`);

it.effect(
  "push phase 3 regression: an older pending request that becomes current again does not push twice",
  () =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* h.subscribe(PHONE, DEFAULTS);
        yield* h.startServer;

        const threadId = ThreadId.make("regression-overlap");
        yield* h.createThread(threadId, "Two approvals at once");
        yield* h.startRun(threadId);
        yield* h.requestApproval(threadId, "request:older", at(1));
        assert.deepStrictEqual(endpointsOf(yield* h.flushSends), [PHONE], "the older request");
        yield* h.requestApproval(threadId, "request:newer", at(2));
        assert.strictEqual(
          (yield* h.shellOf(threadId))?.pendingRuntimeRequest?.id,
          "request:newer",
        );
        assert.deepStrictEqual(endpointsOf(yield* h.flushSends), [PHONE], "the newer request");

        // Answering the newer request brings the older one back as current.
        yield* h.resolveRequest(threadId, "request:newer");
        assert.strictEqual(
          (yield* h.shellOf(threadId))?.pendingRuntimeRequest?.id,
          "request:older",
        );
        yield* h.expectPhase(threadId, "waiting_for_approval");
        assert.deepStrictEqual(yield* h.flushSends, [], "the older request was already announced");

        // The announced keys survive a restart, not only the latest one.
        yield* h.requestApproval(threadId, "request:third", at(3));
        assert.deepStrictEqual(endpointsOf(yield* h.flushSends), [PHONE]);
        yield* h.restartServer;
        yield* h.resolveRequest(threadId, "request:third");
        assert.strictEqual(
          (yield* h.shellOf(threadId))?.pendingRuntimeRequest?.id,
          "request:older",
        );
        assert.deepStrictEqual(yield* h.flushSends, [], "nor after a restart");

        yield* h.resolveRequest(threadId, "request:older");
        yield* h.requestApproval(threadId, "request:fourth", at(4));
        assert.deepStrictEqual(
          endpointsOf(yield* h.flushSends),
          [PHONE],
          "a new request still pushes",
        );
      }),
    ),
);

it.effect.each(["secret_request", "link_request"] as const)(
  "push phase 3 regression: a %s card pushes once as a question and its answer pushes nothing",
  (type) =>
    withHarness((h) =>
      Effect.gen(function* () {
        yield* h.subscribe(PHONE, DEFAULTS);
        yield* h.subscribe(TABLET, { ...NONE, approval: true });
        yield* h.startServer;

        const threadId = ThreadId.make(`regression-${type}`);
        yield* h.createThread(threadId, "Needs a card answered");
        yield* h.startRun(threadId);
        assert.deepStrictEqual(yield* h.flushSends, []);
        yield* h.inputCard(threadId, `card:${type}`, type, true);
        yield* h.expectPhase(threadId, "waiting_for_input");
        const sent = yield* h.flushSends;
        assert.deepStrictEqual(endpointsOf(sent), [PHONE], "input preference only");
        assertAllFor(sent, threadId);

        yield* h.inputCard(threadId, `card:${type}`, type, false);
        yield* h.expectPhase(threadId, "running");
        assert.deepStrictEqual(yield* h.flushSends, []);
      }),
    ),
);

it.effect(
  "push phase 3 regression: the thread shell carries the v1 import origin the dispatcher reads",
  () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("regression-v1-shell");
        yield* h.createThread(threadId, "Imported from v1", { historyOrigin: "v1_import" });
        assert.strictEqual((yield* h.shellOf(threadId))?.historyOrigin, "v1_import");
      }),
    ),
);
