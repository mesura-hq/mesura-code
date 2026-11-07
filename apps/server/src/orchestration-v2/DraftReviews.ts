import {
  draftReviewQuestions,
  draftReviewRequestId,
  reviewedDraft,
  NodeId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

type Command = Extract<
  OrchestrationV2Command,
  { type: "draft-review.present" | "draft-review.reopen" }
>;

/** App-owned requests survive provider restarts and never complete a provider's root node. */
export function planDraftReview(
  command: Command,
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "turnItems" | "runtimeRequests">,
  ordinal: number,
  now: DateTime.Utc,
): Array<Omit<OrchestrationV2DomainEvent, "id" | "commandId">> {
  if (projection.thread.deletedAt !== null || projection.thread.archivedAt !== null)
    throw new Error("The thread is unavailable.");
  let draft;
  let requestId =
    command.type === "draft-review.present"
      ? draftReviewRequestId(command.threadId, command.requestKey)
      : command.requestId;
  const events: Array<Omit<OrchestrationV2DomainEvent, "id" | "commandId">> = [];
  if (command.type === "draft-review.reopen") {
    const item = projection.turnItems.find(
      (item) => item.type === "user_input_request" && item.requestId === command.requestId,
    );
    const request = projection.runtimeRequests.find((request) => request.id === command.requestId);
    if (
      item?.type !== "user_input_request" ||
      !item.draftReview ||
      !request ||
      request.status === "pending"
    )
      throw new Error("Only a closed draft can be reopened.");
    if (item.draftReviewRevisedBy) return [];
    draft = item.questionAnswer
      ? reviewedDraft(item.draftReview, item.questionAnswer.answers, request.decision === "cancel")
      : item.draftReview;
    requestId = RuntimeRequestId.make(`${command.requestId}:revision`);
    events.push({
      type: "turn-item.updated",
      threadId: command.threadId,
      occurredAt: now,
      payload: { ...item, draftReviewRevisedBy: requestId, updatedAt: now },
    });
  } else {
    draft = command.draft;
    const existing = projection.runtimeRequests.find((request) => request.id === requestId);
    if (existing) {
      const item = projection.turnItems.find(
        (item) => item.type === "user_input_request" && item.requestId === requestId,
      );
      if (
        item?.type === "user_input_request" &&
        JSON.stringify(item.draftReview) === JSON.stringify(draft)
      )
        return [];
      throw new Error("This request ID already belongs to another request.");
    }
  }
  const nodeId = NodeId.make(`draft:${requestId}`);
  events.push(
    {
      type: "node.updated",
      threadId: command.threadId,
      nodeId,
      occurredAt: now,
      payload: {
        id: nodeId,
        threadId: command.threadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: "user_input_request",
        status: "waiting",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: requestId,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      },
    },
    {
      type: "runtime-request.updated",
      threadId: command.threadId,
      nodeId,
      occurredAt: now,
      payload: {
        id: requestId,
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: null,
      },
    },
    {
      type: "turn-item.updated",
      threadId: command.threadId,
      nodeId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make(`draft:${requestId}`),
        threadId: command.threadId,
        runId: null,
        nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "waiting",
        title: draft.title,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "user_input_request",
        requestId,
        questions: draftReviewQuestions(draft),
        responseMode: "message",
        draftReview: draft,
      },
    },
  );
  return events;
}
