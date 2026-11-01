import type { EnvironmentThreadShell } from "./models.ts";

/** The runtime statuses in which the agent is executing a turn, not waiting on background work. */
const EXECUTING_RUNTIME_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
]);

export function threadRuntimeIsExecuting(runtime: EnvironmentThreadShell["runtime"]): boolean {
  return runtime != null && EXECUTING_RUNTIME_STATUSES.has(runtime.status);
}

/**
 * Mesura: an agent's `needs_input` signal waits on the developer once the agent stops executing,
 * even while background work or delegated tasks keep the thread's run alive. The Working section
 * then releases the thread, as it does for a structured question. While the agent executes a
 * later turn, the question stays open but the thread is working.
 */
export function agentQuestionAwaitsUser(
  thread: Pick<EnvironmentThreadShell, "agentSignal" | "runtime">,
): boolean {
  return thread.agentSignal?.kind === "needs_input" && !threadRuntimeIsExecuting(thread.runtime);
}
