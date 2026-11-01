/**
 * Mesura: a failed compaction holds the thread's queue. Kept apart from `CompactAndContinue.ts` so
 * the orchestrator can import it without an import cycle through `ThreadManagementService`.
 */
import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  RunId,
} from "@t3tools/contracts";

/** The rule `RunExecutionService` uses to run a message as a compaction turn. */
function isCompactionMessage(
  message: Pick<OrchestrationV2ConversationMessage, "text" | "attachments">,
): boolean {
  return message.attachments.length === 0 && message.text.trim().toLowerCase() === "/compact";
}

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
  return message !== undefined && isCompactionMessage(message);
}
