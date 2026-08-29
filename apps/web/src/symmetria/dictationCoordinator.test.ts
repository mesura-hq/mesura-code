import {
  SymmetriaDictationCommand,
  type SymmetriaDictationTarget,
} from "@symmetria/broker-contract";
import { CommandId, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import * as Schema from "effect/Schema";
import { beforeEach, assert, it } from "vite-plus/test";

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
const threadA = scopeThreadRef(environmentId, ThreadId.make("thread-a"));
const threadB = scopeThreadRef(environmentId, ThreadId.make("thread-b"));
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
