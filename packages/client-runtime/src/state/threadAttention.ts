/**
 * Mesura: upstream's `backgroundWorkHoldsCompletion` lets a pending command through (a dev server
 * can run for hours). Here long-lived servers run as `mesura-agent-service` workloads, so a pending
 * command is finite work whose end wakes the agent, and it holds the thread at Waiting. Scheduled
 * tasks never hold; an undelivered delegated-task result stays in `pendingBackgroundTasks`.
 */
import {
  factoryRunHoldsCompletion,
  type FactoryRunShellSummary,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

// Includes `waiting`: the turn ended but checkpoint capture still owns the run.
const ACTIVE_RUN_STATUSES = new Set<OrchestrationV2ThreadShell["status"]>([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

function threadHoldsCompletion(thread: {
  readonly pendingBackgroundTasks?: ReadonlyArray<unknown> | undefined;
  readonly factoryRun?: Pick<FactoryRunShellSummary, "status"> | null | undefined;
}): boolean {
  return (
    (thread.pendingBackgroundTasks?.length ?? 0) > 0 || factoryRunHoldsCompletion(thread.factoryRun)
  );
}

/**
 * Upstream's holds park a shell at idle even over a stale `running` status. The holds this
 * fork adds, a pending command and a running Factory run, wait for the run to settle, so they
 * never mask the agent's own Working: a Factory run outlives the coordinator's turns, and a
 * command can be listed while its run is still live.
 */
export function shellHoldsCompletion(
  shell: Pick<
    OrchestrationV2ThreadShell,
    "pendingBackgroundTasks" | "factoryRun" | "status" | "activityRunStatus"
  >,
): boolean {
  const tasks = shell.pendingBackgroundTasks ?? [];
  if (backgroundWorkHoldsCompletion(tasks)) return true;
  const runIsActive = shell.activityRunStatus != null || ACTIVE_RUN_STATUSES.has(shell.status);
  return !runIsActive && threadHoldsCompletion(shell);
}
