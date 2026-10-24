// Entry point: `presentThreadShell` (models.ts), the function every client runs on a
// thread shell before any surface reads it. The runtime status it derives is what the
// sidebar resolver turns into Waiting (`idle`) or Done (`completed`).
import {
  EnvironmentId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { presentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";

const environmentId = EnvironmentId.make("environment-thread-attention");
const runId = RunId.make("run-thread-attention");

// A run that completed, unread: the shape a sidebar shows as Done unless something holds it.
const completedRun: OrchestrationV2ThreadShell = {
  ...v2ThreadShell,
  latestRunId: runId,
  activeRunId: null,
  status: "completed",
  latestRunCompletedAt: DateTime.makeUnsafe("2026-06-20T01:00:00.000Z"),
  lastVisitedAt: DateTime.makeUnsafe("2026-06-20T00:59:00.000Z"),
  pendingBackgroundTasks: [],
};

// The real shape from the live database: a Claude background Bash the coordinator started.
// Its finish wakes the agent with `notification.source.kind=background_command`.
const pendingCommand = {
  taskId: "bgzzoxe8f",
  description: "Dispatch phase 6 implement turn 3",
  kind: "command" as const,
};

const runningFactoryRun = {
  status: "running" as const,
  phaseIndex: 5,
  phaseCount: 11,
  node: "review",
};

const runtimeStatusOf = (shell: OrchestrationV2ThreadShell) =>
  presentThreadShell(environmentId, shell).runtime?.status;

describe("thread attention: what holds a completed run at Waiting", () => {
  it("thread attention: a pending background command holds a completed run at idle", () => {
    expect(runtimeStatusOf({ ...completedRun, pendingBackgroundTasks: [pendingCommand] })).toBe(
      "idle",
    );
  });

  it("thread attention: a running Factory run holds a completed run at idle", () => {
    expect(runtimeStatusOf({ ...completedRun, factoryRun: runningFactoryRun })).toBe("idle");
  });

  it("thread attention: the end of the last pending command releases the run to completed", () => {
    expect(runtimeStatusOf({ ...completedRun, pendingBackgroundTasks: [pendingCommand] })).toBe(
      "idle",
    );
    expect(runtimeStatusOf({ ...completedRun, pendingBackgroundTasks: [] })).toBe("completed");
  });
});

describe("thread attention guards: holds that already work and what stays out", () => {
  it.each([
    {
      name: "an unfinished async delegated task",
      task: {
        taskId: "node:delegated-task:review",
        description: "Seal reviewer",
        kind: "subagent" as const,
        childThreadId: ThreadId.make("thread-delegated-child"),
      },
    },
    {
      name: "an unfinished native sub-agent",
      task: { taskId: "toolu_native", description: "Explore", kind: "subagent" as const },
    },
    {
      name: "a monitor",
      task: { taskId: "monitor-1", description: "Watch build", kind: "monitor" as const },
    },
    {
      name: "a watched pull request",
      task: {
        taskId: "pull-request-watch:github.com/acme/app#7",
        description: "Watching pull request #7",
        kind: "monitor" as const,
      },
    },
  ])("thread attention guard: $name holds a completed run at idle", ({ task }) => {
    expect(runtimeStatusOf({ ...completedRun, pendingBackgroundTasks: [task] })).toBe("idle");
  });

  it("thread attention guard: a completed run with only a scheduled task ahead stays completed", () => {
    // A scheduled task lives only on the message it later sends; the shell carries nothing.
    expect(runtimeStatusOf(completedRun)).toBe("completed");
  });

  it.each(["done", "degraded", "stopped"] as const)(
    "thread attention guard: a %s Factory run does not hold a completed run",
    (status) => {
      expect(
        runtimeStatusOf({ ...completedRun, factoryRun: { ...runningFactoryRun, status } }),
      ).toBe("completed");
    },
  );

  it("thread attention guard: a failed run stays failed under a pending command or Factory run", () => {
    const failed = { ...completedRun, status: "failed" as const, lastError: "boom" };
    expect(runtimeStatusOf({ ...failed, pendingBackgroundTasks: [pendingCommand] })).toBe("failed");
    expect(runtimeStatusOf({ ...failed, factoryRun: runningFactoryRun })).toBe("failed");
  });

  it("thread attention guard: a pending approval still reaches the shell under a hold", () => {
    const shell = presentThreadShell(environmentId, {
      ...completedRun,
      pendingBackgroundTasks: [pendingCommand],
      factoryRun: runningFactoryRun,
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("request-thread-attention"),
        kind: "command",
        createdAt: completedRun.updatedAt,
      },
    });
    expect(shell.hasPendingApprovals).toBe(true);
  });
});

// The two holds this fork adds wait for the run to settle: they must never hide the agent's own
// live Working. Upstream's holds still park a stale `running` shell at idle.
describe("thread attention regression: a live run keeps its own status", () => {
  const liveRunId = RunId.make("run-thread-attention-live");
  const live = (status: "preparing" | "queued" | "starting" | "running" | "waiting") => ({
    ...completedRun,
    latestRunId: liveRunId,
    activeRunId: liveRunId,
    status,
    latestRunCompletedAt: null,
  });

  it.each(["preparing", "queued", "starting", "running", "waiting"] as const)(
    "thread attention regression: a %s run with only a pending command keeps that status",
    (status) => {
      expect(runtimeStatusOf({ ...live(status), pendingBackgroundTasks: [pendingCommand] })).toBe(
        status,
      );
    },
  );

  it.each(["preparing", "queued", "starting", "running", "waiting"] as const)(
    "thread attention regression: a running Factory run does not hide a %s coordinator run",
    (status) => {
      expect(runtimeStatusOf({ ...live(status), factoryRun: runningFactoryRun })).toBe(status);
    },
  );

  it("thread attention regression: a live activity run beats a Factory run on a settled latest run", () => {
    // A newer cancelled run is latest while an older run still works: the activity run owns it.
    expect(
      runtimeStatusOf({
        ...completedRun,
        status: "cancelled",
        activeRunId: liveRunId,
        activityRunStatus: "running",
        factoryRun: runningFactoryRun,
      }),
    ).toBe("running");
  });

  it("thread attention regression: upstream's sub-agent hold still parks a stale running shell", () => {
    expect(
      runtimeStatusOf({
        ...live("running"),
        pendingBackgroundTasks: [
          { taskId: "toolu_native", description: "Explore", kind: "subagent" },
        ],
      }),
    ).toBe("idle");
  });
});
