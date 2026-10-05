import type {
  ApprovalRequestId,
  EnvironmentId,
  ThreadId,
  UserInputAttachments,
  UserInputQuestion,
} from "@t3tools/contracts";
import { withVoicedPrefix } from "@t3tools/shared/dictationSlots";

import type { ComposerFileAttachment, ComposerImageAttachment } from "./composerDraftStore";
import { useComposerDraftStore } from "./composerDraftStore";
import { getUploadedAttachments } from "./lib/attachmentUploadQueue";
import type { AttachmentUploadState } from "./lib/attachmentUploadState";
import type { PendingUserInputDraftAnswer } from "./pendingUserInput";
import { questionAttachmentDraftId, useQuestionAttachmentPreparation } from "./questionAttachments";

/**
 * What answering a question request sends, shared by the card's Submit and by a dictated answer
 * that submits itself while its card is not on screen.
 */

type QuestionAttachment = ComposerImageAttachment | ComposerFileAttachment;

/**
 * Each question's draft answer as it is judged and sent: with its attachment state, and with one
 * `[voiced] ` tag on free text that was dictated. Option values are never tagged.
 */
export function completeQuestionDraftAnswers(input: {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly answers: Readonly<Record<string, PendingUserInputDraftAnswer>>;
  /** Per question, in the same order: its attachments, and how many are still being prepared. */
  readonly attachments: ReadonlyArray<ReadonlyArray<QuestionAttachment>>;
  readonly preparations: ReadonlyArray<number>;
  readonly uploads: Readonly<Record<string, AttachmentUploadState | undefined>>;
  readonly supportsAttachments: boolean;
  readonly environmentId: EnvironmentId;
  readonly voicedQuestionIds: ReadonlyArray<string>;
}): Record<string, PendingUserInputDraftAnswer> {
  return Object.fromEntries(
    input.questions.map((question, index) => {
      const answer = input.answers[question.id];
      const attachments = input.attachments[index] ?? [];
      const customAnswer = answer?.customAnswer;
      return [
        question.id,
        {
          ...answer,
          ...(customAnswer !== undefined && customAnswer.trim() !== ""
            ? {
                customAnswer: withVoicedPrefix(
                  customAnswer,
                  input.voicedQuestionIds.includes(question.id),
                ),
              }
            : {}),
          attachmentCount: attachments.length,
          attachmentsBlocked:
            (input.preparations[index] ?? 0) > 0 ||
            attachments.some(
              (attachment) =>
                !input.supportsAttachments ||
                question.allowCustomAnswer === false ||
                input.uploads[attachment.id]?.status !== "ready" ||
                input.uploads[attachment.id]?.environmentId !== input.environmentId,
            ),
        },
      ];
    }),
  );
}

/** The draft attachments of each question of a request, in question order. */
export function readQuestionAttachments(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly requestId: ApprovalRequestId;
  readonly questions: ReadonlyArray<UserInputQuestion>;
}): Array<{ readonly preparing: number; readonly attachments: QuestionAttachment[] }> {
  return input.questions.map((question) => {
    const target = questionAttachmentDraftId(
      input.environmentId,
      input.threadId,
      input.requestId,
      question.id,
    );
    const draft = useComposerDraftStore.getState().getComposerDraft(target);
    return {
      preparing: useQuestionAttachmentPreparation.getState().counts[target] ?? 0,
      attachments: draft ? [...draft.images, ...draft.files] : [],
    };
  });
}

/** The uploaded attachments to send with an answer, or why they cannot be sent yet. */
export function collectQuestionAttachments(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly requestId: ApprovalRequestId;
  readonly questions: ReadonlyArray<UserInputQuestion>;
}):
  | { readonly status: "preparing" }
  | { readonly status: "not-uploaded" }
  | { readonly status: "ready"; readonly attachmentsByQuestionId: UserInputAttachments } {
  const attachmentsByQuestionId: Record<string, UserInputAttachments[string]> = {};
  const perQuestion = readQuestionAttachments(input);
  for (const [index, question] of input.questions.entries()) {
    const { preparing, attachments } = perQuestion[index]!;
    if (preparing > 0) return { status: "preparing" };
    if (attachments.length === 0) continue;
    const uploaded = getUploadedAttachments({
      environmentId: input.environmentId,
      images: attachments,
    });
    if (!uploaded) return { status: "not-uploaded" };
    attachmentsByQuestionId[question.id] = uploaded as UserInputAttachments[string];
  }
  return { status: "ready", attachmentsByQuestionId };
}
