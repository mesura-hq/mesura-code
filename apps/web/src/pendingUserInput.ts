import type { ApprovalRequestId, EnvironmentId, ThreadId } from "@t3tools/contracts";
export {
  type PendingUserInputDraftAnswer,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  buildPendingUserInputAnswers,
} from "@t3tools/client-runtime/user-input-answers";

export const pendingUserInputRequestKey = (
  environmentId: EnvironmentId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
) => JSON.stringify([environmentId, threadId, requestId]);

const EMPTY_PENDING_USER_INPUTS: ReadonlyArray<
  import("@t3tools/client-runtime/pending-requests").PendingUserInput
> = [];

/** Retain request identities across unrelated thread activities. */
export function createPendingUserInputProjection() {
  let previous = EMPTY_PENDING_USER_INPUTS;
  return (next: typeof previous): typeof previous => {
    const stable = next.map((request) => {
      const existing = previous.find((entry) => entry.requestId === request.requestId);
      return existing && JSON.stringify(existing) === JSON.stringify(request) ? existing : request;
    });
    if (stable.length === 0) return (previous = EMPTY_PENDING_USER_INPUTS);
    if (
      stable.length === previous.length &&
      stable.every((request, index) => request === previous[index])
    )
      return previous;
    return (previous = stable);
  };
}
