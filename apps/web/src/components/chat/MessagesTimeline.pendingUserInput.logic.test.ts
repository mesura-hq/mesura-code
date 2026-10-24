import {
  EnvironmentId,
  MessageId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import { createPendingUserInputProjection } from "../../pendingUserInput";
import {
  deriveTimelineEntriesFromVisibleTurnItems,
  type PendingUserInput,
} from "../../session-logic";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";

const startedAt = DateTime.makeUnsafe("2026-09-22T12:00:00.000Z");
const requestedAt = DateTime.makeUnsafe("2026-09-22T12:00:01.000Z");
const itemThreadId = ThreadId.make("phase-two-thread");
const runId = RunId.make("phase-two-run");
const requestId = RuntimeRequestId.make("phase-two-request");

const base = (id: string, ordinal: number, at: DateTime.Utc) => ({
  id: TurnItemId.make(id),
  threadId: itemThreadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed" as const,
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
});
const userItem = {
  ...base("phase-two-message", 0, startedAt),
  type: "user_message" as const,
  messageId: MessageId.make("phase-two-message"),
  inputIntent: "turn_start" as const,
  text: "Please inspect this",
  attachments: [],
  createdBy: "user" as const,
  creationSource: "web" as const,
} satisfies OrchestrationV2TurnItem;
const question = {
  id: "scope",
  header: "Scope",
  question: "Which scope?",
  multiSelect: false,
  options: [{ label: "Workspace", description: "Current workspace" }],
};
const requestItem = {
  ...base("phase-two-request-item", 1, requestedAt),
  status: "running" as const,
  type: "user_input_request" as const,
  requestId,
  questions: [question],
} satisfies OrchestrationV2TurnItem;
const request: PendingUserInput = {
  requestId,
  createdAt: DateTime.formatIso(requestedAt),
  dismissible: true,
  responseCapability: "live",
  questions: [question],
};

function entriesFor(items: ReadonlyArray<OrchestrationV2TurnItem>) {
  return deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: items.map((item, position) => ({
      item,
      position,
      visibility: "local" as const,
      sourceThreadId: item.threadId,
      sourceItemId: item.id,
    })),
    optimisticMessages: [],
  });
}

function project(environmentId: EnvironmentId, threadId: ThreadId, includeRequestItem: boolean) {
  return deriveMessagesTimelineRows({
    timelineEntries: entriesFor(includeRequestItem ? [userItem, requestItem] : [userItem]),
    isWorking: false,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    environmentId,
    threadId,
    pendingUserInputs: [request],
  });
}

it("projects one scoped question row in place of its request item, or at the visible tail", () => {
  const environmentId = EnvironmentId.make("phase-two-environment");
  const threadId = ThreadId.make("phase-two-thread");
  const itemRows = project(environmentId, threadId, true);
  const tailRows = project(environmentId, threadId, false);
  const pendingRows = itemRows.filter((row) => row.kind === "pending-user-input");
  expect(pendingRows).toHaveLength(1);
  expect(tailRows.filter((row) => row.kind === "pending-user-input")).toHaveLength(1);
  // The request's own work row gives way to the card.
  expect(itemRows.some((row) => row.kind === "work")).toBe(false);
  expect(itemRows.indexOf(pendingRows[0]!)).toBeGreaterThan(
    itemRows.findIndex((row) => row.kind === "message"),
  );
  expect(tailRows.at(-1)?.kind).toBe("pending-user-input");
  expect(
    project(EnvironmentId.make("other"), threadId, true).find(
      (row) => row.kind === "pending-user-input",
    )?.id,
  ).not.toBe(pendingRows[0]?.id);
  expect(
    project(environmentId, ThreadId.make("other"), true).find(
      (row) => row.kind === "pending-user-input",
    )?.id,
  ).not.toBe(pendingRows[0]?.id);
});

it("retains a user message row when no request is pending", () => {
  const rows = deriveMessagesTimelineRows({
    timelineEntries: entriesFor([userItem]),
    isWorking: false,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
  });
  expect(rows.filter((row) => row.kind === "message")).toHaveLength(1);
});

it("retains pending projection identities through unrelated thread refreshes", () => {
  const projectRequests = createPendingUserInputProjection();
  const empty = projectRequests([]);
  expect(projectRequests([])).toBe(empty);
  const first = projectRequests([request]);
  expect(
    projectRequests([{ ...request, questions: request.questions.map((entry) => ({ ...entry })) }]),
  ).toBe(first);
  const changed = projectRequests([
    { ...request, questions: [{ ...request.questions[0]!, question: "Changed prompt" }] },
  ]);
  expect(changed).not.toBe(first);
  expect(projectRequests([])).toBe(empty);
});
