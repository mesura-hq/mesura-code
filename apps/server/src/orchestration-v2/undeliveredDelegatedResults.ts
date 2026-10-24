/**
 * Mesura: a finished delegated task whose result has not reached its parent yet.
 *
 * The task leaves the active roster when it finishes, but its result reaches the parent only
 * when the delivery run starts. Without a hold the parent shows Done in that gap and then wakes.
 * The shell keeps the task in `pendingBackgroundTasks` as a sub-agent until delivery, so every
 * client's existing sub-agent hold covers it without a new field.
 *
 * `pending` and `claimed` are undelivered. `acknowledged` (the parent read the result through
 * the task tools), `delivered` and `disposed` end the hold; delivery planning skips all three.
 */
import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2Run,
  OrchestrationV2Subagent,
} from "@t3tools/contracts";

const FINISHED_TASK_STATUSES = new Set<OrchestrationV2Subagent["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

const UNDELIVERED_STATES = new Set(["pending", "claimed"]);

// The same gate the pending-work roster uses: only a settled latest run with no active run.
const SETTLED_RUN_STATUSES = new Set<string | null>([
  "cancelled",
  "completed",
  "failed",
  "interrupted",
  "waiting",
]);

export const UNDELIVERED_DELEGATED_RESULT_SQL_STATES = [...UNDELIVERED_STATES];

export function isUndeliveredDelegatedResult(task: OrchestrationV2Subagent): boolean {
  return (
    task.origin === "app_owned" &&
    FINISHED_TASK_STATUSES.has(task.status) &&
    task.completionDelivery !== undefined &&
    UNDELIVERED_STATES.has(task.completionDelivery.state)
  );
}

export function withUndeliveredDelegatedResults(input: {
  readonly pendingBackgroundTasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly latestRunStatus: OrchestrationV2Run["status"] | "idle" | null;
  readonly hasActiveRun: boolean;
}): ReadonlyArray<OrchestrationV2PendingBackgroundTask> {
  if (input.hasActiveRun || !SETTLED_RUN_STATUSES.has(input.latestRunStatus)) {
    return input.pendingBackgroundTasks;
  }
  const listed = new Set(input.pendingBackgroundTasks.map((task) => task.taskId));
  const undelivered = input.subagents.filter(
    (task) => isUndeliveredDelegatedResult(task) && !listed.has(task.id),
  );
  if (undelivered.length === 0) return input.pendingBackgroundTasks;
  return [
    ...input.pendingBackgroundTasks,
    ...undelivered.map((task) => {
      const description = (task.title ?? task.prompt).trim();
      return {
        taskId: task.id,
        kind: "subagent" as const,
        providerInstanceId: task.providerInstanceId,
        ...(description.length === 0 ? {} : { description }),
        ...(task.childThreadId === null ? {} : { childThreadId: task.childThreadId }),
      };
    }),
  ];
}
