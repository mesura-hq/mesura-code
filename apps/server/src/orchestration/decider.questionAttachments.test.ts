import {
  ApprovalRequestId,
  EventId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const UPDATED_AT = "2026-01-01T00:00:00.000Z";

const readModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  threads: [
    {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Manual title",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      pullRequests: [],
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: UPDATED_AT,
      updatedAt: UPDATED_AT,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
  updatedAt: UPDATED_AT,
};

const requestId = ApprovalRequestId.make("question-request");
const command = {
  type: "thread.user-input.respond" as const,
  commandId: CommandId.make("answer"),
  threadId: ThreadId.make("thread-1"),
  requestId,
  answers: { q: "" },
  createdAt: UPDATED_AT,
  attachmentsByQuestionId: {
    q: [
      {
        type: "file" as const,
        id: "thread-1-00000000-0000-4000-8000-0000000000aa-txt",
        name: "spec.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
      },
    ],
  },
};
const request = {
  id: EventId.make("question"),
  kind: "user-input.requested",
  summary: "Question",
  tone: "info" as const,
  turnId: null,
  createdAt: UPDATED_AT,
  payload: {
    requestId,
    questions: [
      { id: "q", header: "Spec", question: "Provide a spec", options: [], allowCustomAnswer: true },
    ],
  },
};
const messageRequest = {
  ...request,
  payload: {
    ...request.payload,
    responseMode: "message",
    questions: [
      {
        ...request.payload.questions[0],
        options: [{ label: "Keep", description: "Keep it", value: "Keep" }],
      },
    ],
  },
} as const;
it.layer(NodeServices.layer)("question attachment answers", (it) => {
  it.effect("message-mode answer sends the choice and note in one user message", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        readModel,
        command: {
          ...command,
          answers: { q: ["Keep", "Add a migration note"] },
          attachmentsByQuestionId: undefined,
        },
        userInputActivity: messageRequest,
      });
      const events = Array.isArray(result) ? result : [result];
      const sentMessage = events.find((event) => event.type === "thread.message-sent");
      expect(sentMessage?.payload).toMatchObject({
        role: "user",
        text: expect.stringMatching(/Keep[\s\S]*Add a migration note/),
      });
    }),
  );
  it.effect("message-mode choice-only answers require the exact provider value", () =>
    Effect.gen(function* () {
      const value = " Keep\t";
      const choiceRequest = {
        ...messageRequest,
        payload: {
          ...messageRequest.payload,
          questions: [
            {
              id: "q",
              header: "Choice",
              question: "Choose",
              allowCustomAnswer: false,
              options: [{ label: "Keep", description: "Keep", value }],
            },
          ],
        },
      };
      for (const answer of ["Keep", [value, "A note"], "unknown"]) {
        const result = yield* decideOrchestrationCommand({
          readModel,
          command: { ...command, answers: { q: answer }, attachmentsByQuestionId: undefined },
          userInputActivity: choiceRequest,
        }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }
      const result = yield* decideOrchestrationCommand({
        readModel,
        command: { ...command, answers: { q: value }, attachmentsByQuestionId: undefined },
        userInputActivity: choiceRequest,
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.find((event) => event.type === "thread.message-sent")?.payload).toMatchObject({
        text: `Choose\n${value}`,
      });
    }),
  );
  it.effect("message-mode still sends a plain text answer", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        readModel,
        command: { ...command, answers: { q: "Keep" }, attachmentsByQuestionId: undefined },
        userInputActivity: messageRequest,
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.find((event) => event.type === "thread.message-sent")?.payload).toMatchObject({
        role: "user",
        text: "Provide a spec\nKeep",
      });
    }),
  );
  it.effect("persists the original answer with its attachment and emits a provider response", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        readModel,
        command,
        userInputActivity: request,
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.activity-appended",
        "thread.user-input-response-requested",
      ]);
      expect(events[0]?.payload).toMatchObject({
        activity: {
          kind: "user-input.answer-submitted",
          payload: { answers: { q: "" }, attachmentsByQuestionId: command.attachmentsByQuestionId },
        },
      });
      expect(events[1]?.payload).toMatchObject({
        answers: { q: "" },
        attachmentsByQuestionId: command.attachmentsByQuestionId,
      });
    }),
  );
  it.effect("rejects attachments for a resolved or unknown request", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({ readModel, command }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }),
  );
  it.effect("rejects unknown question IDs and predefined-choice-only protocols", () =>
    Effect.gen(function* () {
      for (const question of [
        { ...request.payload.questions[0], id: "other" },
        { ...request.payload.questions[0], allowCustomAnswer: false },
      ]) {
        const result = yield* decideOrchestrationCommand({
          readModel,
          command,
          userInputActivity: { ...request, payload: { ...request.payload, questions: [question] } },
        }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }
    }),
  );
});
