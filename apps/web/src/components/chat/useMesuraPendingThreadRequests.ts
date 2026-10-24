import { useEffect, useRef, useState } from "react";
import { AuthOrchestrationOperateScope, type EnvironmentId, type OrchestrationV2ThreadProjection, type ProviderApprovalDecision, type RuntimeRequestId, type ThreadId } from "@t3tools/contracts";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { isAtomCommandInterrupted, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { createPendingUserInputProjection } from "../../pendingUserInput";
import { usePendingUserInputDraftStore } from "../../pendingUserInputDraftStore";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { clearQuestionAttachmentDraft, questionAttachmentDraftId, questionAttachmentDraftPrefix, useQuestionAttachmentPreparation } from "../../questionAttachments";
import { derivePendingApprovals, derivePendingUserInputs } from "../../session-logic";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { collectQuestionAttachments } from "../../pendingUserInputResponse";
import { registerQuestionResponder } from "../../dictation/questionSendWhenReady";

/** Questions keep their drafts in the feed while the composer remains a message draft. */
export function useMesuraPendingThreadRequests(input: {
  environmentId: EnvironmentId;
  activeThreadId: ThreadId | null;
  activeThread: { readonly id: ThreadId } | undefined;
  serverProjection: OrchestrationV2ThreadProjection | null;
  supportsQuestionAttachments: boolean;
  maxFileAttachmentBytes: number | null;
  activeEnvironmentUnavailable: boolean;
  canOperateThread: boolean;
  setThreadError: (threadId: ThreadId, message: string | null) => void;
}) {
  const { environmentId, activeThreadId, activeThread, serverProjection, supportsQuestionAttachments, maxFileAttachmentBytes, activeEnvironmentUnavailable, canOperateThread, setThreadError } = input;
  const respondToThreadApproval = useOrchestrationCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const respondToThreadUserInput = useOrchestrationCommand(threadEnvironment.respondToUserInput, { reportFailure: false });
  const dismissThreadUserInput = useAtomCommand(threadEnvironment.dismissUserInput, { reportFailure: false });
  const userInputResponsesInFlight = useRef(new Set<string>());
  const [respondingRequestIds, setRespondingRequestIds] = useState<RuntimeRequestId[]>([]);
  const [respondingUserInputRequestKeys, setRespondingUserInputRequestKeys] = useState<string[]>([]);
  const pendingRequests = serverProjection === null ? { approvals: [], userInputs: [] } : derivePendingThreadRequests(serverProjection);
  const pendingApprovals = derivePendingApprovals(pendingRequests.approvals);
  const [projectPendingUserInputs] = useState(createPendingUserInputProjection);
  const pendingUserInputs = projectPendingUserInputs(derivePendingUserInputs(pendingRequests.userInputs));
  const activePendingApproval = pendingApprovals[0] ?? null;
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  useEffect(() => {
    if (!activeThread) return;
    const questionThread = activeThread;
    const currentRequests = pendingUserInputs;
    // Answer drafts of requests that are no longer pending are dropped with their files.
    const requestIds = new Set<string>(currentRequests.map((request) => request.requestId));
    for (const key of Object.keys(usePendingUserInputDraftStore.getState().requests)) {
      const [draftEnvironmentId, draftThreadId, requestId] = JSON.parse(key);
      if (
        draftEnvironmentId === environmentId &&
        draftThreadId === questionThread.id &&
        !requestIds.has(requestId)
      )
        usePendingUserInputDraftStore.getState().clear(key);
    }
    const prefix = questionAttachmentDraftPrefix(environmentId, questionThread.id);
    const retained = new Set(
      currentRequests.flatMap((request) =>
        request.questions.map((question) =>
          questionAttachmentDraftId(
            environmentId,
            questionThread.id,
            request.requestId,
            question.id,
          ),
        ),
      ),
    );
    const keys = new Set([
      ...Object.keys(useComposerDraftStore.getState().draftsByThreadKey),
      ...Object.keys(useQuestionAttachmentPreparation.getState().counts),
    ]);
    for (const key of keys) {
      if (key.startsWith(prefix) && !retained.has(DraftId.make(key)))
        clearQuestionAttachmentDraft(DraftId.make(key));
    }
  }, [environmentId, activeThread, pendingUserInputs]);
  const onRespondToApproval = (async (requestId: RuntimeRequestId, decision: ProviderApprovalDecision) => {
      if (!activeThreadId || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
        return;
      if (
        pendingApprovals.find((approval) => approval.requestId === requestId)
          ?.responseCapability !== "live"
      )
        return;

      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      const result = await respondToThreadApproval({
        environmentId,
        input: {
          threadId: activeThreadId,
          requestId,
          decision,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : "Failed to submit approval decision.",
        );
      }
      setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
      return result;
    });

  const onRespondToUserInput = (async (requestId: RuntimeRequestId, answers: Record<string, unknown>) => {
      if (!activeThreadId || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
        return false;
      const request = pendingUserInputs.find((entry) => entry.requestId === requestId);
      if (
        !request ||
        request.responseCapability === "not_resumable" ||
        activeEnvironmentUnavailable
      )
        return false;
      const responseKey = JSON.stringify([environmentId, activeThreadId, requestId]);
      if (userInputResponsesInFlight.current.has(responseKey)) return false;
      const attachments = collectQuestionAttachments({
        environmentId,
        threadId: activeThreadId,
        requestId,
        questions: request.questions,
      });
      if (attachments.status === "preparing") return false;
      if (attachments.status === "not-uploaded") {
        setThreadError(
          activeThreadId,
          "Wait for attachments to finish uploading, or remove failed uploads.",
        );
        return false;
      }
      const { attachmentsByQuestionId } = attachments;
      userInputResponsesInFlight.current.add(responseKey);
      setRespondingUserInputRequestKeys((existing) =>
        existing.includes(responseKey) ? existing : [...existing, responseKey],
      );
      try {
        const result = await respondToThreadUserInput({
          environmentId,
          input: {
            threadId: activeThreadId,
            requestId,
            answers,
            ...(Object.keys(attachmentsByQuestionId).length > 0 ? { attachmentsByQuestionId } : {}),
          },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          setThreadError(
            activeThreadId,
            error instanceof Error ? error.message : "Failed to submit user input.",
          );
        }
        return result._tag === "Success";
      } catch (error) {
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : "Failed to submit user input.",
        );
        return false;
      } finally {
        userInputResponsesInFlight.current.delete(responseKey);
        setRespondingUserInputRequestKeys((existing) =>
          existing.filter((id) => id !== responseKey),
        );
      }
    });

  // A dictated answer that submits itself goes through this thread's own respond while shown.
  useEffect(
    () =>
      activeThreadId
        ? registerQuestionResponder(environmentId, activeThreadId, onRespondToUserInput)
        : undefined,
    [activeThreadId, environmentId, onRespondToUserInput],
  );

  // Closes an async question without messaging the agent. The server records
  // the dismissal so every client removes the pending card.
  const onDismissUserInput = (async (requestId: RuntimeRequestId) => {
      if (
        !activeThreadId ||
        activeEnvironmentUnavailable ||
        !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
      )
        return false;
      const responseKey = JSON.stringify([environmentId, activeThreadId, requestId]);
      if (userInputResponsesInFlight.current.has(responseKey)) return false;
      userInputResponsesInFlight.current.add(responseKey);
      setRespondingUserInputRequestKeys((existing) =>
        existing.includes(responseKey) ? existing : [...existing, responseKey],
      );
      try {
        const result = await dismissThreadUserInput({
          environmentId,
          input: { threadId: activeThreadId, requestId },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          setThreadError(
            activeThreadId,
            error instanceof Error ? error.message : "Failed to dismiss the question.",
          );
        }
        return result._tag === "Success";
      } catch (error) {
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : "Failed to dismiss the question.",
        );
        return false;
      } finally {
        userInputResponsesInFlight.current.delete(responseKey);
        setRespondingUserInputRequestKeys((existing) =>
          existing.filter((id) => id !== responseKey),
        );
      }
    });

  // Mesura: the in-feed question cards' shared state (ADR-007). A request that cannot be
  // resumed, or a scope that no longer allows operating the thread, makes them read-only.
  const inlinePendingUserInput = (() =>
      activeThreadId && pendingUserInputs.length > 0
        ? {
            environmentId,
            threadId: activeThreadId,
            requests: pendingUserInputs,
            supportsAttachments: supportsQuestionAttachments,
            maxFileBytes: maxFileAttachmentBytes,
            unavailable: activeEnvironmentUnavailable || !canOperateThread,
            respondingRequestIds: pendingUserInputs
              .filter(
                (request) =>
                  request.responseCapability === "not_resumable" ||
                  respondingUserInputRequestKeys.includes(
                    JSON.stringify([environmentId, activeThreadId, request.requestId]),
                  ),
              )
              .map((request) => request.requestId),
            onRespond: onRespondToUserInput,
            onDismiss: onDismissUserInput,
          }
        : null)();

  return {
    pendingApprovals, pendingUserInputs, activePendingApproval, activePendingUserInput,
    respondingRequestIds, onRespondToApproval, onDismissUserInput, inlinePendingUserInput,
  };
}
