// Entry point: the production thread toolkit (`McpHttpServer.layerThreadToolkit`) called through
// `McpServer.callTool` as the thread's own agent, over the real orchestrator and effect worker. The
// mock provider records each `startTurn` and `compactThread` call; the test ends a turn by
// publishing the provider's terminal events.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadSearch from "./ThreadSearch.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const TOOL = "t3_thread_compact_and_continue";

// The compacting instance's session has `compactThread`; the plain instance's session does not,
// which is how a provider without manual compaction looks to the server.
const compactingInstance = ProviderInstanceId.make("codex");
const plainInstance = ProviderInstanceId.make("claudeAgent");

type FailureClass = "provider_error" | "validation_error";

interface StartedTurn {
  readonly kind: "turn" | "compact";
  readonly instanceId: ProviderInstanceId;
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
}

interface MockProvider {
  readonly started: Queue.Queue<StartedTurn>;
  readonly events: ReadonlyMap<
    ProviderInstanceId,
    PubSub.PubSub<ProviderAdapter.ProviderAdapterV2Event>
  >;
}

function makeMockAdapter(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly model: string;
  readonly compacts: boolean;
  readonly provider: MockProvider;
}): ProviderAdapter.ProviderAdapterV2["Service"] {
  const events = input.provider.events.get(input.instanceId)!;
  const record =
    (kind: StartedTurn["kind"]) => (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
      Queue.offer(input.provider.started, { kind, instanceId: input.instanceId, input: turn }).pipe(
        Effect.asVoid,
      );
  const unused = (detail: string) =>
    Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver: input.driver, detail }));
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    getCapabilities: () => Effect.succeed(input.capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver: input.driver,
          providerInstanceId: input.instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: input.model,
          capabilities: input.capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          instanceId: input.instanceId,
          driver: input.driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const nativeId = `${input.driver}:${threadInput.threadId}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeId}`),
                driver: input.driver,
                providerInstanceId: input.instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver: input.driver, nativeId, strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                contextUsage: null,
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: record("turn"),
          ...(input.compacts ? { compactThread: record("compact") } : {}),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => unused("readThreadSnapshot"),
          rollbackThread: () => unused("rollbackThread"),
          forkThread: () => unused("forkThread"),
        };
        return runtime;
      }),
  };
}

/** Ends a started provider turn the way the provider reports it: a turn update, then terminal. */
const finishTurn = Effect.fn(function* (
  provider: MockProvider,
  turn: StartedTurn,
  status: "completed" | "failed",
  failureClass: FailureClass = "provider_error",
) {
  const events = provider.events.get(turn.instanceId)!;
  const { input } = turn;
  const driver = input.providerThread.driver;
  const now = yield* DateTime.now;
  const providerTurnId = ProviderTurnId.make(`provider-turn:${input.threadId}:${input.runOrdinal}`);
  yield* PubSub.publish(events, {
    type: "provider_turn.updated",
    driver,
    providerTurn: {
      id: providerTurnId,
      providerThreadId: input.providerThread.id,
      nodeId: input.rootNodeId,
      runAttemptId: input.attemptId,
      nativeTurnRef: {
        driver,
        nativeId: `native-turn:${input.threadId}:${input.runOrdinal}`,
        strength: "strong",
      },
      ordinal: input.runOrdinal,
      status,
      startedAt: now,
      completedAt: now,
    },
  });
  yield* PubSub.publish(events, {
    type: "turn.terminal",
    driver,
    providerThreadId: input.providerThread.id,
    providerTurnId,
    runOrdinal: input.runOrdinal,
    ...(status === "failed"
      ? {
          status,
          failureItemOrdinal: input.runOrdinal * 100 + 2,
          failure: makeProviderFailure({
            message: "Simulated compaction failure.",
            code: "simulated_failure",
            class: failureClass,
          }),
        }
      : { status, failure: null }),
    threadDisposition: "reusable",
  });
});

const layerFor = (provider: MockProvider) => {
  const layerDatabase = SqlitePersistence.layerMemory;
  const registry = ProviderAdapterRegistry.layerFromAdapters([
    makeMockAdapter({
      instanceId: compactingInstance,
      driver: ProviderDriverKind.make("codex"),
      capabilities: CodexProviderCapabilitiesV2,
      model: "gpt-5.1-codex",
      compacts: true,
      provider,
    }),
    makeMockAdapter({
      instanceId: plainInstance,
      driver: ProviderDriverKind.make("claudeAgent"),
      capabilities: ClaudeProviderCapabilitiesV2,
      model: "claude-sonnet-4-6",
      compacts: false,
      provider,
    }),
  ]);
  const layerOrchestration = Layer.mergeAll(
    layerDatabase,
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase)),
    ServerSettings.layerTest().pipe(Layer.orDie),
    ProviderReplayHarness.layerWithRegistry({ name: "compact-and-continue" }, registry, {
      databaseLayer: layerDatabase,
      runEffectWorker: false,
    }),
  );
  return McpHttpServer.layerThreadToolkit.pipe(
    Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
    Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
    Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
    Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
    Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(ThreadManagementService.layer.pipe(Layer.provideMerge(layerOrchestration))),
    Layer.provide(Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer)),
  );
};

/** Runs `body` against a fresh database and mock provider. */
const withHarness = <A, E, R>(body: (provider: MockProvider) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const provider: MockProvider = {
        started: yield* Queue.unbounded<StartedTurn>(),
        events: new Map([
          [compactingInstance, yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>()],
          [plainInstance, yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>()],
        ]),
      };
      return yield* body(provider).pipe(Effect.provide(layerFor(provider)));
    }),
  );

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "compact-and-continue", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "compact-and-continue", version: "1" },
  },
  getClient: Effect.die("unused"),
});

interface Caller {
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly subagent?: boolean;
}

const agentScope = (caller: Caller): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("compact-and-continue-environment"),
  requestNamespace: `compact-and-continue:${caller.threadId}`,
  thread: caller,
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
});

const callTool = Effect.fn(function* (caller: Caller, name: string, args: Record<string, unknown>) {
  const server = yield* McpServer.McpServer;
  return yield* server
    .callTool({ name, arguments: args })
    .pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, agentScope(caller)),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
});

/**
 * The call's outcome whether the input schema refuses it (the call fails) or the handler does
 * (`isError`): both reach the agent as a readable error.
 */
const callOutcome = (caller: Caller, args: Record<string, unknown>) =>
  callTool(caller, TOOL, args).pipe(
    Effect.match({
      onFailure: (error) => ({ ok: false, text: String(error) }),
      onSuccess: (result) => ({
        ok: result.isError !== true,
        text: JSON.stringify(result.content),
      }),
    }),
  );

const projectionOf = Effect.fn(function* (threadId: ThreadId) {
  return yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(threadId);
});

const queuedRuns = Effect.fn(function* (threadId: ThreadId) {
  const projection = yield* projectionOf(threadId);
  return projection.runs
    .filter((run) => run.status === "queued")
    .toSorted((left, right) => left.ordinal - right.ordinal)
    .map((run) => ({
      run,
      message: projection.messages.find((message) => message.id === run.userMessageId),
    }));
});

/**
 * A fiber that ends at the first matching update of `runId` written after this call. It replays the
 * event sink from the sequence read now, so an update written before the fiber subscribes counts.
 */
const watchRun = Effect.fn(function* (
  runId: RunId,
  predicate: (run: OrchestrationV2Run) => boolean,
) {
  const eventSink = yield* EventSink.EventSinkV2;
  const afterSequence = yield* eventSink.latestSequence();
  return yield* eventSink.stream({ afterSequence, eventType: "run.updated" }).pipe(
    Stream.filter(
      ({ event }) =>
        event.type === "run.updated" && event.payload.id === runId && predicate(event.payload),
    ),
    Stream.take(1),
    Stream.runDrain,
    Effect.forkScoped,
  );
});

/**
 * A thread on `instanceId` whose first user turn is running on a live provider session, and the
 * caller identity of that thread's agent.
 */
const activeThread = Effect.fn(function* (
  provider: MockProvider,
  name: string,
  instanceId: ProviderInstanceId = compactingInstance,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  const cwd = yield* checkpointWorkspace(`compact-and-continue-${name}`);
  const threadId = ThreadId.make(`thread:compact-and-continue:${name}`);
  const modelSelection = {
    instanceId,
    model: instanceId === compactingInstance ? "gpt-5.1-codex" : "claude-sonnet-4-6",
  };
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${name}`),
    threadId,
    projectId: ProjectId.make("project:compact-and-continue"),
    title: name,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: cwd,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(`message:${name}`),
    threadId,
    messageId: MessageId.make(`message:${name}`),
    text: "Merge this, then compact yourself and write the release notes.",
    attachments: [],
    modelSelection,
    dispatchMode: { type: "start_immediately" },
  });
  yield* worker.drain();
  const first = yield* Queue.take(provider.started);
  assert.equal(first.kind, "turn");
  assert.equal(first.input.threadId, threadId);
  const projection = yield* projectionOf(threadId);
  const sessionId = projection.providerThreads[0]?.providerSessionId;
  if (sessionId == null) return yield* Effect.die(new Error("Provider session missing."));
  // `McpSessionRegistry.issue` mints the caller's `providerSessionId` as a random id per MCP token;
  // it never equals the provider session that runs the thread.
  const caller: Caller = {
    threadId,
    providerSessionId: `mcp-token:${name}`,
    providerInstanceId: instanceId,
  };
  return { threadId, caller, first, sessionId };
});

/**
 * Ends `turn` and waits until its run reaches `status`. The provider's terminal event leaves the run
 * `waiting` on its outbox effects (checkpoint capture), which the drain runs.
 */
const endTurn = Effect.fn(function* (
  provider: MockProvider,
  turn: StartedTurn,
  status: "completed" | "failed",
  failureClass: FailureClass = "provider_error",
) {
  const runId = turn.input.runId;
  const settling = yield* watchRun(
    runId,
    (run) => run.status === "waiting" || run.status === status,
  );
  const ended = yield* watchRun(runId, (run) => run.status === status);
  yield* finishTurn(provider, turn, status, failureClass);
  yield* Fiber.join(settling);
  yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
  yield* Fiber.join(ended);
});

/** Ends `turn`, waits until the next queued run has left the queue, then runs its effects. */
const finishAndStartNext = Effect.fn(function* (
  provider: MockProvider,
  turn: StartedTurn,
  nextRunId: RunId,
) {
  const started = yield* watchRun(nextRunId, (run) => run.status !== "queued");
  yield* endTurn(provider, turn, "completed");
  yield* Fiber.join(started);
  yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
  return yield* Queue.take(provider.started);
});

const NEXT = "Write the release notes for v0.13 from the merged PRs.";
const HANDOFF = "PR #137 merged into dev at fa8450b77a; the notes go in docs/user/releases.md.";

describe("t3_thread_compact_and_continue", () => {
  it.effect(
    "compact-and-continue spec 1: the call queues /compact, then the follow-up, as the agent over MCP",
    () =>
      withHarness((provider) =>
        Effect.gen(function* () {
          const { threadId, caller } = yield* activeThread(provider, "spec-1");
          const before = yield* projectionOf(threadId);
          const result = yield* callTool(caller, TOOL, { next: NEXT, handoff: HANDOFF });
          assert.isFalse(result.isError === true, JSON.stringify(result.content));

          const queued = yield* queuedRuns(threadId);
          assert.lengthOf(queued, 2);
          const [compact, followUp] = queued;
          assert.equal(compact?.message?.text, "/compact");
          assert.deepEqual(compact?.message?.attachments, []);
          assert.include(followUp?.message?.text ?? "", NEXT);
          assert.include(followUp?.message?.text ?? "", HANDOFF);
          for (const entry of queued) {
            assert.equal(entry.message?.createdBy, "agent");
            assert.equal(entry.message?.creationSource, "mcp");
            assert.equal(entry.message?.threadId, threadId);
          }
          // Only the pair is new: the active run is untouched and still running.
          const after = yield* projectionOf(threadId);
          assert.equal(after.runs.length, before.runs.length + 2);
          assert.equal(after.runs[0]?.status, before.runs[0]?.status);

          // Without a handoff the follow-up still carries `next` verbatim.
          const second = yield* activeThread(provider, "spec-1-no-handoff");
          const bare = yield* callTool(second.caller, TOOL, { next: NEXT });
          assert.isFalse(bare.isError === true, JSON.stringify(bare.content));
          const bareQueued = yield* queuedRuns(second.threadId);
          assert.lengthOf(bareQueued, 2);
          assert.equal(bareQueued[0]?.message?.text, "/compact");
          assert.include(bareQueued[1]?.message?.text ?? "", NEXT);
        }),
      ),
  );

  it.effect(
    "compact-and-continue spec 2: the active run ends, compactThread runs, then the follow-up turn",
    () =>
      withHarness((provider) =>
        Effect.gen(function* () {
          const { threadId, caller, first } = yield* activeThread(provider, "spec-2");
          const result = yield* callTool(caller, TOOL, { next: NEXT, handoff: HANDOFF });
          assert.isFalse(result.isError === true, JSON.stringify(result.content));
          const [compact, followUp] = yield* queuedRuns(threadId);
          if (compact === undefined || followUp === undefined)
            return yield* Effect.die(new Error("The pair was not queued."));

          const compaction = yield* finishAndStartNext(provider, first, compact.run.id);
          assert.equal(compaction.kind, "compact", "the /compact run must call compactThread");
          assert.equal(compaction.input.runId, compact.run.id);
          assert.equal(
            (yield* projectionOf(threadId)).runs.find((run) => run.id === followUp.run.id)?.status,
            "queued",
            "the follow-up waits for the compaction",
          );

          const next = yield* finishAndStartNext(provider, compaction, followUp.run.id);
          assert.equal(next.kind, "turn");
          assert.equal(next.input.runId, followUp.run.id);
          assert.include(next.input.message.text, NEXT);
          assert.include(next.input.message.text, HANDOFF);
        }),
      ),
  );

  it.effect(
    "compact-and-continue spec 3: a failed compaction leaves the follow-up queued and held",
    () =>
      withHarness((provider) =>
        Effect.gen(function* () {
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const { threadId, caller, first } = yield* activeThread(provider, "spec-3");
          const result = yield* callTool(caller, TOOL, { next: NEXT });
          assert.isFalse(result.isError === true, JSON.stringify(result.content));
          const [compact, followUp] = yield* queuedRuns(threadId);
          if (compact === undefined || followUp === undefined)
            return yield* Effect.die(new Error("The pair was not queued."));

          const compaction = yield* finishAndStartNext(provider, first, compact.run.id);
          assert.equal(compaction.kind, "compact");

          const held = yield* watchRun(followUp.run.id, (run) => run.queueHeld === true);
          yield* endTurn(provider, compaction, "failed");
          yield* Fiber.join(held);
          yield* worker.drain();

          const projection = yield* projectionOf(threadId);
          assert.equal(projection.runs.find((run) => run.id === compact.run.id)?.status, "failed");
          const waiting = projection.runs.find((run) => run.id === followUp.run.id);
          assert.equal(waiting?.status, "queued");
          assert.isTrue(waiting?.queueHeld === true);
          assert.equal(yield* Queue.size(provider.started), 0, "no turn started on its own");
        }),
      ),
  );

  it.effect("compact-and-continue spec 4: a second call in the same run queues nothing new", () =>
    withHarness((provider) =>
      Effect.gen(function* () {
        const { threadId, caller } = yield* activeThread(provider, "spec-4");
        const firstCall = yield* callTool(caller, TOOL, { next: NEXT, handoff: HANDOFF });
        assert.isFalse(firstCall.isError === true, JSON.stringify(firstCall.content));
        const pair = (yield* queuedRuns(threadId)).map((entry) => entry.run.id);
        assert.lengthOf(pair, 2);

        const secondCall = yield* callTool(caller, TOOL, { next: NEXT, handoff: HANDOFF });
        assert.isFalse(secondCall.isError === true, JSON.stringify(secondCall.content));
        const after = yield* queuedRuns(threadId);
        assert.deepEqual(
          after.map((entry) => entry.run.id),
          pair,
        );
        assert.lengthOf(
          (yield* projectionOf(threadId)).messages.filter((message) => message.text === "/compact"),
          1,
        );
      }),
    ),
  );

  it.effect(
    "compact-and-continue spec 5: subagents, providers without compactThread and an empty next are refused",
    () =>
      withHarness((provider) =>
        Effect.gen(function* () {
          const subagent = yield* activeThread(provider, "spec-5-subagent");
          const asSubagent = yield* callOutcome(
            { ...subagent.caller, subagent: true },
            { next: NEXT },
          );
          assert.isFalse(asSubagent.ok, asSubagent.text);
          assert.match(asSubagent.text, /subagent/i);
          assert.lengthOf(yield* queuedRuns(subagent.threadId), 0);

          const plain = yield* activeThread(provider, "spec-5-plain", plainInstance);
          const noCompaction = yield* callOutcome(plain.caller, { next: NEXT });
          assert.isFalse(noCompaction.ok, noCompaction.text);
          assert.match(noCompaction.text, /compaction/i);
          assert.lengthOf(yield* queuedRuns(plain.threadId), 0);

          const blank = yield* activeThread(provider, "spec-5-blank");
          for (const next of ["", "   \n\t "]) {
            const refused = yield* callOutcome(blank.caller, { next });
            assert.isFalse(refused.ok, `next ${JSON.stringify(next)}: ${refused.text}`);
            assert.match(refused.text, /next/);
            assert.lengthOf(yield* queuedRuns(blank.threadId), 0);
          }
          // The tool exists: these are refusals by the tool, not an unknown tool name.
          const server = yield* McpServer.McpServer;
          assert.isDefined(server.tools.find(({ tool }) => tool.name === TOOL));
        }),
      ),
  );

  it.effect(
    "compact-and-continue spec 7: the tool description states the permission rule in at most four sentences",
    () =>
      withHarness(() =>
        Effect.gen(function* () {
          const server = yield* McpServer.McpServer;
          const description = server.tools.find(({ tool }) => tool.name === TOOL)?.tool.description;
          assert.isString(description);
          const text = description ?? "";
          assert.match(text, /only when the user's latest message asks/i);
          assert.match(text, /compact/i);
          assert.match(text, /fail|incomplete/i);
          // Sentences end in `.`, `!` or `?` followed by whitespace or the end of the text.
          const sentences = text.split(/[.!?](?:\s+|$)/).filter((part) => part.trim() !== "");
          assert.isAtMost(sentences.length, 4, text);
        }),
      ),
  );
});

describe("compact-and-continue guards", () => {
  it.effect("compact-and-continue guard: t3_thread_signal still marks the caller's thread", () =>
    withHarness((provider) =>
      Effect.gen(function* () {
        const { threadId, caller } = yield* activeThread(provider, "guard-signal");
        const result = yield* callTool(caller, "t3_thread_signal", {
          state: "needs_input",
          note: "Which branch?",
        });
        assert.isFalse(result.isError === true, JSON.stringify(result.content));
        const shell = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadShell(threadId);
        assert.deepInclude(shell?.agentSignal ?? {}, {
          kind: "needs_input",
          note: "Which branch?",
        });
      }),
    ),
  );

  it.effect(
    "compact-and-continue guard: a user-queued /compact still becomes a compaction turn",
    () =>
      withHarness((provider) =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const { threadId, first } = yield* activeThread(provider, "guard-user-compact");
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("message:guard-user-compact:compact"),
            threadId,
            messageId: MessageId.make("message:guard-user-compact:compact"),
            text: "/compact",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
          });
          const [queued] = yield* queuedRuns(threadId);
          if (queued === undefined) return yield* Effect.die(new Error("/compact not queued."));
          const compaction = yield* finishAndStartNext(provider, first, queued.run.id);
          assert.equal(compaction.kind, "compact");
          assert.equal(compaction.input.runId, queued.run.id);
        }),
      ),
  );

  it.effect(
    "compact-and-continue guard: a user-queued /compact on a provider without compactThread fails its run",
    () =>
      withHarness((provider) =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const { threadId, first } = yield* activeThread(
            provider,
            "guard-plain-compact",
            plainInstance,
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("message:guard-plain-compact:compact"),
            threadId,
            messageId: MessageId.make("message:guard-plain-compact:compact"),
            text: "/compact",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
          });
          const [queued] = yield* queuedRuns(threadId);
          if (queued === undefined) return yield* Effect.die(new Error("/compact not queued."));
          const failed = yield* watchRun(queued.run.id, (run) => run.status === "failed");
          const started = yield* watchRun(queued.run.id, (run) => run.status !== "queued");
          yield* endTurn(provider, first, "completed");
          yield* Fiber.join(started);
          yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
          yield* Fiber.join(failed);
          assert.equal(yield* Queue.size(provider.started), 0, "no provider turn started");
        }),
      ),
  );
});

describe("compact-and-continue review regressions", () => {
  it.effect(
    "compact-and-continue regression P1-1: a retry after a rejected follow-up completes the pair",
    () =>
      withHarness((provider) =>
        Effect.gen(function* () {
          const { threadId, caller } = yield* activeThread(provider, "regression-retry");
          const activeRunId = (yield* projectionOf(threadId)).runs[0]!.id;
          // The state a transient rejection of the follow-up leaves behind: its first command id
          // carries a rejected receipt and no message.
          const now = yield* DateTime.now;
          yield* (yield* CommandReceiptStore.CommandReceiptStoreV2).upsert({
            commandId: CommandId.make(
              `mcp:compact-and-continue:${threadId}:${activeRunId}:follow-up`,
            ),
            threadId,
            commandType: "message.dispatch",
            acceptedAt: now,
            resultSequence: 0,
            status: "rejected",
            error: "Simulated transient provider lookup failure.",
          });

          const retried = yield* callTool(caller, TOOL, { next: NEXT, handoff: HANDOFF });
          assert.isFalse(retried.isError === true, JSON.stringify(retried.content));
          const pair = yield* queuedRuns(threadId);
          assert.deepEqual(
            pair.map((entry) => entry.message?.text.includes(NEXT) ?? false),
            [false, true],
          );
          assert.equal(pair[0]?.message?.text, "/compact");
          assert.deepInclude(retried.structuredContent ?? {}, {
            compactRunId: pair[0]?.run.id,
            followUpRunId: pair[1]?.run.id,
          });

          // Another call still finds the one pair and queues nothing.
          const again = yield* callTool(caller, TOOL, { next: NEXT, handoff: HANDOFF });
          assert.isFalse(again.isError === true, JSON.stringify(again.content));
          assert.deepEqual(
            (yield* queuedRuns(threadId)).map((entry) => entry.run.id),
            pair.map((entry) => entry.run.id),
          );
          for (const entry of pair) assert.equal(entry.message?.senderThreadId, threadId);
        }),
      ),
  );

  it.effect(
    "compact-and-continue regression P1-2: a validation_error compaction failure holds the follow-up",
    () =>
      withHarness((provider) =>
        Effect.gen(function* () {
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const { threadId, caller, first } = yield* activeThread(
            provider,
            "regression-validation",
          );
          const result = yield* callTool(caller, TOOL, { next: NEXT });
          assert.isFalse(result.isError === true, JSON.stringify(result.content));
          const [compact, followUp] = yield* queuedRuns(threadId);
          if (compact === undefined || followUp === undefined)
            return yield* Effect.die(new Error("The pair was not queued."));

          const compaction = yield* finishAndStartNext(provider, first, compact.run.id);
          assert.equal(compaction.kind, "compact");
          // Ends at the hold or at the follow-up's start, whichever comes first.
          const decided = yield* watchRun(
            followUp.run.id,
            (run) => run.queueHeld === true || run.status !== "queued",
          );
          yield* endTurn(provider, compaction, "failed", "validation_error");
          yield* Fiber.join(decided);
          yield* worker.drain();

          const waiting = (yield* projectionOf(threadId)).runs.find(
            (run) => run.id === followUp.run.id,
          );
          assert.equal(waiting?.status, "queued");
          assert.isTrue(waiting?.queueHeld === true);
          assert.equal(yield* Queue.size(provider.started), 0, "no turn started on its own");
        }),
      ),
  );
});

describe("compact-and-continue verifier regressions", () => {
  it.effect(
    "compact-and-continue regression V2-1: an MCP caller id that is not the provider session id still queues the pair",
    () =>
      withHarness((provider) =>
        Effect.gen(function* () {
          const { threadId, caller, sessionId } = yield* activeThread(
            provider,
            "regression-opaque-caller",
          );
          assert.notEqual(caller.providerSessionId, sessionId);
          const result = yield* callTool(caller, TOOL, { next: NEXT });
          assert.isFalse(result.isError === true, JSON.stringify(result.content));
          const queued = yield* queuedRuns(threadId);
          assert.lengthOf(queued, 2);
          assert.equal(queued[0]?.message?.text, "/compact");
          assert.include(queued[1]?.message?.text ?? "", NEXT);
        }),
      ),
  );
});
