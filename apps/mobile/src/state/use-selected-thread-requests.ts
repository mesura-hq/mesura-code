import * as Option from "effect/Option";
import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import { useServerConfigs } from "./entities";
import { Alert } from "react-native";
import {
  questionAttachmentDraftKey,
  questionAttachmentDraftPrefix,
  questionAttachmentPreparationAtom,
} from "./question-attachments";
import { composerDraftsAtom, clearComposerDraft } from "./use-composer-drafts";
import {
  composerAttachmentUploadsAtom,
  composerAttachmentUploadBlockReason,
  composerAttachmentsStillUploading,
} from "./composer-attachment-uploads";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ApprovalRequestId,
  type EnvironmentId,
  type ThreadId,
  type ServerConfig,
  type ProviderApprovalDecision,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { threadEnvironment } from "../state/threads";
import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
  type PendingUserInput,
} from "../lib/threadActivity";
import { appAtomRegistry } from "./atom-registry";
import { useSelectedThreadDetail } from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";
import { useAtomCommand } from "./use-atom-command";

const userInputDraftsByRequestKeyAtom = Atom.make<
  Record<string, Record<string, PendingUserInputDraftAnswer>>
>({}).pipe(Atom.keepAlive, Atom.withLabel("mobile:user-input-drafts"));

function userInputDraftKey(
  thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId },
  requestId: ApprovalRequestId,
): string {
  return JSON.stringify([thread.environmentId, thread.id, requestId]);
}

function setUserInputDraftOption(
  requestKey: string,
  question: UserInputQuestion,
  value: string,
): void {
  const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
  appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
    ...current,
    [requestKey]: {
      ...current[requestKey],
      [question.id]: togglePendingUserInputOptionSelection(
        question,
        current[requestKey]?.[question.id],
        value,
      ),
    },
  });
}

function setUserInputDraftCustomAnswer(
  requestKey: string,
  question: UserInputQuestion,
  customAnswer: string,
): void {
  const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
  appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
    ...current,
    [requestKey]: {
      ...current[requestKey],
      [question.id]: setPendingUserInputCustomAnswer(
        question,
        current[requestKey]?.[question.id],
        customAnswer,
      ),
    },
  });
}

/** Mesura: dictation reads and fills a question's note by key, wherever its card is. */
export function readUserInputDraftCustomAnswer(requestKey: string, questionId: string): string {
  return (
    appAtomRegistry.get(userInputDraftsByRequestKeyAtom)[requestKey]?.[questionId]?.customAnswer ??
    ""
  );
}

export function setUserInputDraftCustomAnswerText(
  requestKey: string,
  questionId: string,
  customAnswer: string,
): void {
  const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
  appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
    ...current,
    [requestKey]: {
      ...current[requestKey],
      [questionId]: { ...current[requestKey]?.[questionId], customAnswer },
    },
  });
}

// Share the readiness calculation between the card subscription and the submit
// snapshot. Regular composer text and upload progress must not invalidate the feed.
function readPendingUserInputDrafts(
  read: typeof appAtomRegistry.get,
  thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId },
  request: PendingUserInput,
  serverConfig: ServerConfig | null,
): Record<string, PendingUserInputDraftAnswer> {
  const answers = read(userInputDraftsByRequestKeyAtom)[
    userInputDraftKey(thread, request.requestId)
  ];
  const attachmentDrafts = read(composerDraftsAtom);
  const preparationCounts = read(questionAttachmentPreparationAtom);
  const states = read(composerAttachmentUploadsAtom);
  return Object.fromEntries(
    request.questions.map((question) => {
      const key = questionAttachmentDraftKey(
        thread.environmentId,
        thread.id,
        request.requestId,
        question.id,
      );
      const attachments = attachmentDrafts[key]?.attachments ?? [];
      const uploadInput = {
        environmentId: thread.environmentId,
        attachments,
        serverConfig,
        states,
      };
      return [
        question.id,
        {
          ...answers?.[question.id],
          attachmentCount: attachments.length,
          attachmentsBlocked:
            (attachments.length > 0 &&
              serverConfig?.environment.capabilities.questionAttachments !== true) ||
            (preparationCounts[key] ?? 0) > 0 ||
            composerAttachmentsStillUploading(uploadInput) ||
            composerAttachmentUploadBlockReason({ ...uploadInput, connected: true }) !== null,
        },
      ];
    }),
  );
}

export function usePendingUserInputDrafts(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  request: PendingUserInput,
) {
  const serverConfig = useServerConfigs().get(environmentId) ?? null;
  const draftAtom = useMemo(
    () =>
      Atom.make((get) => {
        const drafts = readPendingUserInputDrafts(
          get,
          { environmentId, id: threadId },
          request,
          serverConfig,
        );
        const previous = Option.getOrUndefined(
          get.self<Record<string, PendingUserInputDraftAnswer>>(),
        );
        if (
          previous &&
          Object.keys(previous).length === Object.keys(drafts).length &&
          Object.entries(drafts).every(([id, draft]) => {
            const old = previous[id];
            return (
              old &&
              old.selectedOptionValues === draft.selectedOptionValues &&
              old.customAnswer === draft.customAnswer &&
              old.attachmentCount === draft.attachmentCount &&
              old.attachmentsBlocked === draft.attachmentsBlocked
            );
          })
        )
          return previous;
        return drafts;
      }),
    [environmentId, threadId, request, serverConfig],
  );
  return useAtomValue(draftAtom);
}

export function useSelectedThreadRequests() {
  const respondToApproval = useAtomCommand(
    threadEnvironment.respondToApproval,
    "thread approval response",
  );
  const respondToUserInput = useAtomCommand(
    threadEnvironment.respondToUserInput,
    "thread user input response",
  );
  const dismissUserInput = useAtomCommand(
    threadEnvironment.dismissUserInput,
    "thread user input dismissal",
  );
  const { selectedThread: selectedThreadShell } = useThreadSelection();
  const selectedThread = useSelectedThreadDetail();
  const [respondingApprovalId, setRespondingApprovalId] = useState<ApprovalRequestId | null>(null);
  const userInputResponsesInFlight = useRef(new Set<string>());
  const [respondingUserInputKeys, setRespondingUserInputKeys] = useState<ReadonlySet<string>>(
    new Set(),
  );

  const { approvals: activePendingApprovals, userInputs: activePendingUserInputs } = useMemo(
    () => derivePendingRequests(selectedThread?.activities ?? []),
    [selectedThread?.activities],
  );
  const activePendingApproval = activePendingApprovals[0] ?? null;
  const activePendingUserInput = activePendingUserInputs[0] ?? null;
  const questionServerConfigs = useServerConfigs();
  useEffect(() => {
    if (!selectedThreadShell || !selectedThread) return;
    const prefix = questionAttachmentDraftPrefix(
      selectedThreadShell.environmentId,
      selectedThreadShell.id,
    );
    const retained = new Set(
      activePendingUserInputs.flatMap((request) =>
        request.questions.map((question) =>
          questionAttachmentDraftKey(
            selectedThreadShell.environmentId,
            selectedThreadShell.id,
            request.requestId,
            question.id,
          ),
        ),
      ),
    );
    const attachmentDrafts = appAtomRegistry.get(composerDraftsAtom);
    const counts = { ...appAtomRegistry.get(questionAttachmentPreparationAtom) };
    let changed = false;
    for (const key of new Set([...Object.keys(attachmentDrafts), ...Object.keys(counts)])) {
      if (!key.startsWith(prefix) || retained.has(key)) continue;
      if (attachmentDrafts[key]) clearComposerDraft(key);
      if (key in counts) {
        delete counts[key];
        changed = true;
      }
    }
    if (changed) appAtomRegistry.set(questionAttachmentPreparationAtom, counts);
  }, [activePendingUserInputs, selectedThread, selectedThreadShell]);
  const respondingUserInputIds = useMemo(
    () =>
      new Set(
        activePendingUserInputs
          .filter(
            (request) =>
              selectedThreadShell &&
              respondingUserInputKeys.has(
                userInputDraftKey(selectedThreadShell, request.requestId),
              ),
          )
          .map((request) => request.requestId),
      ),
    [activePendingUserInputs, respondingUserInputKeys, selectedThreadShell],
  );
  const onSelectUserInputOption = useCallback(
    (requestId: ApprovalRequestId, question: UserInputQuestion, value: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const requestKey = userInputDraftKey(selectedThreadShell, requestId);
      setUserInputDraftOption(requestKey, question, value);
    },
    [selectedThreadShell],
  );

  const onChangeUserInputCustomAnswer = useCallback(
    (requestId: ApprovalRequestId, questionId: string, customAnswer: string) => {
      const question = activePendingUserInputs
        .find((request) => request.requestId === requestId)
        ?.questions.find((entry) => entry.id === questionId);
      if (!selectedThreadShell || !question) {
        return;
      }

      const requestKey = userInputDraftKey(selectedThreadShell, requestId);
      setUserInputDraftCustomAnswer(requestKey, question, customAnswer);
    },
    [activePendingUserInputs, selectedThreadShell],
  );

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      if (!selectedThreadShell) {
        return;
      }

      setRespondingApprovalId(requestId);
      const result = await respondToApproval({
        environmentId: selectedThreadShell.environmentId,
        input: {
          threadId: selectedThreadShell.id,
          requestId,
          decision,
        },
      });
      setRespondingApprovalId((current) => (current === requestId ? null : current));
      return result;
    },
    [respondToApproval, selectedThreadShell],
  );

  const runUserInputResponse = useCallback(
    async (requestId: ApprovalRequestId, respond: () => Promise<unknown>) => {
      if (!selectedThreadShell) return;
      const responseKey = userInputDraftKey(selectedThreadShell, requestId);
      if (userInputResponsesInFlight.current.has(responseKey)) return;
      userInputResponsesInFlight.current.add(responseKey);
      setRespondingUserInputKeys(new Set(userInputResponsesInFlight.current));
      try {
        return await respond();
      } catch (error) {
        Alert.alert("Could not respond", error instanceof Error ? error.message : "Try again.");
      } finally {
        userInputResponsesInFlight.current.delete(responseKey);
        setRespondingUserInputKeys(new Set(userInputResponsesInFlight.current));
      }
    },
    [selectedThreadShell],
  );

  const onSubmitUserInput = useCallback(
    async (requestId: ApprovalRequestId) => {
      const request = activePendingUserInputs.find((entry) => entry.requestId === requestId);
      if (!selectedThreadShell || !request) return;
      const answers = buildPendingUserInputAnswers(
        request.questions,
        readPendingUserInputDrafts(
          // Registry.get uses its receiver; keep it bound for the submit snapshot.
          (atom) => appAtomRegistry.get(atom),
          selectedThreadShell,
          request,
          questionServerConfigs.get(selectedThreadShell.environmentId) ?? null,
        ),
      );
      if (!answers) return;
      const attachmentsByQuestionId = new Map<
        string,
        import("@t3tools/contracts").UserInputAttachments[string]
      >();
      for (const question of request.questions) {
        const key = questionAttachmentDraftKey(
          selectedThreadShell.environmentId,
          selectedThreadShell.id,
          requestId,
          question.id,
        );
        if ((appAtomRegistry.get(questionAttachmentPreparationAtom)[key] ?? 0) > 0) return;
        const attachments = appAtomRegistry.get(composerDraftsAtom)[key]?.attachments ?? [];
        if (attachments.length === 0) continue;
        if (
          attachments.some(
            (attachment) =>
              !attachment.uploadedAttachmentId ||
              attachment.uploadEnvironmentId !== selectedThreadShell.environmentId,
          )
        ) {
          Alert.alert(
            "Attachments are not ready",
            "Wait for uploads to finish, or retry failed uploads.",
          );
          return;
        }
        attachmentsByQuestionId.set(
          question.id,
          attachments.map((attachment) => ({
            type: attachment.type,
            id: attachment.uploadedAttachmentId!,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          })),
        );
      }
      return runUserInputResponse(requestId, () =>
        respondToUserInput({
          environmentId: selectedThreadShell.environmentId,
          input: {
            threadId: selectedThreadShell.id,
            requestId,
            answers,
            ...(attachmentsByQuestionId.size > 0
              ? { attachmentsByQuestionId: Object.fromEntries(attachmentsByQuestionId) }
              : {}),
          },
        }),
      );
    },
    [
      activePendingUserInputs,
      questionServerConfigs,
      respondToUserInput,
      runUserInputResponse,
      selectedThreadShell,
    ],
  );

  // Native callback requests cannot be dismissed without an answer.
  const onDismissUserInput = useCallback(
    async (requestId: ApprovalRequestId) => {
      if (
        !selectedThreadShell ||
        !activePendingUserInputs.some(
          (request) => request.requestId === requestId && request.dismissible,
        )
      )
        return;
      return runUserInputResponse(requestId, () =>
        dismissUserInput({
          environmentId: selectedThreadShell.environmentId,
          input: { threadId: selectedThreadShell.id, requestId },
        }),
      );
    },
    [activePendingUserInputs, dismissUserInput, runUserInputResponse, selectedThreadShell],
  );

  return {
    activePendingApproval,
    activePendingUserInput,
    respondingApprovalId,
    respondingUserInputIds,
    onRespondToApproval,
    onSelectUserInputOption,
    onChangeUserInputCustomAnswer,
    onSubmitUserInput,
    onDismissUserInput,
  };
}
