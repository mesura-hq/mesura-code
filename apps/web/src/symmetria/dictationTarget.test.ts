import { SymmetriaComposerDraftId } from "@symmetria/broker-contract";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { assert, it } from "vite-plus/test";

import { DraftId, createEmptyThreadDraft, useComposerDraftStore } from "../composerDraftStore";
import { captureDictationTarget, resolveDictationTarget } from "./dictationTarget";

const environmentId = EnvironmentId.make("environment-a");
const projectId = ProjectId.make("project-a");
const threadId = ThreadId.make("thread-a");
const futureThreadRef = scopeThreadRef(environmentId, threadId);
const draftId = DraftId.make("draft-a");

const draftSession = {
  threadId,
  environmentId,
  projectId,
  logicalProjectKey: "project-a",
  createdAt: "2026-08-29T12:00:00.000Z",
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  envMode: "local" as const,
  startFromOrigin: false,
  promotedTo: null,
};

// Acceptance: reservation captures all addressing information while the
// displayed composer still exists.
it("captures the exact scoped thread or draft and future thread reference", () => {
  const threadTarget = captureDictationTarget(futureThreadRef, null);
  const draftTarget = captureDictationTarget(draftId, draftSession);

  assert.deepEqual(threadTarget, {
    kind: "thread",
    environmentId,
    threadId,
  });
  assert.deepEqual(draftTarget, {
    kind: "draft",
    draftId: SymmetriaComposerDraftId.make(draftId),
    futureThreadRef,
  });
});

// Acceptance: a deleted or ambiguous draft cannot fall through to whichever
// composer happens to be visible.
it("fails closed when a reserved draft is removed or its future ref is ambiguous", () => {
  const target = captureDictationTarget(draftId, draftSession);
  if (target === null || target.kind !== "draft") throw new Error("invalid fixture");

  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  assert.deepEqual(
    resolveDictationTarget(target, useComposerDraftStore.getState(), () => false),
    {
      ok: false,
      reason: "missing-target",
    },
  );

  useComposerDraftStore.setState({
    draftsByThreadKey: {
      "draft-other-a": createEmptyThreadDraft(),
      "draft-other-b": createEmptyThreadDraft(),
    },
    draftThreadsByThreadKey: {
      "draft-other-a": { ...draftSession },
      "draft-other-b": { ...draftSession },
    },
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  assert.deepEqual(
    resolveDictationTarget(target, useComposerDraftStore.getState(), () => false),
    {
      ok: false,
      reason: "ambiguous-target",
    },
  );
});

it("uses exact thread existence instead of local composer-draft presence", () => {
  const threadTarget = captureDictationTarget(futureThreadRef, null);
  if (threadTarget === null) throw new Error("invalid fixture");
  const state = useComposerDraftStore.getState();

  assert.deepEqual(
    resolveDictationTarget(threadTarget, state, () => false),
    {
      ok: false,
      reason: "missing-target",
    },
  );
  assert.deepEqual(
    resolveDictationTarget(threadTarget, state, () => true),
    {
      ok: true,
      target: futureThreadRef,
      targetKey: scopedThreadKey(futureThreadRef),
      sourceTargetKey: null,
    },
  );
});

it("resolves a promoted draft even when the server composer is still empty", () => {
  const target = captureDictationTarget(draftId, draftSession);
  if (target === null) throw new Error("invalid fixture");
  useComposerDraftStore.setState({
    draftsByThreadKey: { [draftId]: createEmptyThreadDraft() },
    draftThreadsByThreadKey: {
      [draftId]: { ...draftSession, promotedTo: futureThreadRef },
    },
  });

  assert.deepEqual(
    resolveDictationTarget(target, useComposerDraftStore.getState(), () => true),
    {
      ok: true,
      target: futureThreadRef,
      targetKey: scopedThreadKey(futureThreadRef),
      sourceTargetKey: draftId,
    },
  );
});
