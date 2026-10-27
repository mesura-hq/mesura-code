// Regression: a delegated task that finished before its parent's run leaves the active roster
// before its result reaches the parent, and live shells showed Done in that gap. Both shell reads
// must name the task as pending work until the result is delivered.
import { assert, expect, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerSql = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
const modelSelection = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-opus-5-5",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("claudeAgent");
const providerInstanceId = modelSelection.instanceId;

it.effect.each([
  ["memory", ProjectionStore.layerMemory],
  ["SQL", layerSql],
] as const)(
  "%s delegated result hold: a finished delegated task holds its parent until delivery",
  ([, layer]) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = DateTime.makeUnsafe("2026-10-21T01:08:00.000Z");
      const completedAt = DateTime.makeUnsafe("2026-10-21T01:08:34.708Z");
      const threadId = ThreadId.make("thread:delegated-result-hold");
      const childThreadId = ThreadId.make("thread:delegated-result-hold:child");
      const runId = RunId.make("run:delegated-result-hold");
      const rootNodeId = NodeId.make("node:delegated-result-hold:root");
      const taskId = NodeId.make("node:delegated-task:seal-merge-verifier-r5");
      const deliveryMessageId = MessageId.make("message:delegated-result-hold:delivery");

      yield* store.apply({
        id: EventId.make("event:delegated-result-hold:thread-created"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:delegated-result-hold"),
          title: "Coordinator",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      const run: OrchestrationV2Run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:delegated-result-hold:user"),
        rootNodeId,
        activeAttemptId: null,
        status: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      yield* store.apply({
        id: EventId.make("event:delegated-result-hold:run-created"),
        type: "run.created",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: run,
      });
      const task: OrchestrationV2Subagent = {
        id: taskId,
        threadId,
        runId,
        parentNodeId: rootNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver,
        providerInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Verify the merge",
        title: "Seal merge verifier",
        model: modelSelection.model,
        completionWake: "always",
        completionDelivery: { state: "pending", observedByRunId: null },
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      };
      const updateTask = (suffix: string, next: OrchestrationV2Subagent) =>
        store.apply({
          id: EventId.make(`event:delegated-result-hold:task:${suffix}`),
          type: "subagent.updated",
          threadId,
          runId,
          nodeId: taskId,
          driver,
          occurredAt: next.updatedAt,
          payload: next,
        });
      yield* updateTask("running", task);
      // The task finishes first and its result is claimed for a delivery run not yet created.
      yield* updateTask("completed", {
        ...task,
        status: "completed",
        result: "Verified.",
        completionDelivery: { state: "claimed", observedByRunId: null },
        completedAt,
        updatedAt: completedAt,
      });
      yield* store.apply({
        id: EventId.make("event:delegated-result-hold:run-completed"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: completedAt,
        payload: {
          ...run,
          status: "completed",
          completedAt,
          delegatedCompletion: {
            disposition: "open",
            nextGeneration: 2,
            delivery: { generation: 1, messageId: deliveryMessageId, taskIds: [taskId] },
          },
        },
      });

      const shellTasks = Effect.gen(function* () {
        const shell = yield* store.getThreadShell(threadId);
        const listed = (yield* store.getShellSnapshot()).threads.find(
          (candidate) => candidate.id === threadId,
        );
        assert.deepEqual(listed?.pendingBackgroundTasks, shell?.pendingBackgroundTasks);
        return shell?.pendingBackgroundTasks ?? [];
      });

      expect(yield* shellTasks).toEqual([
        expect.objectContaining({ kind: "subagent", childThreadId }),
      ]);

      // Every delivery state, in both directions: `pending` and `claimed` hold the parent;
      // `acknowledged`, `delivered` and `disposed` release it.
      const states = [
        ["pending", true],
        ["acknowledged", false],
        ["claimed", true],
        ["disposed", false],
        ["pending", true],
        ["delivered", false],
      ] as const;
      for (const [index, [state, holds]] of states.entries()) {
        const updatedAt = DateTime.makeUnsafe(
          DateTime.toEpochMillis(completedAt) + (index + 1) * 1_000,
        );
        yield* updateTask(`${state}:${index}`, {
          ...task,
          status: "completed",
          result: "Verified.",
          completionDelivery: { state, observedByRunId: null },
          completedAt,
          updatedAt,
        });
        expect({ state, tasks: yield* shellTasks }).toEqual({
          state,
          tasks: holds ? [expect.objectContaining({ kind: "subagent", childThreadId })] : [],
        });
      }
    }).pipe(Effect.provide(layer)),
);
