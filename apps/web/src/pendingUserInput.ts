import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { PendingUserInput } from "./session-logic";
export {
  type PendingUserInputDraftAnswer,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  buildPendingUserInputAnswers,
} from "@t3tools/client-runtime/user-input-answers";

// Mesura: questions are answered in the chat feed (`InlinePendingUserInputCard`), and the
// answer rules are shared through `@t3tools/client-runtime/user-input-answers`. Upstream's
// composer-panel helpers (question stepping, displaced-answer carry) have no caller here:
// a choice and a note coexist instead of replacing each other.

export const pendingUserInputRequestKey = (
  environmentId: EnvironmentId,
  threadId: ThreadId,
  requestId: string,
) => JSON.stringify([environmentId, threadId, requestId]);

const EMPTY_PENDING_USER_INPUTS: ReadonlyArray<PendingUserInput> = [];

/** Retain request identities across unrelated thread updates. */
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
