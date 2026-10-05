import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { ApprovalRequestId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { countPendingDictationSlots } from "@t3tools/shared/dictationSlots";
import { useEffect } from "react";

import { toastManager } from "~/components/ui/toast";
import { buildPendingUserInputAnswers } from "~/pendingUserInput";
import { usePendingUserInputDraftStore } from "~/pendingUserInputDraftStore";
import {
  collectQuestionAttachments,
  completeQuestionDraftAnswers,
  readQuestionAttachments,
} from "~/pendingUserInputResponse";
import { useAttachmentUploadStore } from "~/lib/attachmentUploadQueue";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readThread } from "~/state/entities";
import { environmentServerConfigsAtom } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { disarmQuestionSendWhenReady, useSendWhenReadyStore } from "./sendWhenReady";

/**
 * Send-when-ready for question cards: a request armed by send mode, or by Submit pressed while a
 * transcription was pending, is answered once none of its answers holds a marker, whether or not
 * its card is on screen. While the thread is shown, the answer goes through that thread's own
 * respond, so the card shows it sending; otherwise it is sent from here.
 */

type QuestionResponder = (
  requestId: ApprovalRequestId,
  answers: Record<string, unknown>,
) => Promise<boolean>;

const responders = new Map<string, QuestionResponder>();
const threadKey = (environmentId: string, threadId: string) =>
  JSON.stringify([environmentId, threadId]);

export function registerQuestionResponder(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  respond: QuestionResponder,
): () => void {
  const key = threadKey(environmentId, threadId);
  responders.set(key, respond);
  return () => {
    if (responders.get(key) === respond) responders.delete(key);
  };
}

const NOT_SENT = "Could not send answers. Your draft is saved.";
const submitting = new Set<string>();

function parseRequestKey(
  key: string,
): { environmentId: EnvironmentId; threadId: ThreadId; requestId: ApprovalRequestId } | null {
  try {
    const [environmentId, threadId, requestId] = JSON.parse(key) as [string, string, string];
    return {
      environmentId: environmentId as EnvironmentId,
      threadId: threadId as ThreadId,
      requestId: requestId as ApprovalRequestId,
    };
  } catch {
    return null;
  }
}

async function submitArmedQuestion(
  key: string,
  ids: NonNullable<ReturnType<typeof parseRequestKey>>,
  request: NonNullable<ReturnType<typeof findOpenRequest>>,
): Promise<void> {
  const { environmentId, threadId, requestId } = ids;
  const draft = usePendingUserInputDraftStore.getState().requests[key];
  const attachments = readQuestionAttachments({ ...ids, questions: request.questions });
  const answers = buildPendingUserInputAnswers(
    request.questions,
    completeQuestionDraftAnswers({
      questions: request.questions,
      answers: draft?.answers ?? {},
      attachments: attachments.map((entry) => entry.attachments),
      preparations: attachments.map((entry) => entry.preparing),
      uploads: useAttachmentUploadStore.getState().uploadsByImageId,
      supportsAttachments:
        appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment
          .capabilities.questionAttachments === true,
      environmentId,
      voicedQuestionIds: draft?.voicedQuestionIds ?? [],
    }),
  );
  if (!answers) {
    toastManager.add({
      type: "info",
      title: "The answer was not submitted",
      description: "Some questions still need an answer. Finish them and submit.",
    });
    return;
  }
  const responder = responders.get(threadKey(environmentId, threadId));
  if (responder) {
    if (!(await responder(requestId, answers))) {
      usePendingUserInputDraftStore
        .getState()
        .setError(key, { kind: "respond", message: NOT_SENT });
    }
    return;
  }
  const uploaded = collectQuestionAttachments({ ...ids, questions: request.questions });
  const result =
    uploaded.status === "ready"
      ? await runAtomCommand(
          appAtomRegistry,
          threadEnvironment.respondToUserInput,
          {
            environmentId,
            input: {
              threadId,
              requestId,
              answers,
              ...(Object.keys(uploaded.attachmentsByQuestionId).length > 0
                ? { attachmentsByQuestionId: uploaded.attachmentsByQuestionId }
                : {}),
            },
          },
          { reportFailure: false },
        )
      : null;
  if (result?._tag !== "Success") {
    usePendingUserInputDraftStore.getState().setError(key, { kind: "respond", message: NOT_SENT });
    toastManager.add({
      type: "error",
      title: "The dictated answer was not sent",
      description: NOT_SENT,
    });
  }
}

function findOpenRequest(ids: NonNullable<ReturnType<typeof parseRequestKey>>) {
  const thread = readThread({ environmentId: ids.environmentId, threadId: ids.threadId });
  if (!thread) return null;
  return (
    derivePendingRequests(thread.activities).userInputs.find(
      (entry) => entry.requestId === ids.requestId,
    ) ?? null
  );
}

function checkArmedQuestions() {
  const { requests } = usePendingUserInputDraftStore.getState();
  for (const key of Object.keys(useSendWhenReadyStore.getState().questions)) {
    if (submitting.has(key)) continue;
    const ids = parseRequestKey(key);
    const request = ids ? findOpenRequest(ids) : null;
    if (!ids || !request) {
      // Answered or dismissed elsewhere: nothing is left to send.
      disarmQuestionSendWhenReady(key);
      continue;
    }
    const answers = requests[key]?.answers ?? {};
    const pending = request.questions.some(
      (question) => countPendingDictationSlots(answers[question.id]?.customAnswer ?? "") > 0,
    );
    if (pending) continue;
    disarmQuestionSendWhenReady(key);
    submitting.add(key);
    void submitArmedQuestion(key, ids, request).finally(() => submitting.delete(key));
  }
}

/** Mounted once for the app, beside the dictation delivery. */
export function useQuestionSendWhenReady(): void {
  useEffect(() => {
    let queued = false;
    // After the update that triggered it, so the voiced mark that follows a fill has landed.
    const check = () => {
      if (queued || Object.keys(useSendWhenReadyStore.getState().questions).length === 0) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        checkArmedQuestions();
      });
    };
    const unsubscribeAnswers = usePendingUserInputDraftStore.subscribe(check);
    const unsubscribeArmed = useSendWhenReadyStore.subscribe(check);
    check();
    return () => {
      unsubscribeAnswers();
      unsubscribeArmed();
    };
  }, []);
}
