// Entry point: the pure decisions in `ThreadSignal.ts` that the event sink and the orchestrator
// call. The MCP-level behaviour is in `ThreadSignal.test.ts`; this pins the rules it reaches only
// indirectly.
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  RunId,
  type ThreadAgentSignal,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { decideAgentSignalCommand, withAgentSignalClearings } from "./ThreadSignal.ts";

const at = DateTime.makeUnsafe("2026-10-24T12:00:00Z");
const later = DateTime.add(at, { minutes: 5 });
const threadId = ThreadId.make("thread:signal-rules");
const providerInstanceId = ProviderInstanceId.make("codex");
const signalRunId = RunId.make("run:signal-rules:1");

const signalOf = (kind: ThreadAgentSignal["kind"]): ThreadAgentSignal => ({
  kind,
  note: null,
  runId: signalRunId,
  setAt: DateTime.formatIso(at),
});

const threadWith = (
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId: ProjectId.make("project:signal-rules"),
  title: "Signal rules",
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "test-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
  ...overrides,
});

const runEvent = (
  id: RunId,
  status: OrchestrationV2Run["status"],
  type: "run.created" | "run.updated" = "run.updated",
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${id}:${status}`),
  type,
  threadId,
  runId: id,
  occurredAt: later,
  payload: {
    id,
    threadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    providerThreadId: null,
    userMessageId: MessageId.make(`message:${id}`),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: at,
    startedAt: status === "queued" ? null : at,
    completedAt: ["completed", "failed", "interrupted", "cancelled"].includes(status)
      ? later
      : null,
    checkpointId: null,
    contextHandoffId: null,
  },
});

const messageEvent = (
  role: "user" | "assistant",
  createdBy: "user" | "agent",
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:message:${role}:${createdBy}`),
  type: "message.updated",
  threadId,
  occurredAt: later,
  payload: {
    createdBy,
    creationSource: createdBy === "user" ? "web" : "provider",
    id: MessageId.make(`message:${role}:${createdBy}`),
    threadId,
    runId: null,
    nodeId: null,
    role,
    text: "text",
    attachments: [],
    streaming: role === "assistant",
    createdAt: later,
    updatedAt: later,
  },
});

const turnItemEvent: OrchestrationV2DomainEvent = {
  id: EventId.make("event:turn-item"),
  type: "turn-item.updated",
  threadId,
  occurredAt: later,
  payload: {
    id: TurnItemId.make("item:signal-rules"),
    threadId,
    runId: signalRunId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    type: "dynamic_tool",
    status: "running",
    title: null,
    startedAt: at,
    completedAt: null,
    updatedAt: later,
    toolName: "tool",
    input: null,
    output: null,
  },
};

/** Runs the event-sink step against a stored thread, counting the thread reads it costs. */
const clearings = (
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
  stored: OrchestrationV2AppThread | null,
) =>
  Effect.gen(function* () {
    let reads = 0;
    const output = yield* withAgentSignalClearings(events, () =>
      Effect.sync(() => {
        reads += 1;
        return stored;
      }),
    );
    const cleared = output.filter((event) => event.type === "thread.agent-signal-cleared");
    return { output, reads, cleared };
  });

describe("withAgentSignalClearings", () => {
  it.effect("signal rules: streamed assistant messages and tool items cost no thread read", () =>
    Effect.gen(function* () {
      const events = [messageEvent("assistant", "agent"), turnItemEvent, turnItemEvent];
      const result = yield* clearings(events, threadWith({ agentSignal: signalOf("needs_input") }));
      assert.equal(result.reads, 0);
      assert.strictEqual(result.output, events);
    }),
  );

  it.effect("signal rules: another agent's message clears neither kind", () =>
    Effect.gen(function* () {
      for (const kind of ["needs_input", "ready_to_close"] as const) {
        const result = yield* clearings(
          [messageEvent("user", "agent")],
          threadWith({ agentSignal: signalOf(kind) }),
        );
        assert.lengthOf(result.cleared, 0, kind);
      }
    }),
  );

  it.effect("signal rules: the signal's own run takes back ready_to_close only if unfinished", () =>
    Effect.gen(function* () {
      const stored = threadWith({ agentSignal: signalOf("ready_to_close") });
      for (const status of ["failed", "interrupted", "cancelled"] as const) {
        const result = yield* clearings([runEvent(signalRunId, status)], stored);
        assert.lengthOf(result.cleared, 1, status);
      }
      for (const status of ["running", "waiting", "completed", "rolled_back"] as const) {
        const result = yield* clearings([runEvent(signalRunId, status)], stored);
        assert.lengthOf(result.cleared, 0, status);
      }
    }),
  );

  it.effect("signal rules: a new run clears ready_to_close once it starts, not while queued", () =>
    Effect.gen(function* () {
      const stored = threadWith({ agentSignal: signalOf("ready_to_close") });
      const next = RunId.make("run:signal-rules:2");
      const queued = yield* clearings([runEvent(next, "queued", "run.created")], stored);
      assert.lengthOf(queued.cleared, 0);
      for (const status of ["preparing", "starting", "running"] as const) {
        const started = yield* clearings([runEvent(next, status)], stored);
        assert.lengthOf(started.cleared, 1, status);
      }
    }),
  );

  it.effect("signal rules: no run outcome clears needs_input", () =>
    Effect.gen(function* () {
      const stored = threadWith({ agentSignal: signalOf("needs_input") });
      const next = RunId.make("run:signal-rules:2");
      const result = yield* clearings(
        [runEvent(next, "starting"), runEvent(signalRunId, "failed"), runEvent(next, "cancelled")],
        stored,
      );
      assert.lengthOf(result.cleared, 0);
    }),
  );

  it.effect("signal rules: one clearing per batch, placed right after its cause", () =>
    Effect.gen(function* () {
      const user = messageEvent("user", "user");
      const result = yield* clearings(
        [user, runEvent(RunId.make("run:signal-rules:2"), "starting")],
        threadWith({ agentSignal: signalOf("ready_to_close") }),
      );
      assert.equal(result.reads, 1);
      assert.deepEqual(
        result.output.map((event) => event.type),
        ["message.updated", "thread.agent-signal-cleared", "run.updated"],
      );
      assert.equal(result.cleared[0]?.id, EventId.make(`${user.id}:agent-signal-cleared`));
    }),
  );

  it.effect("signal rules: a signal set earlier in the batch is the one the batch clears", () =>
    Effect.gen(function* () {
      const set: OrchestrationV2DomainEvent = {
        id: EventId.make("event:signal-set"),
        type: "thread.agent-signal-set",
        threadId,
        occurredAt: at,
        payload: threadWith({ agentSignal: signalOf("ready_to_close") }),
      };
      const result = yield* clearings([set, runEvent(signalRunId, "failed")], threadWith());
      assert.lengthOf(result.cleared, 1);
    }),
  );

  // Regression: an eager read of every affected thread took a lookup inside the writer's
  // transaction that RunMetrics.test.ts pins to the run-outcome lineage read, and hung it.
  it.effect("signal rules: a thread created in the batch costs no stored read", () =>
    Effect.gen(function* () {
      const created: OrchestrationV2DomainEvent = {
        id: EventId.make("event:thread-created"),
        type: "thread.created",
        threadId,
        occurredAt: at,
        payload: threadWith(),
      };
      const result = yield* clearings(
        [created, runEvent(signalRunId, "running", "run.created")],
        threadWith({ agentSignal: signalOf("ready_to_close") }),
      );
      assert.equal(result.reads, 0);
      assert.lengthOf(result.cleared, 0);
    }),
  );

  it.effect("signal rules: a thread the store does not have yet is left alone", () =>
    Effect.gen(function* () {
      const result = yield* clearings([messageEvent("user", "user")], null);
      assert.equal(result.reads, 1);
      assert.lengthOf(result.cleared, 0);
    }),
  );
});

describe("decideAgentSignalCommand", () => {
  const setCommand = (note?: string | null) =>
    ({
      type: "thread.agent-signal.set",
      commandId: CommandId.make("command:signal-rules"),
      threadId,
      kind: "needs_input",
      ...(note === undefined ? {} : { note }),
    }) as const;
  const clearCommand = {
    type: "thread.agent-signal.clear",
    commandId: CommandId.make("command:signal-rules:clear"),
    threadId,
  } as const;

  it("signal rules: a blank note is stored as no note, and the active run is stamped", () => {
    for (const note of [undefined, null, "", "   "]) {
      const decision = decideAgentSignalCommand({
        thread: threadWith(),
        command: setCommand(note),
        activeRunId: signalRunId,
        now: later,
      });
      assert.isTrue(Result.isSuccess(decision));
      if (Result.isSuccess(decision)) {
        assert.deepEqual(decision.success.agentSignal, {
          kind: "needs_input",
          note: null,
          runId: signalRunId,
          setAt: DateTime.formatIso(later),
        });
        // A signal is not activity: the thread keeps its place in the list.
        assert.strictEqual(decision.success.updatedAt, at);
      }
    }
    const trimmed = decideAgentSignalCommand({
      thread: threadWith(),
      command: setCommand("  Which branch?  "),
      activeRunId: null,
      now: later,
    });
    assert.equal(Result.isSuccess(trimmed) && trimmed.success.agentSignal?.note, "Which branch?");
  });

  it("signal rules: an archived thread refuses a new signal but can be cleared", () => {
    const archived = threadWith({ archivedAt: at, agentSignal: signalOf("needs_input") });
    const set = decideAgentSignalCommand({
      thread: archived,
      command: setCommand(),
      activeRunId: null,
      now: later,
    });
    assert.isTrue(Result.isFailure(set));
    const clear = decideAgentSignalCommand({
      thread: archived,
      command: clearCommand,
      activeRunId: null,
      now: later,
    });
    assert.isTrue(Result.isSuccess(clear) && clear.success.agentSignal === null);
  });

  it("signal rules: a deleted thread refuses both commands", () => {
    const deleted = threadWith({ deletedAt: at });
    for (const command of [setCommand(), clearCommand]) {
      const decision = decideAgentSignalCommand({
        thread: deleted,
        command,
        activeRunId: null,
        now: later,
      });
      assert.isTrue(Result.isFailure(decision), command.type);
    }
  });
});
