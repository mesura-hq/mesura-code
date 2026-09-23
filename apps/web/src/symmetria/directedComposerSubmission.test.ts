import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { ApprovalRequestId } from "@t3tools/contracts";
import { assert, it } from "vite-plus/test";

import {
  consumeDirectedComposerDraft,
  createDirectedComposerExecutor,
  hasValidDirectedWorktreeSelection,
  prepareDirectedProviderPrompt,
  type DirectedComposerSubmission,
} from "./directedComposerSubmission";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useComposerDraftStore } from "../composerDraftStore";

const environmentId = EnvironmentId.make("environment-a");
const threadId = ThreadId.make("thread-a");
const commandId = CommandId.make("dictation-command-a");
const messageId = MessageId.make("dictation-message-a");

const normalSubmission = (
  overrides: Partial<DirectedComposerSubmission> = {},
): DirectedComposerSubmission => ({
  environmentId,
  threadId,
  commandId,
  messageId,
  createdAt: "2026-08-29T12:00:02.000Z",
  prompt: "typed context [voiced] dictated words",
  modelSelection: undefined,
  titleSeed: "typed context",
  runtimeMode: "full-access",
  interactionMode: "default",
  attachments: [],
  bootstrap: undefined,
  pendingAction: { kind: "composer" },
  ...overrides,
});

// Acceptance: the exact IDs and latest appended draft enter the existing
// thread.turn.start command.
it("submits an existing thread with fixed command and message identities", async () => {
  const starts: Array<unknown> = [];
  const executor = createDirectedComposerExecutor({
    startTurn: async (input) => {
      starts.push(input);
      return true;
    },
    answerQuestion: async () => true,
  });

  const result = await executor.submit(normalSubmission());

  assert.equal(result.kind, "turn-dispatched");
  const started = starts[0] as {
    environmentId: EnvironmentId;
    input: { commandId: CommandId; threadId: ThreadId; message: unknown };
  };
  assert.equal(started.environmentId, environmentId);
  assert.equal(started.input.commandId, commandId);
  assert.equal(started.input.threadId, threadId);
  assert.deepEqual(started.input.message, {
    messageId,
    role: "user",
    text: "typed context [voiced] dictated words",
    attachments: [],
  });
});

// Acceptance: new chat submission keeps the preallocated thread and bootstrap
// prepared by the normal composer path.
it("passes create-thread and prepare-worktree bootstrap for a reserved new chat", async () => {
  const starts: Array<{ input: { bootstrap?: unknown; threadId: ThreadId } }> = [];
  const executor = createDirectedComposerExecutor({
    startTurn: async (input) => {
      starts.push(input);
      return true;
    },
    answerQuestion: async () => true,
  });
  const bootstrap = {
    createThread: {
      projectId: ProjectId.make("project-a"),
      title: "New dictated thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: "main",
      worktreePath: null,
      createdAt: "2026-08-29T12:00:00.000Z",
    },
    prepareWorktree: {
      projectCwd: "/work/project-a",
      baseBranch: "main",
      branch: "worktree/dictation-command-a",
      startFromOrigin: true,
    },
    runSetupScript: true,
  };

  await executor.submit(normalSubmission({ bootstrap }));

  assert.deepEqual(starts[0]?.input.bootstrap, bootstrap);
  assert.equal(starts[0]?.input.threadId, threadId);
});

// Acceptance: a text question is answered, not turned into a provider turn.
it("submits dictated text as the pending question answer", async () => {
  const answers: Array<unknown> = [];
  let turnStarts = 0;
  const executor = createDirectedComposerExecutor({
    startTurn: async () => {
      turnStarts += 1;
      return true;
    },
    answerQuestion: async (input) => {
      answers.push(input);
      return true;
    },
  });

  const result = await executor.submit(
    normalSubmission({
      prompt: "[voiced] Buenos Aires",
      pendingAction: {
        kind: "text-question",
        requestId: ApprovalRequestId.make("question-request-a"),
        questionId: "city",
      },
    }),
  );

  assert.equal(result.kind, "answer-submitted");
  assert.equal(turnStarts, 0);
  const answered = answers[0] as {
    environmentId: EnvironmentId;
    input: {
      commandId: CommandId;
      threadId: ThreadId;
      requestId: string;
      answers: unknown;
    };
  };
  assert.equal(answered.environmentId, environmentId);
  assert.equal(answered.input.commandId, commandId);
  assert.equal(answered.input.threadId, threadId);
  assert.equal(answered.input.requestId, "question-request-a");
  assert.deepEqual(answered.input.answers, { city: "[voiced] Buenos Aires" });
});

// Acceptance: the plan follow-up uses the same mode decision as the composer.
it("submits current plan follow-up text in plan mode", async () => {
  const starts: Array<{ input: { interactionMode: string; message: { text: string } } }> = [];
  const executor = createDirectedComposerExecutor({
    startTurn: async (input) => {
      starts.push(input);
      return true;
    },
    answerQuestion: async () => true,
  });

  await executor.submit(
    normalSubmission({
      pendingAction: {
        kind: "plan-follow-up",
        planId: "plan-a",
        planMarkdown: "# Existing plan",
      },
    }),
  );

  assert.equal(starts[0]?.input.interactionMode, "plan");
  assert.equal(starts[0]?.input.message.text, "typed context [voiced] dictated words");
});

// Acceptance: free-form speech never chooses an enum approval decision.
it("refuses a button approval without dispatching text", async () => {
  let dispatches = 0;
  const executor = createDirectedComposerExecutor({
    startTurn: async () => {
      dispatches += 1;
      return true;
    },
    answerQuestion: async () => {
      dispatches += 1;
      return true;
    },
  });

  const result = await executor.submit(
    normalSubmission({ pendingAction: { kind: "button-approval" } }),
  );

  assert.deepEqual(result, { kind: "refused", code: "unsupported_composer_action" });
  assert.equal(dispatches, 0);
});

// Acceptance: a replay shares the first dispatch rather than creating another
// message or provider request.
it("dispatches one turn request for a repeated command identity", async () => {
  let starts = 0;
  const executor = createDirectedComposerExecutor({
    startTurn: async () => {
      starts += 1;
      return true;
    },
    answerQuestion: async () => true,
  });
  const submission = normalSubmission();

  const [first, replay] = await Promise.all([
    executor.submit(submission),
    executor.submit(submission),
  ]);

  assert.equal(starts, 1);
  assert.deepEqual(replay, first);
});

// Acceptance: dispatch failure stays a failure and cannot earn a success toast.
it("reports provider start failure after the user message was accepted", async () => {
  const executor = createDirectedComposerExecutor({
    startTurn: async () => false,
    answerQuestion: async () => true,
  });

  assert.deepEqual(await executor.submit(normalSubmission()), {
    kind: "provider-start-failed",
    messageId,
  });
});

it("allows an explicit broker retry to reuse an identity after provider start failed", async () => {
  let starts = 0;
  const executor = createDirectedComposerExecutor({
    startTurn: async () => {
      starts += 1;
      return starts > 1;
    },
    answerQuestion: async () => true,
  });
  const submission = normalSubmission();

  assert.equal((await executor.submit(submission)).kind, "provider-start-failed");
  assert.equal((await executor.submit(submission)).kind, "turn-dispatched");
  assert.equal(starts, 2);
});

it("submits the active later question with all existing answers", async () => {
  const answers: Array<
    Parameters<Parameters<typeof createDirectedComposerExecutor>[0]["answerQuestion"]>[0]
  > = [];
  const executor = createDirectedComposerExecutor({
    startTurn: async () => true,
    answerQuestion: async (input) => {
      answers.push(input);
      return true;
    },
  });
  const questions = [
    {
      id: "country",
      header: "Country",
      question: "Country?",
      options: [{ label: "Argentina", description: "Argentina" }],
      multiSelect: false,
    },
    {
      id: "city",
      header: "City",
      question: "City?",
      options: [{ label: "Buenos Aires", description: "Buenos Aires" }],
      multiSelect: false,
    },
  ];

  const result = await executor.submit(
    normalSubmission({
      prompt: "[voiced] Buenos Aires",
      pendingAction: {
        kind: "text-question",
        requestId: ApprovalRequestId.make("question-request-b"),
        questionId: "city",
        questions,
        draftAnswers: { country: { customAnswer: "Argentina" } },
        questionIndex: 1,
      },
    }),
  );

  assert.equal(result.kind, "answer-submitted");
  assert.deepEqual(answers[0]?.input.answers, {
    country: "Argentina",
    city: "[voiced] Buenos Aires",
  });
});

it("shares provider refusal, worktree guard, and successful draft consumption", () => {
  assert.deepEqual(
    prepareDirectedProviderPrompt("hello", {
      providerAvailable: false,
      provider: ProviderDriverKind.make("codex"),
      model: null,
      models: [],
      effort: null,
      pendingAction: { kind: "composer" },
    }),
    { ok: false },
  );
  assert.isFalse(
    hasValidDirectedWorktreeSelection({
      envMode: "worktree",
      worktreePath: null,
      branch: null,
    }),
  );

  const target = scopeThreadRef(environmentId, threadId);
  useComposerDraftStore.getState().setPrompt(target, "submitted prompt");
  consumeDirectedComposerDraft(target, null);

  assert.isNull(useComposerDraftStore.getState().getComposerDraft(target));
});

it("directed question submission combines dictation with exact selected values and enforces choice-only limits", async () => {
  const replies: unknown[] = [];
  const executor = createDirectedComposerExecutor({
    startTurn: async () => {
      assert.fail("Question answers must not start a normal turn");
    },
    answerQuestion: async (input) => {
      replies.push(input.input.answers);
      return true;
    },
  });
  const question = {
    id: "scope",
    header: "Scope",
    question: "Scope?",
    multiSelect: false,
    options: [{ label: "Workspace", description: "Workspace", value: " workspace\t" }],
  };
  for (const allowCustomAnswer of [true, false]) {
    const result = await executor.submit(
      normalSubmission({
        commandId: CommandId.make(`directed-note-${allowCustomAnswer}`),
        prompt: "[voiced] Keep files",
        pendingAction: {
          kind: "text-question",
          requestId: ApprovalRequestId.make("directed-choice"),
          questionId: "scope",
          questions: [{ ...question, allowCustomAnswer }],
          draftAnswers: { scope: { selectedOptionValues: [" workspace\t"] } },
          questionIndex: 0,
        },
      }),
    );
    assert.equal(result.kind, "answer-submitted");
  }
  assert.deepEqual(replies, [
    { scope: [" workspace\t", "[voiced] Keep files"] },
    { scope: " workspace\t" },
  ]);
  const result = await executor.submit(
    normalSubmission({
      commandId: CommandId.make("directed-note-without-choice"),
      prompt: "[voiced] Keep files",
      pendingAction: {
        kind: "text-question",
        requestId: ApprovalRequestId.make("directed-choice"),
        questionId: "scope",
        questions: [{ ...question, allowCustomAnswer: false }],
        draftAnswers: {},
        questionIndex: 0,
      },
    }),
  );
  assert.deepEqual(result, { kind: "refused", code: "unsupported_composer_action" });
  assert.equal(replies.length, 2);
});
