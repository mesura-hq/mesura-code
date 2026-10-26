/**
 * The phone push dispatcher's test harness, shared by the phase 3 specs
 * (`PushDispatcher.test.ts`) and the phase 4 presence specs
 * (`PushDispatcher.presence.test.ts`). `PushDispatcher.test.ts`'s header
 * describes what it builds and how `flushSends` avoids sleeps. `presence` is
 * the `ClientPresence` the dispatcher reads; without it, a real one that no
 * client reports into.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
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
import { assert } from "@effect/vitest";
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
import * as ClientPresence from "./ClientPresence.ts";
import * as PushDispatcher from "./PushDispatcher.ts";
import * as PushSender from "./PushSender.ts";
import * as PushSubscriptions from "./PushSubscriptions.ts";
import * as VapidKeys from "./vapidKeys.ts";

export const ENVIRONMENT_ID = EnvironmentId.make("vigilia-home");
const PROJECT_ID = ProjectId.make("push-project");
export const PROJECT_TITLE = "Mesura Code";
const NOW = DateTime.makeUnsafe("2026-10-26T09:00:00.000Z");
export const MESSAGE_TEXT = "SECRET: the agent's own words must never leave the host";

const FCM = "https://fcm.googleapis.com/fcm/send";
export const ALL_ON: PushPreferences = {
  approval: true,
  input: true,
  failed: true,
  completed: true,
};
export const DEFAULTS: PushPreferences = {
  approval: true,
  input: true,
  failed: true,
  completed: false,
};
export const NONE: PushPreferences = {
  approval: false,
  input: false,
  failed: false,
  completed: false,
};

/** The device `flushSends` waits on; its sends are left out of every result. */
const BARRIER_ENDPOINT = `${FCM}/barrier`;
export const PHONE = `${FCM}/phone`;
export const TABLET = `${FCM}/tablet`;
export const QUIET = `${FCM}/quiet`;
export const BROKEN = `${FCM}/broken`;

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

const makeHarness = Effect.fnUntraced(function* (
  presence: Layer.Layer<ClientPresence.ClientPresence> = ClientPresence.layer,
) {
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
      presence,
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

  /** Resolves once the running dispatcher finished every thread handed to it so far. */
  const drain = Effect.suspend(() => {
    assert.isNotNull(live.dispatcher, "a dispatcher is running");
    return live.dispatcher!.drain;
  });

  /** Every send recorded and not yet taken, barrier traffic included. */
  const takeRecordedSends = Queue.clear(sends);

  /** Waits for the next send; it is consumed. */
  const nextRecordedSend = Queue.take(sends);

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
    drain,
    takeRecordedSends,
    nextRecordedSend,
    dispatchRows,
  };
});

export type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

export const endpointsOf = (sent: ReadonlyArray<RecordedSend>) =>
  sent.map((send) => send.endpoint).toSorted();

/** Every send is for `threadId`, checked through the tag the payload spec pins. */
export const assertAllFor = (sent: ReadonlyArray<RecordedSend>, threadId: ThreadId) => {
  for (const send of sent) {
    assert.strictEqual(send.payload.tag, `thread:${ENVIRONMENT_ID}:${threadId}`);
  }
};

export const withHarness = <E>(
  body: (harness: Harness) => Effect.Effect<void, E>,
  presence?: Layer.Layer<ClientPresence.ClientPresence>,
) => Effect.scoped(Effect.flatMap(makeHarness(presence), body));
