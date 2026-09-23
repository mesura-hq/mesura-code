import { createPendingUserInputProjection } from "../../pendingUserInput";
import { expect, it } from "vite-plus/test";
import { ApprovalRequestId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { deriveTimelineEntries } from "../../session-logic";
import type { ChatMessage } from "../../types";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";

const createdAt = "2026-09-22T12:00:00.000Z";
const message: ChatMessage = {
  id: MessageId.make("phase-two-message"),
  role: "user",
  text: "Please inspect this",
  turnId: null,
  createdAt,
  updatedAt: createdAt,
  streaming: false,
};
const request = {
  requestId: ApprovalRequestId.make("phase-two-request"),
  createdAt: "2026-09-22T12:00:01.000Z",
  dismissible: true,
  questions: [
    {
      id: "scope",
      header: "Scope",
      question: "Which scope?",
      multiSelect: false,
      options: [{ label: "Workspace", description: "Current workspace" }],
    },
  ],
};

function project(environmentId: EnvironmentId, threadId: ThreadId, includeActivity: boolean) {
  const input = {
    timelineEntries: deriveTimelineEntries(
      [message],
      [],
      includeActivity
        ? [
            {
              id: "phase-two-activity",
              turnId: null,
              createdAt: request.createdAt,
              label: "Requested user input",
              tone: "info" as const,
              sourceActivityKind: "user-input.requested",
            },
          ]
        : [],
    ),
    latestTurn: null,
    runningTurnId: null,
    isWorking: false,
    activeTurnStartedAt: null,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    environmentId,
    threadId,
    pendingUserInputs: [request],
  };
  return deriveMessagesTimelineRows(
    input as unknown as Parameters<typeof deriveMessagesTimelineRows>[0],
  );
}

it("phase two timeline projects one scoped question row at its activity or visible tail", () => {
  const environmentId = EnvironmentId.make("phase-two-environment");
  const threadId = ThreadId.make("phase-two-thread");
  const activityRows = project(environmentId, threadId, true);
  const tailRows = project(environmentId, threadId, false);
  const pendingRows = activityRows.filter((row) => String(row.kind) === "pending-user-input");
  expect(pendingRows).toHaveLength(1);
  expect(tailRows.filter((row) => String(row.kind) === "pending-user-input")).toHaveLength(1);
  expect(activityRows.indexOf(pendingRows[0]!)).toBeGreaterThan(
    activityRows.findIndex((row) => row.kind === "message"),
  );
  expect(tailRows.at(-1)?.kind).toBe("pending-user-input");
  expect(
    project(EnvironmentId.make("other"), threadId, true).find(
      (row) => String(row.kind) === "pending-user-input",
    )?.id,
  ).not.toBe(pendingRows[0]?.id);
  expect(
    project(environmentId, ThreadId.make("other"), true).find(
      (row) => String(row.kind) === "pending-user-input",
    )?.id,
  ).not.toBe(pendingRows[0]?.id);
});

it("phase two guard retains a user message row when no request is pending", () => {
  const rows = deriveMessagesTimelineRows({
    timelineEntries: deriveTimelineEntries([message], [], []),
    latestTurn: null,
    runningTurnId: null,
    isWorking: false,
    activeTurnStartedAt: null,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
  });
  expect(rows.filter((row) => row.kind === "message")).toHaveLength(1);
  expect(rows.find((row) => row.kind === "message")?.id).toBe(message.id);
});

it("phase two rework retains pending projection identities through unrelated activity refreshes", () => {
  const project = createPendingUserInputProjection();
  const empty = project([]);
  expect(project([])).toBe(empty);
  const first = project([request]);
  expect(
    project([{ ...request, questions: request.questions.map((question) => ({ ...question })) }]),
  ).toBe(first);
  const changed = project([
    { ...request, questions: [{ ...request.questions[0]!, question: "Changed prompt" }] },
  ]);
  expect(changed).not.toBe(first);
  expect(project([])).toBe(empty);
});
