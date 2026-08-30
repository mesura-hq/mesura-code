import {
  SymmetriaDictationCommand,
  SymmetriaDictationSession,
  type SymmetriaDictationTarget,
} from "@symmetria/broker-contract";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import * as Schema from "effect/Schema";
import { beforeEach, assert, it, vi } from "vite-plus/test";

import {
  appendPersistedDictation,
  clearComposerDraftsEnvironment,
  createEmptyThreadDraft,
  DraftId,
  readPersistedDictationTarget,
  useComposerDraftStore,
} from "../composerDraftStore";
import { createDictationCoordinator } from "./dictationCoordinator";
import { captureDictationTarget } from "./dictationTarget";

const createTestCoordinator = (options: Parameters<typeof createDictationCoordinator>[0] = {}) =>
  createDictationCoordinator({ threadExists: () => true, ...options });

const environmentId = EnvironmentId.make("environment-a");
const otherEnvironmentId = EnvironmentId.make("environment-b");
const threadA = scopeThreadRef(environmentId, ThreadId.make("thread-a"));
const threadB = scopeThreadRef(environmentId, ThreadId.make("thread-b"));
const collidingThreadInOtherEnvironment = scopeThreadRef(
  otherEnvironmentId,
  ThreadId.make("thread-a"),
);
const targetA: SymmetriaDictationTarget = { kind: "thread", ...threadA };
const targetB: SymmetriaDictationTarget = { kind: "thread", ...threadB };

const reserveRequest = {
  protocolVersion: { major: 1 as const, minor: 2 },
  sessionId: "session-a",
  commandId: CommandId.make("command-reserve"),
  createdAt: "2026-08-29T12:00:00.000Z",
  source: "shell" as const,
};

const decodeCommand = Schema.decodeUnknownSync(SymmetriaDictationCommand);
const decodeSession = Schema.decodeUnknownSync(SymmetriaDictationSession);

const deliver = (
  mode: "clipboard" | "inject" | "submit" = "inject",
  sessionId = "session-a",
  target: SymmetriaDictationTarget = targetA,
  commandId = "command-deliver",
) => {
  const command = decodeCommand({
    type: "dictation.deliver",
    protocolVersion: { major: 1, minor: 2 },
    sessionId,
    commandId,
    createdAt: "2026-08-29T12:00:02.000Z",
    target,
    mode,
    text: "dictated words",
  });
  if (command.type !== "dictation.deliver") throw new Error("invalid delivery fixture");
  return command;
};

const promptAt = (target: typeof threadA): string | undefined =>
  useComposerDraftStore.getState().getComposerDraft(target)?.prompt;

beforeEach(async () => {
  await useComposerDraftStore.persist.clearStorage();
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    appliedDictationCommandsByTargetKey: {},
  });
});

// Acceptance: changing the route registration after reservation cannot retarget
// the delayed transcript.
it("keeps the reserved target after navigation to another thread", async () => {
  const coordinator = createTestCoordinator();
  coordinator.registerComposer({ target: targetA, projectName: "Project A", handle: null });
  await coordinator.reserve(reserveRequest);
  coordinator.registerComposer({ target: targetB, projectName: "Project B", handle: null });

  const receipt = await coordinator.deliver(deliver());

  assert.equal(receipt.outcome, "inserted");
  assert.equal(promptAt(threadA), "[voiced] dictated words");
  assert.isUndefined(promptAt(threadB));
});

it("does not retarget across environments whose thread ids collide", async () => {
  const otherTarget: SymmetriaDictationTarget = {
    kind: "thread",
    ...collidingThreadInOtherEnvironment,
  };
  useComposerDraftStore
    .getState()
    .setPrompt(collidingThreadInOtherEnvironment, "other environment");
  const coordinator = createTestCoordinator();
  coordinator.registerComposer({ target: targetA, projectName: "Project A", handle: null });
  await coordinator.reserve(reserveRequest);
  coordinator.registerComposer({ target: otherTarget, projectName: "Project B", handle: null });

  const receipt = await coordinator.deliver(deliver());

  assert.equal(receipt.outcome, "inserted");
  assert.equal(promptAt(threadA), "[voiced] dictated words");
  assert.equal(promptAt(collidingThreadInOtherEnvironment), "other environment");
});

it("fails closed when the reserved thread disappears and leaves the visible chat untouched", async () => {
  let targetAvailable = true;
  useComposerDraftStore.getState().setPrompt(threadB, "visible chat");
  const coordinator = createDictationCoordinator({ threadExists: () => targetAvailable });
  coordinator.registerComposer({ target: targetA, projectName: "Project A", handle: null });
  await coordinator.reserve(reserveRequest);
  coordinator.registerComposer({ target: targetB, projectName: "Project B", handle: null });
  targetAvailable = false;

  const receipt = await coordinator.deliver(deliver());

  assert.equal(receipt.outcome, "refused");
  if (receipt.outcome === "refused") assert.equal(receipt.code, "target_missing");
  assert.isUndefined(promptAt(threadA));
  assert.equal(promptAt(threadB), "visible chat");
});

it("retains only the newest session reservation and no stale composer handle", async () => {
  const coordinator = createTestCoordinator();
  coordinator.registerComposer({
    target: targetA,
    projectName: "Project A",
    handle: { replacePrompt: () => true },
  });
  await coordinator.reserve(reserveRequest);
  coordinator.registerComposer({ target: targetB, projectName: "Project B", handle: null });
  await coordinator.reserve({
    ...reserveRequest,
    sessionId: "session-b",
    commandId: CommandId.make("command-reserve-b"),
  });

  const stale = await coordinator.deliver(deliver("inject", "session-a", targetA));
  const current = await coordinator.deliver(
    deliver("inject", "session-b", targetB, "command-deliver-b"),
  );

  assert.equal(stale.outcome, "refused");
  assert.equal(current.outcome, "inserted");
  assert.isUndefined(promptAt(threadA));
  assert.equal(promptAt(threadB), "[voiced] dictated words");
});

// Acceptance: insert appends after the latest target text and keeps the same
// word boundary semantics as the mounted composer handle.
it("appends the voiced marker and transcript after the latest target text", async () => {
  useComposerDraftStore.getState().setPrompt(threadA, "typed context");
  const coordinator = createTestCoordinator();
  coordinator.registerComposer({ target: targetA, projectName: "Project A", handle: null });
  await coordinator.reserve(reserveRequest);

  await coordinator.deliver(deliver());

  assert.equal(promptAt(threadA), "typed context [voiced] dictated words");
});

// Acceptance: clipboard is a Shell action. The renderer acknowledges it but
// changes no draft.
it("leaves every composer unchanged in clipboard mode", async () => {
  useComposerDraftStore.getState().setPrompt(threadA, "keep A");
  useComposerDraftStore.getState().setPrompt(threadB, "keep B");
  const coordinator = createTestCoordinator();
  coordinator.registerComposer({ target: targetA, projectName: "Project A", handle: null });
  await coordinator.reserve(reserveRequest);

  const receipt = await coordinator.deliver(deliver("clipboard"));

  assert.equal(receipt.outcome, "copied");
  assert.equal(promptAt(threadA), "keep A");
  assert.equal(promptAt(threadB), "keep B");
});

it("marks a submitted pending answer for the Shell toast", async () => {
  const coordinator = createTestCoordinator({
    submit: async () => ({ kind: "answer-submitted" }),
  });
  coordinator.registerComposer({ target: targetA, projectName: "Project A", handle: null });
  await coordinator.reserve(reserveRequest);

  const receipt = await coordinator.deliver(deliver("submit"));

  assert.equal(receipt.outcome, "inserted");
  if (receipt.outcome !== "inserted") return;
  assert.equal(receipt.action, "answer");
});

it("reports a late correlated turn receipt after visible confirmation times out", async () => {
  const lateReceipts: Array<unknown> = [];
  let confirmations = 0;
  const messageId = MessageId.make("dictation-command-deliver");
  const coordinator = createTestCoordinator({
    submit: async () => ({ kind: "turn-dispatched", messageId }),
    confirm: async (identity, options) => {
      confirmations += 1;
      options?.onLateReceipt?.({
        outcome: "turn-running",
        protocolVersion: identity.protocolVersion,
        sessionId: identity.sessionId,
        commandId: identity.commandId,
        target: identity.target,
        application: "first",
        messageId,
        turnId: TurnId.make("turn-late"),
      });
      return {
        outcome: "confirmation-pending",
        protocolVersion: identity.protocolVersion,
        sessionId: identity.sessionId,
        commandId: identity.commandId,
        target: identity.target,
        application: "first",
      };
    },
    reportLateReceipt: (receipt) => lateReceipts.push(receipt),
  });
  coordinator.registerComposer({ target: targetA, projectName: "Project A", handle: null });
  await coordinator.reserve(reserveRequest);

  const receipt = await coordinator.deliver(deliver("submit"));
  const confirmingSession = decodeSession({
    protocolVersion: { major: 1, minor: 5 },
    sessionId: "session-a",
    target: targetA,
    source: "shell",
    phase: "confirming",
    mode: "submit",
    projectName: "Project A",
    startedAt: "2026-08-29T12:00:00.000Z",
    elapsedMs: 17_000,
    audioLevel: null,
    graceRemainingMs: null,
    presentation: { mesuraOwnsPresentation: false, leaseExpiresAt: null },
  });
  await coordinator.resumeConfirmation(confirmingSession, CommandId.make("command-deliver"));

  assert.equal(receipt.outcome, "confirmation-pending");
  assert.equal(confirmations, 1);
  assert.equal(lateReceipts.length, 1);
  assert.deepInclude(lateReceipts[0] as object, { outcome: "turn-running", turnId: "turn-late" });
});

// Acceptance: replay after a renderer reconnect cannot append a second copy.
it("applies one command identity only once", async () => {
  const firstCoordinator = createTestCoordinator();
  firstCoordinator.registerComposer({ target: targetA, projectName: "Project A", handle: null });
  await firstCoordinator.reserve(reserveRequest);
  const first = await firstCoordinator.deliver(deliver());

  const reconnectedCoordinator = createTestCoordinator();
  reconnectedCoordinator.registerComposer({
    target: targetA,
    projectName: "Project A",
    handle: null,
  });
  await reconnectedCoordinator.reserve(reserveRequest);
  const replay = await reconnectedCoordinator.deliver(deliver());

  assert.equal(first.application, "first");
  assert.equal(replay.application, "replay");
  assert.equal(promptAt(threadA), "[voiced] dictated words");
});

it("restores the broker reservation after a renderer restart before delivery", async () => {
  const coordinator = createTestCoordinator();
  coordinator.restoreSession(
    decodeSession({
      protocolVersion: { major: 1, minor: 4 },
      sessionId: deliver().sessionId,
      target: targetA,
      source: "shell",
      phase: "processing",
      mode: "inject",
      projectName: "Project A",
      startedAt: "2026-08-29T12:00:00.000Z",
      elapsedMs: 2_000,
      audioLevel: null,
      graceRemainingMs: null,
      presentation: { mesuraOwnsPresentation: false, leaseExpiresAt: null },
    }),
  );

  const receipt = await coordinator.deliver(deliver());

  assert.equal(receipt.outcome, "inserted");
  assert.equal(promptAt(threadA), "[voiced] dictated words");
});

it("does not erase captured submission context when its own broker snapshot returns", async () => {
  const capturedContext = {
    providerAvailable: true,
    provider: ProviderDriverKind.make("codex"),
    model: null,
    models: [],
    effort: null,
    pendingAction: { kind: "button-approval" as const },
  };
  let observedContext: unknown;
  const coordinator = createTestCoordinator({
    submit: async (input) => {
      observedContext = input.submissionContext;
      return { kind: "answer-submitted" };
    },
  });
  coordinator.registerComposer({
    target: targetA,
    projectName: "Project A",
    handle: null,
    readSubmissionContext: () => capturedContext,
  });
  await coordinator.reserve(reserveRequest);
  coordinator.restoreSession(
    decodeSession({
      protocolVersion: { major: 1, minor: 4 },
      sessionId: deliver().sessionId,
      target: targetA,
      source: "shell",
      phase: "recording",
      mode: "submit",
      projectName: "Project A",
      startedAt: "2026-08-29T12:00:00.000Z",
      elapsedMs: 0,
      audioLevel: null,
      graceRemainingMs: null,
      presentation: { mesuraOwnsPresentation: false, leaseExpiresAt: null },
    }),
  );
  coordinator.registerComposer({ target: targetB, projectName: "Project B", handle: null });

  await coordinator.deliver(deliver("submit"));

  assert.deepEqual(observedContext, capturedContext);
});

it("reattaches one confirmation watcher after a renderer reload", async () => {
  let confirmations = 0;
  const lateReceipts: Array<unknown> = [];
  const commandId = CommandId.make("command-deliver");
  const messageId = MessageId.make("dictation-command-deliver");
  const coordinator = createTestCoordinator({
    confirm: async (identity) => {
      confirmations += 1;
      return {
        outcome: "turn-running",
        protocolVersion: identity.protocolVersion,
        sessionId: identity.sessionId,
        commandId: identity.commandId,
        target: identity.target,
        application: "first",
        messageId,
        turnId: TurnId.make("turn-recovered"),
      };
    },
    reportLateReceipt: (receipt) => lateReceipts.push(receipt),
  });
  const confirmingSession = decodeSession({
    protocolVersion: { major: 1, minor: 5 },
    sessionId: "session-a",
    target: targetA,
    source: "shell",
    phase: "confirming",
    mode: "submit",
    projectName: "Project A",
    startedAt: "2026-08-29T12:00:00.000Z",
    elapsedMs: 17_000,
    audioLevel: null,
    graceRemainingMs: null,
    presentation: { mesuraOwnsPresentation: false, leaseExpiresAt: null },
  });

  await Promise.all([
    coordinator.resumeConfirmation(confirmingSession, commandId),
    coordinator.resumeConfirmation(confirmingSession, commandId),
  ]);

  assert.equal(confirmations, 1);
  assert.equal(lateReceipts.length, 1);
  assert.deepInclude(lateReceipts[0] as object, {
    outcome: "turn-running",
    commandId,
    messageId,
    turnId: "turn-recovered",
  });
});

// Acceptance: inserted is earned only after the forced persisted readback sees
// the exact command and resulting prompt.
it("emits inserted only after persistence confirms the exact append", async () => {
  const order: Array<string> = [];
  const coordinator = createTestCoordinator({
    append: async (target, commandId, text) => {
      order.push("append-start");
      const result = await appendPersistedDictation(target, commandId, text);
      order.push(result.ok ? "persisted" : "failed");
      return result;
    },
  });
  coordinator.registerComposer({ target: targetA, projectName: "Project A", handle: null });
  await coordinator.reserve(reserveRequest);

  const receipt = await coordinator.deliver(deliver());
  order.push(receipt.outcome);

  assert.deepEqual(order, ["append-start", "persisted", "inserted"]);
  const targetKey = scopedThreadKey(threadA);
  const persisted = await readPersistedDictationTarget(targetKey);
  assert.equal(persisted?.prompt, "[voiced] dictated words");
  assert.equal(persisted?.applications[0]?.commandId, "command-deliver");
});

it("reports persistence failure without writing to another composer", async () => {
  useComposerDraftStore.getState().setPrompt(threadB, "visible chat");
  const coordinator = createTestCoordinator({
    append: async () => ({
      ok: false,
      reason: "persistence-failed",
      stage: "persisted-state-missing",
      persistedBytes: 0,
    }),
    reportPersistenceFailure: () => undefined,
  });
  coordinator.registerComposer({ target: targetA, projectName: "Project A", handle: null });
  await coordinator.reserve(reserveRequest);
  coordinator.registerComposer({ target: targetB, projectName: "Project B", handle: null });

  const receipt = await coordinator.deliver(deliver());

  assert.equal(receipt.outcome, "failed");
  if (receipt.outcome === "failed") assert.equal(receipt.code, "persistence_failed");
  assert.isUndefined(promptAt(threadA));
  assert.equal(promptAt(threadB), "visible chat");
});

it("maps a precise persistence stage without starting the provider", async () => {
  const submit = vi.fn(async () => ({
    kind: "turn-dispatched" as const,
    messageId: MessageId.make("must-not-dispatch"),
  }));
  const reportPersistenceFailure = vi.fn();
  const coordinator = createTestCoordinator({
    append: async () => ({
      ok: false,
      reason: "persistence-failed",
      stage: "command-missing",
      persistedBytes: 512,
      expectedPromptHash: "a".repeat(64),
    }),
    submit,
    reportPersistenceFailure,
  });
  coordinator.registerComposer({ target: targetA, projectName: "Project A", handle: null });
  await coordinator.reserve(reserveRequest);

  const receipt = await coordinator.deliver(deliver("submit"));

  assert.equal(receipt.outcome, "failed");
  if (receipt.outcome !== "failed") return;
  assert.equal(receipt.code, "persistence_failed");
  assert.equal(receipt.detail, "dictation persistence verification failed at command-missing");
  assert.equal(submit.mock.calls.length, 0);
  assert.deepEqual(reportPersistenceFailure.mock.calls[0]?.[0], {
    event: "symmetria.dictation.persistence.failed",
    sessionId: "session-a",
    commandId: "command-deliver",
    target: targetA,
    stage: "command-missing",
    persistedBytes: 512,
    expectedPromptHash: "a".repeat(64),
  });
});

it("keeps transcript and draft text out of persistence diagnostics", async () => {
  const diagnostics: Array<unknown> = [];
  const coordinator = createTestCoordinator({
    append: async () => ({
      ok: false,
      reason: "persistence-failed",
      stage: "prompt-mismatch",
      persistedBytes: 128,
      expectedPromptHash: "b".repeat(64),
      actualPromptHash: "c".repeat(64),
    }),
    reportPersistenceFailure: (event) => diagnostics.push(event),
  });
  coordinator.registerComposer({ target: targetA, projectName: "Project A", handle: null });
  await coordinator.reserve(reserveRequest);

  await coordinator.deliver(deliver("submit"));

  const serialized = JSON.stringify(diagnostics);
  assert.notInclude(serialized, "dictated words");
  assert.notInclude(serialized, "[voiced]");
  assert.notInclude(serialized, "stale prompt text");
  assert.include(serialized, "prompt-mismatch");
});

it("keeps the persistence result stable when diagnostic hashing fails", async () => {
  const submit = vi.fn(async () => ({
    kind: "turn-dispatched" as const,
    messageId: MessageId.make("must-not-dispatch-after-hash-failure"),
  }));
  const diagnostics: Array<unknown> = [];
  const coordinator = createTestCoordinator({
    append: (target, commandId, text, sourceTargetKey) =>
      appendPersistedDictation(target, commandId, text, sourceTargetKey, {
        flush: () => {
          throw new DOMException("quota exceeded", "QuotaExceededError");
        },
        readRaw: () => null,
        hashText: async () => {
          throw new Error("digest unavailable");
        },
      }),
    submit,
    reportPersistenceFailure: (event) => diagnostics.push(event),
  });
  coordinator.registerComposer({ target: targetA, projectName: "Project A", handle: null });
  await coordinator.reserve(reserveRequest);

  const receipt = await coordinator.deliver(deliver("submit"));

  assert.equal(receipt.outcome, "failed");
  if (receipt.outcome !== "failed") return;
  assert.equal(receipt.code, "persistence_failed");
  assert.include(receipt.detail, "storage-write-failed");
  assert.equal(submit.mock.calls.length, 0);
  assert.deepInclude(diagnostics[0] as object, { stage: "storage-write-failed" });
  assert.notProperty(diagnostics[0] as object, "expectedPromptHash");
});

it("isolates a throwing persistence reporter from delivery behavior", async () => {
  const submit = vi.fn(async () => ({
    kind: "turn-dispatched" as const,
    messageId: MessageId.make("must-not-dispatch-after-reporter-failure"),
  }));
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const coordinator = createTestCoordinator({
      append: async () => ({
        ok: false,
        reason: "persistence-failed",
        stage: "storage-read-failed",
        persistedBytes: 0,
      }),
      submit,
      reportPersistenceFailure: () => {
        throw new Error("reporter unavailable");
      },
    });
    coordinator.registerComposer({ target: targetA, projectName: "Project A", handle: null });
    await coordinator.reserve(reserveRequest);

    const receipt = await coordinator.deliver(deliver("submit"));

    assert.equal(receipt.outcome, "failed");
    if (receipt.outcome !== "failed") return;
    assert.equal(receipt.code, "persistence_failed");
    assert.include(receipt.detail, "storage-read-failed");
    assert.equal(submit.mock.calls.length, 0);
    assert.equal(
      consoleError.mock.calls[0]?.[0],
      "symmetria.dictation.persistence.reporter-failed",
    );
  } finally {
    consoleError.mockRestore();
  }
});

it("retries provider start with one persisted append and the original message identity", async () => {
  let submissions = 0;
  const messageId = MessageId.make("dictation-command-deliver");
  const coordinator = createTestCoordinator({
    submit: async () => {
      submissions += 1;
      return submissions === 1
        ? { kind: "provider-start-failed", messageId }
        : { kind: "turn-dispatched", messageId };
    },
    confirm: async (identity) => ({
      outcome: "turn-running",
      protocolVersion: identity.protocolVersion,
      sessionId: identity.sessionId,
      commandId: identity.commandId,
      target: identity.target,
      application: "first",
      messageId,
      turnId: TurnId.make("turn-retry"),
    }),
  });
  coordinator.registerComposer({ target: targetA, projectName: "Project A", handle: null });
  await coordinator.reserve(reserveRequest);
  const command = deliver("submit");

  const failed = await coordinator.deliver(command);
  const retried = await coordinator.deliver(command);

  assert.equal(failed.outcome, "failed");
  assert.equal(retried.outcome, "turn-running");
  assert.equal(submissions, 2);
  assert.equal(promptAt(threadA), "[voiced] dictated words");
  assert.equal(retried.commandId, command.commandId);
  if (retried.outcome === "turn-running") assert.equal(retried.messageId, messageId);
});

it("carries the latest draft text across promotion before appending", async () => {
  const draftId = DraftId.make("draft-promoting");
  const draftSession = {
    threadId: threadA.threadId,
    environmentId,
    projectId: ProjectId.make("project-a"),
    logicalProjectKey: "project-a",
    createdAt: "2026-08-29T12:00:00.000Z",
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    envMode: "local" as const,
    startFromOrigin: false,
    promotedTo: threadA,
  };
  const target = captureDictationTarget(draftId, draftSession);
  if (target === null) throw new Error("invalid promoted target fixture");
  useComposerDraftStore.setState({
    draftsByThreadKey: {
      [draftId]: { ...createEmptyThreadDraft(), prompt: "latest text after send" },
    },
    draftThreadsByThreadKey: { [draftId]: draftSession },
  });
  const coordinator = createTestCoordinator();
  coordinator.registerComposer({ target, projectName: "Project A", handle: null });
  await coordinator.reserve(reserveRequest);

  const receipt = await coordinator.deliver(deliver("inject", "session-a", target));

  const expected = "latest text after send [voiced] dictated words";
  assert.equal(receipt.outcome, "inserted");
  assert.equal(useComposerDraftStore.getState().draftsByThreadKey[draftId]?.prompt, expected);
  assert.equal(
    useComposerDraftStore.getState().draftsByThreadKey[scopedThreadKey(threadA)]?.prompt,
    expected,
  );
});

it("submits a promoted draft through its preallocated thread identity", async () => {
  const draftId = DraftId.make("draft-promoted-submit");
  const draftSession = {
    threadId: threadA.threadId,
    environmentId,
    projectId: ProjectId.make("project-a"),
    logicalProjectKey: "project-a",
    createdAt: "2026-08-29T12:00:00.000Z",
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    envMode: "local" as const,
    startFromOrigin: false,
    promotedTo: threadA,
  };
  const target = captureDictationTarget(draftId, draftSession);
  if (target === null) throw new Error("invalid promoted submit fixture");
  useComposerDraftStore.setState({
    draftsByThreadKey: {
      [draftId]: { ...createEmptyThreadDraft(), prompt: "typed before promotion" },
    },
    draftThreadsByThreadKey: { [draftId]: draftSession },
  });
  const submissions: Array<{ composerTarget: unknown; sourceComposerTarget?: unknown }> = [];
  const messageId = MessageId.make("dictation-command-deliver");
  const coordinator = createTestCoordinator({
    submit: async (input) => {
      submissions.push(input);
      return { kind: "turn-dispatched", messageId };
    },
    confirm: async (identity) => ({
      outcome: "turn-running",
      protocolVersion: identity.protocolVersion,
      sessionId: identity.sessionId,
      commandId: identity.commandId,
      target: identity.target,
      application: "first",
      messageId,
      turnId: TurnId.make("turn-promoted"),
    }),
  });
  coordinator.registerComposer({ target, projectName: "Project A", handle: null });
  await coordinator.reserve(reserveRequest);

  const receipt = await coordinator.deliver(deliver("submit", "session-a", target));

  assert.equal(receipt.outcome, "turn-running");
  assert.deepEqual(submissions[0]?.composerTarget, threadA);
  assert.equal(submissions[0]?.sourceComposerTarget, draftId);
  assert.equal(promptAt(threadA), "typed before promotion [voiced] dictated words");
});

it("bounds command history across targets and removes an environment ledger", async () => {
  for (let index = 0; index < 132; index += 1) {
    const target = scopeThreadRef(environmentId, ThreadId.make(`thread-ledger-${index}`));
    const result = await appendPersistedDictation(
      target,
      CommandId.make(`command-ledger-${index}`),
      `text ${index}`,
    );
    assert.isTrue(result.ok);
  }
  assert.isAtMost(
    Object.keys(useComposerDraftStore.getState().appliedDictationCommandsByTargetKey).length,
    128,
  );

  clearComposerDraftsEnvironment(environmentId);

  assert.deepEqual(useComposerDraftStore.getState().appliedDictationCommandsByTargetKey, {});
});
