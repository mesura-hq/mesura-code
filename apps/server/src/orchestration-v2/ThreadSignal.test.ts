// Entry point: the production thread toolkit registration (`McpHttpServer.layerThreadToolkit`)
// called through `McpServer.callTool` as the thread's own agent, over the real
// `ThreadManagementService` and orchestrator. Every assertion reads the persisted thread shell.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  THREAD_AGENT_SIGNAL_NOTE_MAX_LENGTH,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadSearch from "./ThreadSearch.ts";
import { isAutoSettlementCandidate, isSnoozed } from "./ThreadSettlementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for thread signals"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestration = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase)),
  ServerSettings.layerTest().pipe(Layer.orDie),
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-signal" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);
const layerThreadManagement = ThreadManagementService.layer.pipe(
  Layer.provideMerge(layerOrchestration),
);
const layerTest = McpHttpServer.layerThreadToolkit.pipe(
  Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
  Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
  Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
  Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
  Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(layerThreadManagement),
);

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "thread-signal", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "thread-signal", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const ownAgentScope = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("thread-signal-environment"),
  requestNamespace: `thread-signal:${threadId}`,
  thread: { threadId, providerSessionId: `session:${threadId}`, providerInstanceId: instanceId },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
});

// A client caller acts on a named thread without being that thread's agent.
const clientScope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("thread-signal-environment"),
  requestNamespace: "client:thread-signal",
  thread: undefined,
  client: { sessionId: "thread-signal-client", label: "Claude Code", access: "full-access" },
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};

const callTool = Effect.fn(function* (
  threadId: ThreadId,
  name: string,
  args: Record<string, unknown>,
  scope: McpInvocationContext.McpInvocationScope = ownAgentScope(threadId),
) {
  const server = yield* McpServer.McpServer;
  return yield* server
    .callTool({ name, arguments: args })
    .pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
});

const signal = (threadId: ThreadId, state: string, note?: string) =>
  callTool(threadId, "t3_thread_signal", note === undefined ? { state } : { state, note });

const readShell = Effect.fn(function* (threadId: ThreadId) {
  const shell = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadShell(threadId);
  if (shell === null) return yield* Effect.die(new Error(`Shell ${threadId} missing.`));
  return shell;
});

// Read as an untyped record so the fence runs before the contract field exists.
const readSignal = Effect.fn(function* (threadId: ThreadId) {
  const shell = (yield* readShell(threadId)) as unknown as Record<string, unknown>;
  return (shell.agentSignal ?? null) as {
    readonly kind: string;
    readonly note: string | null;
    readonly runId: string | null;
  } | null;
});

const createThread = Effect.fn(function* (name: string) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadId = ThreadId.make(`thread:signal:${name}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${name}`),
    threadId,
    projectId: ProjectId.make("project:thread-signal"),
    title: name,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
});

const latestRun = Effect.fn(function* (threadId: ThreadId) {
  const runs = (yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(threadId)).runs;
  const run = runs.at(-1);
  if (run === undefined) return yield* Effect.die(new Error("Run missing."));
  return run;
});

const userMessage = Effect.fn(function* (threadId: ThreadId, id: string) {
  yield* (yield* Orchestrator.OrchestratorV2).dispatch({
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(`message:${id}`),
    threadId,
    messageId: MessageId.make(`message:${id}`),
    text: id,
    attachments: [],
    modelSelection,
    dispatchMode: { type: "start_immediately" },
  });
  return yield* latestRun(threadId);
});

const automaticWake = Effect.fn(function* (threadId: ThreadId, id: string) {
  yield* (yield* Orchestrator.OrchestratorV2).dispatch({
    type: "message.dispatch",
    createdBy: "agent",
    creationSource: "provider",
    notification: {
      source: { kind: "background_task" },
      outcome: "updated",
      summary: "Background activity updated",
    },
    commandId: CommandId.make(`wake:${id}`),
    threadId,
    messageId: MessageId.make(`wake:${id}`),
    text: id,
    attachments: [],
    modelSelection,
    // Notifications only queue; with no active run the queued wake starts at once.
    dispatchMode: { type: "queue_after_active" },
  });
  const run = yield* latestRun(threadId);
  assert.notEqual(run.status, "queued", "the automatic wake should have started");
  return run;
});

const endRun = Effect.fn(function* (
  run: OrchestrationV2Run,
  status: "completed" | "failed",
  id: string,
) {
  const now = yield* DateTime.now;
  yield* (yield* EventSink.EventSinkV2).write({
    commandId: CommandId.make(`end:${id}`),
    events: [
      {
        id: EventId.make(`end:${id}`),
        type: "run.updated",
        threadId: run.threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status, startedAt: run.startedAt ?? now, completedAt: now },
      },
    ],
  });
});

const interruptRun = Effect.fn(function* (run: OrchestrationV2Run, id: string) {
  yield* (yield* Orchestrator.OrchestratorV2).dispatch({
    type: "run.interrupt",
    commandId: CommandId.make(`interrupt:${id}`),
    threadId: run.threadId,
    runId: run.id,
  });
});

const settlementCandidate = Effect.fn(function* (threadId: ThreadId) {
  const [candidate] = yield* (yield* ProjectionStore.ProjectionStoreV2).getSettlementCandidates(
    threadId,
  );
  if (candidate === undefined) return yield* Effect.die(new Error("Candidate missing."));
  const shell = yield* readShell(threadId);
  return { ...candidate, factoryRun: shell.factoryRun ?? null };
});

/**
 * A thread whose one user turn completed, idle and otherwise eligible for auto-settle. An agent
 * can call thread tools only while it owns an active run, so a signal is set during that turn.
 */
const idleThread = Effect.fn(function* (
  name: string,
  withSignal?: { readonly state: "needs_input" | "ready_to_close"; readonly note?: string },
) {
  const threadId = yield* createThread(name);
  const run = yield* userMessage(threadId, `${name}:first`);
  if (withSignal !== undefined) {
    const result = yield* signal(threadId, withSignal.state, withSignal.note);
    assert.isFalse(result.isError === true, JSON.stringify(result.content));
  }
  yield* endRun(run, "completed", `${name}:first`);
  return threadId;
});

describe("t3_thread_signal agent signal", () => {
  it.effect(
    "signal spec 1: needs_input and ready_to_close with a note set the shell agentSignal",
    () =>
      Effect.gen(function* () {
        const needsInput = yield* createThread("set-needs-input");
        const run = yield* userMessage(needsInput, "set-needs-input");
        const result = yield* signal(needsInput, "needs_input", "Which database should I use?");
        assert.isFalse(result.isError === true, JSON.stringify(result.content));
        assert.deepInclude(yield* readSignal(needsInput), {
          kind: "needs_input",
          note: "Which database should I use?",
          runId: run.id,
        });

        const readyToClose = yield* createThread("set-ready-to-close");
        yield* userMessage(readyToClose, "set-ready-to-close");
        assert.isFalse((yield* signal(readyToClose, "ready_to_close")).isError === true);
        assert.deepInclude(yield* readSignal(readyToClose), { kind: "ready_to_close", note: null });

        // The signal reaches other devices through the shell snapshot every client loads.
        const snapshot = yield* (yield* ProjectionStore.ProjectionStoreV2).getShellSnapshot();
        const fromSnapshot = snapshot.threads.find((thread) => thread.id === needsInput) as
          | Record<string, unknown>
          | undefined;
        assert.deepInclude(fromSnapshot?.agentSignal as object, { kind: "needs_input" });
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("signal spec 2: state clear removes the agent signal", () =>
    Effect.gen(function* () {
      const threadId = yield* createThread("clear");
      yield* userMessage(threadId, "clear");
      yield* signal(threadId, "needs_input", "Pick one");
      assert.equal((yield* readSignal(threadId))?.kind, "needs_input");
      const result = yield* signal(threadId, "clear");
      assert.isFalse(result.isError === true, JSON.stringify(result.content));
      assert.isNull(yield* readSignal(threadId));
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("signal spec 2b: clearing a thread without a signal succeeds and changes nothing", () =>
    Effect.gen(function* () {
      const threadId = yield* createThread("clear-empty");
      yield* userMessage(threadId, "clear-empty");
      const before = yield* readShell(threadId);
      assert.isNull(yield* readSignal(threadId));
      for (const attempt of ["first", "repeat"]) {
        const result = yield* signal(threadId, "clear");
        assert.isFalse(result.isError === true, `${attempt}: ${JSON.stringify(result.content)}`);
        assert.property(result.structuredContent, "sequence");
        assert.isNull(yield* readSignal(threadId));
      }
      const after = yield* readShell(threadId);
      assert.equal(after.settledOverride, before.settledOverride);
      assert.equal(after.activeRunId, before.activeRunId);
      assert.deepEqual(after.updatedAt, before.updatedAt);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("signal spec 3a: a user-authored message clears needs_input and ready_to_close", () =>
    Effect.gen(function* () {
      for (const state of ["needs_input", "ready_to_close"] as const) {
        const threadId = yield* createThread(`user-clears-${state}`);
        const run = yield* userMessage(threadId, `user-clears-${state}:first`);
        yield* signal(threadId, state);
        yield* endRun(run, "completed", `user-clears-${state}`);
        assert.equal((yield* readSignal(threadId))?.kind, state);
        yield* userMessage(threadId, `user-clears-${state}:reply`);
        assert.isNull(yield* readSignal(threadId), state);
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("signal spec 3b: an automatic wake clears ready_to_close but keeps needs_input", () =>
    Effect.gen(function* () {
      const ready = yield* createThread("wake-ready-to-close");
      const readyRun = yield* userMessage(ready, "wake-ready-to-close:first");
      yield* signal(ready, "ready_to_close");
      yield* endRun(readyRun, "completed", "wake-ready-to-close");
      assert.equal((yield* readSignal(ready))?.kind, "ready_to_close");
      yield* automaticWake(ready, "wake-ready-to-close");
      assert.isNull(yield* readSignal(ready));

      const question = yield* createThread("wake-needs-input");
      const questionRun = yield* userMessage(question, "wake-needs-input:first");
      yield* signal(question, "needs_input", "Ship it?");
      yield* endRun(questionRun, "completed", "wake-needs-input");
      yield* automaticWake(question, "wake-needs-input");
      assert.deepInclude(yield* readSignal(question), { kind: "needs_input", note: "Ship it?" });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("signal spec 4: a failed or interrupted run clears the ready_to_close it set", () =>
    Effect.gen(function* () {
      const failed = yield* createThread("failed-ready-to-close");
      const failedRun = yield* userMessage(failed, "failed-ready-to-close");
      yield* signal(failed, "ready_to_close");
      assert.equal((yield* readSignal(failed))?.runId, failedRun.id);
      yield* endRun(failedRun, "failed", "failed-ready-to-close");
      assert.isNull(yield* readSignal(failed));

      const interrupted = yield* createThread("interrupted-ready-to-close");
      const interruptedRun = yield* userMessage(interrupted, "interrupted-ready-to-close");
      yield* signal(interrupted, "ready_to_close");
      yield* interruptRun(interruptedRun, "interrupted-ready-to-close");
      assert.isNull(yield* readSignal(interrupted));

      // A run that completes keeps the mark; only a run that did not finish takes it back.
      const completed = yield* createThread("completed-ready-to-close");
      const completedRun = yield* userMessage(completed, "completed-ready-to-close");
      yield* signal(completed, "ready_to_close");
      yield* endRun(completedRun, "completed", "completed-ready-to-close");
      assert.equal((yield* readSignal(completed))?.kind, "ready_to_close");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("signal spec 5: settling clears the signal and unsettling does not restore it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      for (const state of ["needs_input", "ready_to_close"] as const) {
        const threadId = yield* idleThread(`settle-clears-${state}`, { state });
        assert.equal((yield* readSignal(threadId))?.kind, state);
        yield* orchestrator.dispatch({
          type: "thread.settle",
          commandId: CommandId.make(`settle:${state}`),
          threadId,
        });
        assert.equal((yield* readShell(threadId)).settledOverride, "settled");
        assert.isNull(yield* readSignal(threadId), state);
        yield* orchestrator.dispatch({
          type: "thread.unsettle",
          commandId: CommandId.make(`unsettle:${state}`),
          threadId,
          reason: "user",
        });
        assert.isNull(yield* readSignal(threadId), state);
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "signal spec 6: an own-agent organize settle marks ready_to_close before it applies",
    () =>
      Effect.gen(function* () {
        const threadId = yield* createThread("own-agent-settle");
        const run = yield* userMessage(threadId, "own-agent-settle");
        const result = yield* callTool(threadId, "t3_thread_organize", { action: "settle" });
        assert.deepEqual(result.structuredContent, { settlesWhenTurnEnds: true });
        const shell = yield* readShell(threadId);
        assert.isNull(shell.settledOverride);
        assert.deepInclude(yield* readSignal(threadId), { kind: "ready_to_close", runId: run.id });
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("signal spec 7: needs_input blocks auto-settle and wakes a snoozed thread", () =>
    Effect.gen(function* () {
      const threadId = yield* idleThread("needs-input-blocks", {
        state: "needs_input",
        note: "Which branch?",
      });
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      assert.isFalse(isAutoSettlementCandidate(yield* settlementCandidate(threadId), nowMs));

      const snoozed = yield* idleThread("needs-input-wakes");
      yield* (yield* Orchestrator.OrchestratorV2).dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("snooze:needs-input-wakes"),
        threadId: snoozed,
        snoozedUntil: DateTime.formatIso(DateTime.add(yield* DateTime.now, { days: 1 })),
      });
      assert.isTrue(isSnoozed(yield* settlementCandidate(snoozed), nowMs));
      // A background wake keeps the snooze (guarded below); its question ends it.
      const wake = yield* automaticWake(snoozed, "needs-input-wakes");
      yield* signal(snoozed, "needs_input", "Which branch?");
      yield* endRun(wake, "completed", "needs-input-wakes-wake");
      assert.isFalse(isSnoozed(yield* settlementCandidate(snoozed), nowMs));
    }).pipe(Effect.provide(layerTest)),
  );
});

describe("thread signal review regressions", () => {
  it.effect("signal regression P1-1: a clearing keeps earlier changes in its batch", () =>
    Effect.gen(function* () {
      const threadId = yield* createThread("clearing-keeps-batch");
      const first = yield* userMessage(threadId, "clearing-keeps-batch");
      yield* signal(threadId, "ready_to_close");
      yield* endRun(first, "completed", "clearing-keeps-batch");
      const now = yield* DateTime.now;
      const providerThreadId = ProviderThreadId.make("provider-thread:clearing-keeps-batch");
      // One writer's batch: a new provider binding, then the new run whose start clears the mark.
      yield* (yield* EventSink.EventSinkV2).write({
        commandId: CommandId.make("batch:clearing-keeps-batch"),
        events: [
          {
            id: EventId.make("batch:clearing-keeps-batch:provider-thread"),
            type: "provider-thread.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              appThreadId: threadId,
              ownerNodeId: null,
              driver: ProviderDriverKind.make("codex"),
              providerInstanceId: instanceId,
              providerSessionId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 2,
              lastRunOrdinal: 2,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("batch:clearing-keeps-batch:run"),
            type: "run.created",
            threadId,
            runId: RunId.make("run:clearing-keeps-batch:2"),
            occurredAt: now,
            payload: {
              ...first,
              id: RunId.make("run:clearing-keeps-batch:2"),
              ordinal: first.ordinal + 1,
              status: "starting",
              requestedAt: now,
              startedAt: now,
              completedAt: null,
            },
          },
        ],
      });
      assert.isNull(yield* readSignal(threadId));
      const stored = yield* (yield* ProjectionStore.ProjectionStoreV2).getThread(threadId);
      assert.equal(stored.activeProviderThreadId, providerThreadId);
      assert.equal(DateTime.toEpochMillis(stored.updatedAt), DateTime.toEpochMillis(now));
      assert.equal((yield* readShell(threadId)).activeProviderThreadId, providerThreadId);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("signal regression P1-2: a stale auto-settle does not erase a later needs_input", () =>
    Effect.gen(function* () {
      const threadId = yield* idleThread("stale-auto-settle");
      // The sweep reads the idle thread, then the question arrives before its command runs.
      const snapshotAt = yield* DateTime.now;
      const result = yield* callTool(
        threadId,
        "t3_thread_signal",
        { state: "needs_input", note: "Which branch?", threadId },
        clientScope,
      );
      assert.isFalse(result.isError === true, JSON.stringify(result.content));
      const rejected = yield* (yield* Orchestrator.OrchestratorV2)
        .dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make("auto-settle:stale-auto-settle"),
          threadId,
          snapshotAt,
        })
        .pipe(Effect.flip);
      assert.equal(rejected._tag, "OrchestratorDispatchError");
      assert.isNull((yield* readShell(threadId)).settledOverride);
      assert.deepInclude(yield* readSignal(threadId), {
        kind: "needs_input",
        note: "Which branch?",
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("signal regression P2-1: a note over the bound is rejected, not truncated", () =>
    Effect.gen(function* () {
      const threadId = yield* createThread("note-bound");
      yield* userMessage(threadId, "note-bound");
      const longest = "q".repeat(THREAD_AGENT_SIGNAL_NOTE_MAX_LENGTH);
      const accepted = yield* signal(threadId, "needs_input", longest);
      assert.isFalse(accepted.isError === true, JSON.stringify(accepted.content));
      assert.equal((yield* readSignal(threadId))?.note, longest);

      // The MCP input schema refuses it before the handler runs, naming the field and the bound.
      const tooLong = yield* signal(threadId, "ready_to_close", `${longest}!`).pipe(Effect.flip);
      assert.include(String(tooLong), "t3_thread_signal");
      assert.include(String(tooLong), `at most ${THREAD_AGENT_SIGNAL_NOTE_MAX_LENGTH}`);
      assert.include(String(tooLong), "note");
      // The rejected call changed nothing.
      assert.deepInclude(yield* readSignal(threadId), { kind: "needs_input", note: longest });
    }).pipe(Effect.provide(layerTest)),
  );
});

describe("thread signal guards", () => {
  it.effect("signal guard: own-agent organize settle defers until the turn completes", () =>
    Effect.gen(function* () {
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const threadId = yield* createThread("guard-deferred-settle");
      const run = yield* userMessage(threadId, "guard-deferred-settle");
      const result = yield* callTool(threadId, "t3_thread_organize", { action: "settle" });
      assert.isFalse(result.isError === true, JSON.stringify(result.content));
      assert.deepEqual(result.structuredContent, { settlesWhenTurnEnds: true });
      assert.isNull((yield* readShell(threadId)).settledOverride);

      yield* endRun(run, "completed", "guard-deferred-settle");
      // The deferred settle forked by the tool call is the same service method; awaiting it
      // directly makes the outcome observable without waiting on the forked fiber.
      yield* threadManagement.settleAfterRun({
        projectId: (yield* readShell(threadId)).projectId,
        threadId,
        runId: run.id,
      });
      assert.equal((yield* readShell(threadId)).settledOverride, "settled");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("signal guard: the deferred own-agent settle applies only to a completed run", () =>
    Effect.gen(function* () {
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const failed = yield* createThread("guard-settle-failed");
      const failedRun = yield* userMessage(failed, "guard-settle-failed");
      yield* endRun(failedRun, "failed", "guard-settle-failed");
      yield* threadManagement.settleAfterRun({
        projectId: (yield* readShell(failed)).projectId,
        threadId: failed,
        runId: failedRun.id,
      });
      assert.isNull((yield* readShell(failed)).settledOverride);

      const interrupted = yield* createThread("guard-settle-interrupted");
      const interruptedRun = yield* userMessage(interrupted, "guard-settle-interrupted");
      yield* interruptRun(interruptedRun, "guard-settle-interrupted");
      yield* threadManagement.settleAfterRun({
        projectId: (yield* readShell(interrupted)).projectId,
        threadId: interrupted,
        runId: interruptedRun.id,
      });
      assert.isNull((yield* readShell(interrupted)).settledOverride);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("signal guard: organize settle by another caller settles an idle thread at once", () =>
    Effect.gen(function* () {
      const threadId = yield* idleThread("guard-idle-settle");
      const result = yield* callTool(
        threadId,
        "t3_thread_organize",
        { action: "settle", threadId },
        clientScope,
      );
      assert.isFalse(result.isError === true, JSON.stringify(result.content));
      assert.property(result.structuredContent, "sequence");
      assert.equal((yield* readShell(threadId)).settledOverride, "settled");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("signal guard: an idle thread without a signal is an auto-settle candidate", () =>
    Effect.gen(function* () {
      const threadId = yield* idleThread("guard-auto-settle");
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      assert.isTrue(isAutoSettlementCandidate(yield* settlementCandidate(threadId), nowMs));
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("signal guard: a snoozed thread without a signal stays snoozed through a wake", () =>
    Effect.gen(function* () {
      const threadId = yield* idleThread("guard-snooze");
      yield* (yield* Orchestrator.OrchestratorV2).dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("snooze:guard-snooze"),
        threadId,
        snoozedUntil: DateTime.formatIso(DateTime.add(yield* DateTime.now, { days: 1 })),
      });
      const wake = yield* automaticWake(threadId, "guard-snooze");
      yield* endRun(wake, "completed", "guard-snooze-wake");
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const candidate = yield* settlementCandidate(threadId);
      assert.isTrue(isSnoozed(candidate, nowMs));
      assert.isFalse(isAutoSettlementCandidate(candidate, nowMs));
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("signal guard: a pending structured request blocks auto-settle and wakes snooze", () =>
    Effect.gen(function* () {
      const threadId = yield* idleThread("guard-pending-request");
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const candidate = yield* settlementCandidate(threadId);
      const blocked: typeof candidate = {
        ...candidate,
        snoozedUntil: DateTime.add(yield* DateTime.now, { days: 1 }),
        snoozedAt: yield* DateTime.now,
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("request:guard-pending"),
          kind: "user_input",
          createdAt: yield* DateTime.now,
        },
      };
      assert.isFalse(isAutoSettlementCandidate(blocked, nowMs));
      assert.isFalse(isSnoozed(blocked, nowMs));
    }).pipe(Effect.provide(layerTest)),
  );
});
