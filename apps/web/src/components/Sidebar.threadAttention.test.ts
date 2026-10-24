// Entry point: `presentThreadShell` (client-runtime models.ts) on a raw thread shell, then the
// sidebar's own resolvers in Sidebar.logic.ts: `resolveSidebarThreadStatus` for the status and
// `resolveSidebarV2TopStatus` for the label the current sidebar draws in the row's top slot.
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../test-fixtures";
import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveSidebarV2TopStatus,
  resolveThreadStatusPill,
} from "./Sidebar.logic";

const environmentId = EnvironmentId.make("environment-sidebar-thread-attention");

// A completed, unread run: the row shows Done unless something can still wake the agent.
const completedUnread: OrchestrationV2ThreadShell = {
  ...makeThreadFixture().source,
  latestRunId: RunId.make("run-sidebar-thread-attention"),
  activeRunId: null,
  status: "completed",
  latestRunCompletedAt: DateTime.makeUnsafe("2026-06-20T01:00:00.000Z"),
  lastVisitedAt: DateTime.makeUnsafe("2026-06-20T00:59:00.000Z"),
  pendingBackgroundTasks: [],
};

// The real shape from the live database (wake-causes.md): a Claude background Bash left
// pending at completion, whose finish wakes the agent with
// `notification.source.kind=background_command`.
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

function sidebarRow(shell: OrchestrationV2ThreadShell) {
  const thread = presentThreadShell(environmentId, shell);
  const status = resolveSidebarThreadStatus(thread);
  const isUnread = hasUnseenCompletion(thread);
  return { status, isUnread, top: resolveSidebarV2TopStatus({ status, isUnread, isWoke: false }) };
}

describe("sidebar thread attention: Done only when nothing can wake the agent", () => {
  it("sidebar thread attention: a pending background command shows Waiting, not Done", () => {
    const row = sidebarRow({ ...completedUnread, pendingBackgroundTasks: [pendingCommand] });
    expect(row.status).toBe("waiting");
    expect(row.top).toBe("waiting");
  });

  it("sidebar thread attention: a running Factory run shows Waiting, not Done", () => {
    const row = sidebarRow({ ...completedUnread, factoryRun: runningFactoryRun });
    expect(row.status).toBe("waiting");
    expect(row.top).toBe("waiting");
  });

  it("sidebar thread attention: Done follows the end of the last pending command", () => {
    expect(sidebarRow({ ...completedUnread, pendingBackgroundTasks: [pendingCommand] }).top).toBe(
      "waiting",
    );
    const released = sidebarRow({ ...completedUnread, pendingBackgroundTasks: [] });
    expect(released.isUnread).toBe(true);
    expect(released.top).toBe("done");
  });
});

describe("sidebar thread attention guards", () => {
  it.each([
    {
      name: "an unfinished async delegated task",
      task: {
        taskId: "node:delegated-task:review",
        description: "Seal reviewer",
        kind: "subagent" as const,
        childThreadId: ThreadId.make("thread-sidebar-delegated-child"),
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
  ])("sidebar thread attention guard: $name shows Waiting", ({ task }) => {
    const row = sidebarRow({ ...completedUnread, pendingBackgroundTasks: [task] });
    expect(row.status).toBe("waiting");
    expect(row.top).toBe("waiting");
  });

  it("sidebar thread attention guard: a scheduled task alone leaves an unread run Done", () => {
    // A scheduled task lives only on the message it later sends; the shell carries nothing.
    const row = sidebarRow(completedUnread);
    expect(row.isUnread).toBe(true);
    expect(row.top).toBe("done");
  });

  it.each([
    { name: "approval", kind: "command" as const, expected: "approval" },
    { name: "question", kind: "user_input" as const, expected: "input" },
  ])(
    "sidebar thread attention guard: a pending $name wins over a command and a Factory run",
    ({ kind, expected }) => {
      const row = sidebarRow({
        ...completedUnread,
        pendingBackgroundTasks: [pendingCommand],
        factoryRun: runningFactoryRun,
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("request-sidebar-thread-attention"),
          kind,
          createdAt: completedUnread.updatedAt,
        },
      });
      expect(row.status).toBe(expected);
    },
  );

  it("sidebar thread attention guard: a failed run shows Failed under a command or Factory run", () => {
    const failed = { ...completedUnread, status: "failed" as const, lastError: "boom" };
    expect(sidebarRow({ ...failed, pendingBackgroundTasks: [pendingCommand] }).status).toBe(
      "failed",
    );
    expect(sidebarRow({ ...failed, factoryRun: runningFactoryRun }).status).toBe("failed");
  });
});

// The shared pill is what the legacy sidebar and the command palette draw. It keeps upstream's
// rule; the new holds reach only the current sidebar, through `presentThreadShell`.
describe("sidebar thread attention: the shared status pill keeps upstream behavior", () => {
  const pillOf = (shell: OrchestrationV2ThreadShell) =>
    resolveThreadStatusPill({ thread: presentThreadShell(environmentId, shell) })?.label ?? null;

  it("sidebar thread attention pill: a pending command or Factory run leaves Completed", () => {
    expect(pillOf({ ...completedUnread, pendingBackgroundTasks: [pendingCommand] })).toBe(
      "Completed",
    );
    expect(pillOf({ ...completedUnread, factoryRun: runningFactoryRun })).toBe("Completed");
  });

  it("sidebar thread attention pill: an unread failure stays Failed under a command or Factory run", () => {
    const failed = { ...completedUnread, status: "failed" as const, lastError: "boom" };
    expect(pillOf({ ...failed, pendingBackgroundTasks: [pendingCommand] })).toBe("Failed");
    expect(pillOf({ ...failed, factoryRun: runningFactoryRun })).toBe("Failed");
  });
});

// The agent signal reaches only the current sidebar, through sidebarThreadAttention.ts; the
// shared pill the legacy sidebar and the command palette draw ignores it.
describe("sidebar thread attention: the shared status pill ignores the agent signal", () => {
  const pillOf = (shell: OrchestrationV2ThreadShell) =>
    resolveThreadStatusPill({ thread: presentThreadShell(environmentId, shell) })?.label ?? null;
  const signal = (kind: "needs_input" | "ready_to_close") => ({
    kind,
    note: kind === "needs_input" ? "Which branch?" : null,
    runId: completedUnread.latestRunId,
    setAt: "2026-06-20T01:00:00.000Z",
  });

  it("sidebar thread attention pill guard: a needs_input or ready_to_close signal leaves Completed", () => {
    expect(pillOf(completedUnread)).toBe("Completed");
    expect(pillOf({ ...completedUnread, agentSignal: signal("needs_input") })).toBe("Completed");
    expect(pillOf({ ...completedUnread, agentSignal: signal("ready_to_close") })).toBe("Completed");
  });

  it("sidebar thread attention pill guard: a signal leaves a running thread's pill unchanged", () => {
    const running = {
      ...completedUnread,
      status: "running" as const,
      activeRunId: completedUnread.latestRunId,
    };
    const before = pillOf(running);
    expect(pillOf({ ...running, agentSignal: signal("needs_input") })).toBe(before);
  });
});
