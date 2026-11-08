import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { withUndeliveredDelegatedResults } from "./undeliveredDelegatedResults.ts";

const at = DateTime.makeUnsafe("2026-10-21T01:08:34.708Z");
const finishedTask: OrchestrationV2Subagent = {
  id: NodeId.make("node:delegated-task:helper"),
  threadId: ThreadId.make("thread:helper"),
  runId: RunId.make("run:helper"),
  parentNodeId: NodeId.make("node:helper:root"),
  origin: "app_owned",
  createdBy: "agent",
  driver: ProviderDriverKind.make("claudeAgent"),
  providerInstanceId: ProviderInstanceId.make("claude"),
  providerThreadId: null,
  childThreadId: ThreadId.make("thread:helper:child"),
  nativeTaskRef: null,
  prompt: "Verify",
  title: "Verifier",
  model: null,
  completionDelivery: { state: "claimed", observedByRunId: null },
  status: "completed",
  result: "Done.",
  startedAt: at,
  completedAt: at,
  updatedAt: at,
};

const heldTaskIds = (input: Partial<Parameters<typeof withUndeliveredDelegatedResults>[0]>) =>
  withUndeliveredDelegatedResults({
    pendingBackgroundTasks: [],
    subagents: [finishedTask],
    latestRunStatus: "completed",
    hasActiveRun: false,
    ...input,
  }).map((task) => task.taskId);

describe("undelivered delegated results", () => {
  it("undelivered delegated results: an active parent run or an unsettled latest run adds nothing", () => {
    expect(heldTaskIds({})).toEqual([finishedTask.id]);
    expect(heldTaskIds({ hasActiveRun: true })).toEqual([]);
    for (const latestRunStatus of ["queued", "running", "rolled_back", "idle", null] as const) {
      expect({ latestRunStatus, held: heldTaskIds({ latestRunStatus }) }).toEqual({
        latestRunStatus,
        held: [],
      });
    }
  });

  it("undelivered delegated results: only finished app-owned tasks hold, each once", () => {
    expect(heldTaskIds({ subagents: [{ ...finishedTask, origin: "provider_native" }] })).toEqual(
      [],
    );
    expect(heldTaskIds({ subagents: [{ ...finishedTask, status: "running" }] })).toEqual([]);
    expect(
      heldTaskIds({
        pendingBackgroundTasks: [{ taskId: finishedTask.id, kind: "subagent" }],
      }),
    ).toEqual([finishedTask.id]);
  });
});
