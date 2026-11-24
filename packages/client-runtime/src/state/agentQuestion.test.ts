/**
 * Entry points: `isThreadWorking` and `createInboxReturnTracker`, which place threads in the
 * Working section. Mirrors the 2026-11-01 thread whose agent asked a question, delegated two
 * tasks and ended its turn, then ran again when a task finished.
 */
import {
  EnvironmentId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type FactoryRunShellSummary,
  type ThreadAgentSignal,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createInboxReturnTracker, isThreadWorking } from "./threadInbox.ts";

const needsInput: ThreadAgentSignal = {
  kind: "needs_input",
  note: "How do we upload the 545 MB RAR?",
  runId: RunId.make("run-question"),
  setAt: "2026-11-01T05:16:37.006Z",
};

const stoppedFactoryRun: FactoryRunShellSummary = {
  status: "stopped",
  phaseIndex: 2,
  phaseCount: 13,
  node: "fence",
  askedAt: "2026-11-23T13:34:00.821Z",
};

function thread(
  runtimeStatus: "running" | "waiting" | "queued" | "idle" | "completed",
  agentSignal: ThreadAgentSignal | null = needsInput,
  factory: {
    readonly factoryRun?: FactoryRunShellSummary | null;
    readonly latestUserAuthoredMessageAt?: string | null;
  } = {},
) {
  return {
    ...factory,
    id: ThreadId.make("thread-question"),
    environmentId: EnvironmentId.make("environment-1"),
    createdAt: "2026-11-01T05:00:00.000Z",
    unsettledAt: null,
    latestRun: null,
    agentSignal,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    runtime: {
      status: runtimeStatus,
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      providerName: "Claude",
      lastError: null,
      updatedAt: "2026-11-01T05:16:54.000Z",
    },
  };
}

describe("an agent's open question in the Working section", () => {
  it("releases a thread whose agent asked and now only waits on background work", () => {
    expect(isThreadWorking(thread("waiting"))).toBe(false);
    expect(isThreadWorking(thread("idle"))).toBe(false);
    expect(isThreadWorking(thread("waiting", null))).toBe(true);
  });

  it("keeps a thread whose agent executes a later turn with the question still open", () => {
    expect(isThreadWorking(thread("running"))).toBe(true);
    expect(isThreadWorking(thread("queued"))).toBe(true);
  });

  it("ignores a ready_to_close signal", () => {
    expect(isThreadWorking(thread("waiting", { ...needsInput, kind: "ready_to_close" }))).toBe(
      true,
    );
  });

  it("treats a stopped Factory run as a question until the user writes after it", () => {
    expect(isThreadWorking(thread("waiting", null, { factoryRun: stoppedFactoryRun }))).toBe(false);
    expect(
      isThreadWorking(
        thread("waiting", null, {
          factoryRun: stoppedFactoryRun,
          latestUserAuthoredMessageAt: "2026-11-24T18:12:15.377Z",
        }),
      ),
    ).toBe(true);
  });

  it("leaves the section at once when the question starts waiting, without the exit grace", () => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("running")]);
    const observed = tracker.observe([thread("waiting")]);
    expect(observed.isWorking(thread("waiting"))).toBe(false);
    expect(observed.returnedAt(thread("waiting"))).toBeDefined();
  });
});
