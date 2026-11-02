/**
 * Mesura: a failed compaction holds the thread's queue. Kept apart from `CompactAndContinue.ts` so
 * the orchestrator can import it without an import cycle through `ThreadManagementService`.
 */
import {
  isCompactionCommandMessage,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type RunId,
} from "@t3tools/contracts";

/**
 * Whether the run that just failed was a compaction, which holds the queue whatever its failure
 * class: a follow-up queued behind it must not run on the uncompacted context.
 */
export function failedCompactionHoldsQueue(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  failedRun: Pick<OrchestrationV2Run, "id" | "userMessageId"> | null | undefined,
  failedRunId: RunId | undefined,
): boolean {
  if (failedRun == null || failedRunId === undefined || failedRun.id !== failedRunId) return false;
  const message = messages.find((candidate) => candidate.id === failedRun.userMessageId);
  return message !== undefined && isCompactionCommandMessage(message);
}
