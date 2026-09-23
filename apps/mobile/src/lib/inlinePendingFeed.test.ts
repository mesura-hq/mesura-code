import { describe, expect, it } from "vite-plus/test";
import {
  ApprovalRequestId,
  EventId,
  MessageId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import {
  buildPendingUserInputAnswers,
  buildThreadFeed,
  deriveThreadFeedPresentation,
} from "./threadActivity";

const turnId = TurnId.make("inline-mobile-turn");
const requestId = ApprovalRequestId.make("inline-mobile-request");
const questionActivity: OrchestrationThreadActivity = {
  id: EventId.make("inline-mobile-question-activity"),
  kind: "user-input.requested",
  createdAt: "2026-09-23T10:00:02.000Z",
  turnId,
  summary: "User input requested",
  tone: "info",
  payload: {
    requestId,
    responseMode: "message",
    questions: [
      {
        id: "runtime",
        header: "Runtime",
        question: "Which runtime?",
        options: [{ label: "Go", description: "Portable" }],
        multiSelect: false,
      },
      { id: "scope", header: "Scope", question: "What scope?", options: [], multiSelect: false },
    ],
  },
};
const thread = {
  messages: [
    {
      id: MessageId.make("inline-mobile-message"),
      role: "user" as const,
      text: "Choose the implementation",
      streaming: false,
      turnId,
      createdAt: "2026-09-23T10:00:00.000Z",
      updatedAt: "2026-09-23T10:00:00.000Z",
    },
  ],
  activities: [questionActivity],
};

describe("mobile inline pending feed contract", () => {
  it("places one stable complete request row outside collapsed work and turn folds", () => {
    const first = buildThreadFeed(thread);
    const second = buildThreadFeed(thread);
    const pending = derivePendingRequests(thread.activities).userInputs[0];
    expect(pending?.questions.map((question) => question.id)).toEqual(["runtime", "scope"]);
    const pendingRows = (
      first as ReadonlyArray<{ type: string; id: string; pendingUserInput?: unknown }>
    ).filter((entry) => entry.type === "pending-user-input");
    expect(pendingRows).toHaveLength(1);
    expect(pendingRows[0]).toMatchObject({
      id: expect.stringContaining(requestId),
      pendingUserInput: { requestId, questions: pending?.questions },
    });
    expect(second.find((entry) => entry.id === pendingRows[0]?.id)).toEqual(pendingRows[0]);
    const presented = deriveThreadFeedPresentation(
      first,
      {
        turnId,
        state: "completed",
        startedAt: "2026-09-23T10:00:00.000Z",
        completedAt: "2026-09-23T10:00:03.000Z",
      },
      new Set(),
      new Set(),
    );
    expect(presented.some((entry) => entry.id === pendingRows[0]?.id)).toBe(true);
  });

  it("keeps each concurrent mobile request as a distinct chronological feed row", () => {
    const secondActivity: OrchestrationThreadActivity = {
      ...questionActivity,
      id: EventId.make("inline-mobile-second-question-activity"),
      createdAt: "2026-09-23T10:00:04.000Z",
      payload: {
        requestId: ApprovalRequestId.make("inline-mobile-second-request"),
        responseMode: "message",
        questions: derivePendingRequests([questionActivity]).userInputs[0]?.questions ?? [],
      },
    };
    const feed = buildThreadFeed({ ...thread, activities: [questionActivity, secondActivity] });
    expect(
      (feed as ReadonlyArray<{ type: string; id: string }>)
        .filter((entry) => entry.type === "pending-user-input")
        .map((entry) => entry.id),
    ).toEqual([
      expect.stringContaining(requestId),
      expect.stringContaining("inline-mobile-second-request"),
    ]);
  });

  it("guards the separate user message row and combined mobile answer draft", () => {
    expect(
      buildThreadFeed(thread).some(
        (entry) => entry.type === "message" && entry.id === thread.messages[0]?.id,
      ),
    ).toBe(true);
    const questions = derivePendingRequests(thread.activities).userInputs[0]!.questions;
    expect(
      buildPendingUserInputAnswers(questions, {
        runtime: { selectedOptionValues: ["Go"], customAnswer: "Prefer a small binary" },
        scope: { customAnswer: "Only the API" },
      }),
    ).toEqual({ runtime: ["Go", "Prefer a small binary"], scope: "Only the API" });
    expect(derivePendingRequests(thread.activities).userInputs[0]?.dismissible).toBe(true);
  });
});

it("mobile phase3 keeps an older pending request outside the loaded message window without duplicating work history", () => {
  const feed = buildThreadFeed(thread, {
    loadedMessages: [{ ...thread.messages[0]!, createdAt: "2026-09-23T11:00:00.000Z" }],
  });
  expect(feed.filter((entry) => entry.type === "pending-user-input")).toHaveLength(1);
  expect(buildThreadFeed(thread).filter((entry) => entry.type === "activity-group")).toHaveLength(
    0,
  );
});
