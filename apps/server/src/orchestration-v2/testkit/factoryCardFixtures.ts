/**
 * Mesura: fixtures for the Software Factory card tests. They write v2
 * projection rows through `ProjectionStoreV2.apply`, the path the event sink
 * takes, so the tests read what production stores.
 */
import {
  EventId,
  factoryRunActivityId,
  type FactoryRunActivityPayload,
  type FactoryRunStatus,
  type FactoryThreadCard,
  type ModelSelection,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { emptyFactoryRunState, summarizeFactoryRun } from "@t3tools/shared/factoryRun";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ProjectionStore from "../ProjectionStore.ts";

export const FIXTURE_EPOCH = DateTime.makeUnsafe("2026-10-11T00:00:00.000Z");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" } satisfies ModelSelection;

/** A run of `threadId`; `ordinal` orders runs, `status` defaults to a finished run. */
export function fixtureRun(
  threadId: ThreadId,
  ordinal: number,
  status: OrchestrationV2Run["status"] = "completed",
): OrchestrationV2Run {
  return {
    id: RunId.make(`run:${threadId}:${ordinal}`),
    threadId,
    ordinal,
    providerInstanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message:${threadId}:${ordinal}`),
    rootNodeId: NodeId.make(`node:${threadId}:${ordinal}`),
    activeAttemptId: null,
    status,
    requestedAt: FIXTURE_EPOCH,
    startedAt: FIXTURE_EPOCH,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
}

/** The `factory.run` payload of a run that has not started, with `status` set. */
export function fixtureRunPayload(
  threadId: ThreadId,
  runId: string,
  status: FactoryRunStatus = "running",
): FactoryRunActivityPayload {
  return {
    threadId,
    ...summarizeFactoryRun(emptyFactoryRunState(`/runs/${runId}`)),
    runId,
    status,
  };
}

/** A stored run card, as `factory_card.record` would leave it. */
export function fixtureRunCardItem(input: {
  readonly threadId: ThreadId;
  readonly runId: string;
  readonly status?: FactoryRunStatus;
  readonly updatedAt?: DateTime.Utc;
}): OrchestrationV2TurnItem {
  return fixtureCardItem({
    id: TurnItemId.make(factoryRunActivityId(input.threadId, input.runId)),
    threadId: input.threadId,
    card: { kind: "run", payload: fixtureRunPayload(input.threadId, input.runId, input.status) },
    ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
  });
}

export function fixtureCardItem(input: {
  readonly id: TurnItemId;
  readonly threadId: ThreadId;
  readonly card: FactoryThreadCard;
  readonly updatedAt?: DateTime.Utc;
}): OrchestrationV2TurnItem {
  const updatedAt = input.updatedAt ?? FIXTURE_EPOCH;
  return {
    id: input.id,
    threadId: input.threadId,
    runId: RunId.make(`run:${input.threadId}:1`),
    nodeId: NodeId.make(`node:${input.threadId}:1`),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: input.card.kind,
    startedAt: updatedAt,
    completedAt: updatedAt,
    updatedAt,
    type: "factory_card",
    card: input.card,
  };
}

/** Writes a thread, archived or deleted when asked, and returns its id. */
export const applyFixtureThread = Effect.fn("applyFixtureThread")(function* (
  name: string,
  options: { readonly archived?: boolean; readonly deleted?: boolean } = {},
) {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = ThreadId.make(`thread:${name}`);
  yield* projectionStore.apply({
    id: EventId.make(`event:${name}:thread-created`),
    type: "thread.created",
    threadId,
    occurredAt: FIXTURE_EPOCH,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project:factory-cards"),
      title: name,
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: FIXTURE_EPOCH,
      updatedAt: FIXTURE_EPOCH,
      archivedAt: options.archived === true ? FIXTURE_EPOCH : null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: options.deleted === true ? FIXTURE_EPOCH : null,
    },
  });
  return threadId;
});

/** Writes a turn item the way the event sink does. */
export const applyFixtureItem = Effect.fn("applyFixtureItem")(function* (
  item: OrchestrationV2TurnItem,
) {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  yield* projectionStore.apply({
    id: EventId.make(`event:${item.id}:${DateTime.formatIso(item.updatedAt)}`),
    type: "turn-item.updated",
    threadId: item.threadId,
    occurredAt: item.updatedAt,
    payload: item,
  });
});
