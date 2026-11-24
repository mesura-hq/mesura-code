import { factoryRunQuestionOpen } from "@t3tools/contracts";

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

type AgentQuestionThread = Pick<
  EnvironmentThreadShell,
  "agentSignal" | "factoryRun" | "latestUserAuthoredMessageAt"
>;

/**
 * Mesura: an agent's question outside a structured request — its `needs_input` signal, or a Factory
 * run that waits on a question or was stopped. The user's next message answers either one.
 */
export function agentQuestionIsOpen(thread: AgentQuestionThread): boolean {
  return thread.agentSignal?.kind === "needs_input" || factoryQuestionIsOpen(thread);
}

/** A Factory run's question that the user has not answered by writing after `askedAt`. */
export function factoryQuestionIsOpen(
  thread: Pick<EnvironmentThreadShell, "factoryRun" | "latestUserAuthoredMessageAt">,
): boolean {
  const repliedAt = thread.latestUserAuthoredMessageAt;
  return factoryRunQuestionOpen(
    thread.factoryRun,
    repliedAt == null ? null : Date.parse(repliedAt),
  );
}

/**
 * An open agent question waits on the developer once the agent stops executing, even while
 * background work or delegated tasks keep the thread's run alive. The Working section then
 * releases the thread, as it does for a structured question. While the agent executes a later
 * turn, the question stays open but the thread is working.
 */
export function agentQuestionAwaitsUser(
  thread: AgentQuestionThread & Pick<EnvironmentThreadShell, "runtime">,
): boolean {
  return agentQuestionIsOpen(thread) && !threadRuntimeIsExecuting(thread.runtime);
}
