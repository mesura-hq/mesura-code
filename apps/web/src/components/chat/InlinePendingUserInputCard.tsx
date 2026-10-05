import type { PendingUserInputError } from "../../pendingUserInputDraftStore";
import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CheckIcon, PaperclipIcon, XIcon } from "lucide-react";
import type {
  ApprovalRequestId,
  EnvironmentId,
  ThreadId,
  UserInputQuestion,
} from "@t3tools/contracts";
import type { PendingUserInput } from "@t3tools/client-runtime/pending-requests";
import { useShallow } from "zustand/react/shallow";
import {
  buildPendingUserInputAnswers,
  resolvePendingUserInputAnswer,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import {
  editPendingUserInputAnswerText,
  EMPTY_QUESTION_ANSWERS,
  pendingUserInputRequestKey,
  usePendingUserInputDraftStore,
} from "../../pendingUserInputDraftStore";

const EMPTY_VOICED_QUESTION_IDS: ReadonlyArray<string> = [];
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import {
  questionAttachmentDraftId,
  stageQuestionAttachments,
  useQuestionAttachmentPreparation,
} from "../../questionAttachments";
import {
  releaseDraftAttachment,
  retryAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import { DictationStartButton } from "../../dictation/DictationControls";
import { registerDictationComposer } from "../../dictation/dictationController";
import {
  armQuestionSendWhenReady,
  disarmQuestionSendWhenReady,
  useQuestionSendWhenReadyArmed,
} from "../../dictation/sendWhenReady";
import { countPendingDictationSlots } from "@t3tools/shared/dictationSlots";
import { insertDictationSlotAt } from "../../dictation/dictationSlotEdits";
import { SendWhenReadyNotice } from "../../dictation/SendWhenReadyBanner";
import { completeQuestionDraftAnswers } from "../../pendingUserInputResponse";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface InlinePendingUserInputContext {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  requests: ReadonlyArray<PendingUserInput>;
  supportsAttachments: boolean;
  maxFileBytes: number | null;
  focusRequestId?: ApprovalRequestId | null;
  onQuestionFocused?: () => void;
  unavailable: boolean;
  respondingRequestIds: ReadonlyArray<ApprovalRequestId>;
  onRespond: (requestId: ApprovalRequestId, answers: Record<string, unknown>) => Promise<boolean>;
  onDismiss: (requestId: ApprovalRequestId) => Promise<boolean>;
}

export const InlinePendingUserInputCard = memo(function InlinePendingUserInputCard({
  request,
  context,
}: {
  request: PendingUserInput;
  context: InlinePendingUserInputContext;
}) {
  const { environmentId, threadId } = context;
  const key = pendingUserInputRequestKey(environmentId, threadId, request.requestId);
  const answers = usePendingUserInputDraftStore(
    (state) => state.requests[key]?.answers ?? EMPTY_QUESTION_ANSWERS,
  );
  const error = usePendingUserInputDraftStore((state) => state.requests[key]?.error ?? null);
  const setError = (value: PendingUserInputError | null) =>
    usePendingUserInputDraftStore.getState().setError(key, value);
  const [missingQuestionId, setMissingQuestionId] = useState<string | null>(null);
  const fields = useRef(new Map<string, HTMLTextAreaElement>());
  const unregisterDictation = useRef<(() => void) | null>(null);
  const responding = context.respondingRequestIds.includes(request.requestId);
  const targets = request.questions.map((question) =>
    questionAttachmentDraftId(environmentId, threadId, request.requestId, question.id),
  );
  const drafts = useComposerDraftStore(
    useShallow((state) => targets.map((target) => state.draftsByThreadKey[target])),
  );
  const preparations = useQuestionAttachmentPreparation(
    useShallow((state) => targets.map((target) => state.counts[target] ?? 0)),
  );
  const uploads = useAttachmentUploadStore(
    useShallow((state) =>
      Object.fromEntries(
        drafts
          .flatMap((draft) => [...(draft?.images ?? []), ...(draft?.files ?? [])])
          .map((attachment) => [attachment.id, state.uploadsByImageId[attachment.id]]),
      ),
    ),
  );
  const voicedQuestionIds = usePendingUserInputDraftStore(
    (state) => state.requests[key]?.voicedQuestionIds ?? EMPTY_VOICED_QUESTION_IDS,
  );
  const completeDrafts = completeQuestionDraftAnswers({
    questions: request.questions,
    answers,
    attachments: drafts.map((draft) => (draft ? [...draft.images, ...draft.files] : [])),
    preparations,
    uploads,
    supportsAttachments: context.supportsAttachments,
    environmentId,
    voicedQuestionIds,
  });
  const answerCount = request.questions.filter(
    (question) => resolvePendingUserInputAnswer(question, completeDrafts[question.id]) !== null,
  ).length;
  const blockedUploads = Object.values(completeDrafts).some((draft) => draft.attachmentsBlocked);

  useEffect(() => () => unregisterDictation.current?.(), []);

  const focusQuestion = (question: UserInputQuestion) => {
    unregisterDictation.current?.();
    unregisterDictation.current = null;
    if (question.allowCustomAnswer === false) return;
    const draftId = questionAttachmentDraftId(
      environmentId,
      threadId,
      request.requestId,
      question.id,
    );
    // A recording drops its marker into this answer while the question has focus.
    unregisterDictation.current = registerDictationComposer({
      environmentId,
      target: { kind: "draft", draftId },
      draftTarget: DraftId.make(draftId),
      // At the field's caret, read when the recording stops; at the end once it is gone.
      insertSlot: (slot) => {
        const field = fields.current.get(question.id);
        if (!field?.isConnected) return false;
        const caret = field.selectionStart ?? field.value.length;
        return editPendingUserInputAnswerText(key, question.id, (text) =>
          insertDictationSlotAt(text, caret, slot),
        );
      },
      question: { requestKey: key, questionId: question.id },
    });
  };

  const focusAnswerField = (questionId: string | undefined) => {
    const field = questionId ? fields.current.get(questionId) : undefined;
    const focusable = field?.disabled
      ? field
          .closest("[data-question-id]")
          ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      : field;
    focusable?.focus({ preventScroll: true });
    return field;
  };
  // A deferred focus callback used stale completeness after an option changed.
  // Read this render's answers so the shortcut reaches the first missing answer.
  useEffect(() => {
    if (context.focusRequestId !== request.requestId) return;
    const question =
      request.questions.find(
        (entry) => resolvePendingUserInputAnswer(entry, completeDrafts[entry.id]) === null,
      ) ?? request.questions[0];
    focusAnswerField(question?.id);
    context.onQuestionFocused?.();
  }, [context, request, completeDrafts, focusAnswerField]);
  const sendWhenReadyArmed = useQuestionSendWhenReadyArmed(key);
  const pendingTranscriptions = request.questions.reduce(
    (count, question) =>
      count + countPendingDictationSlots(answers[question.id]?.customAnswer ?? ""),
    0,
  );
  const submit = async () => {
    if (responding || context.unavailable) return;
    // A transcription still pending in an answer: submit once it lands.
    if (pendingTranscriptions > 0) {
      armQuestionSendWhenReady(key);
      return;
    }
    const built = buildPendingUserInputAnswers(request.questions, completeDrafts);
    if (!built) {
      const missing = request.questions.find(
        (question) => resolvePendingUserInputAnswer(question, completeDrafts[question.id]) === null,
      );
      setMissingQuestionId(missing?.id ?? null);
      focusAnswerField(missing?.id)?.scrollIntoView?.({ block: "nearest" });
      return;
    }
    setMissingQuestionId(null);
    setError(null);
    try {
      if (!(await context.onRespond(request.requestId, built)))
        setError({ kind: "respond", message: "Could not send answers. Your draft is saved." });
    } catch {
      setError({ kind: "respond", message: "Could not send answers. Your draft is saved." });
    }
  };

  return (
    <section
      data-pending-user-input-request-id={request.requestId}
      aria-label="Questions from the agent"
      className="my-2 overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
        <div>
          <h2 className="text-sm font-semibold">Your input</h2>
          <p className="text-xs text-muted-foreground">
            Answer the questions below, then submit together.
          </p>
        </div>
        {request.dismissible ? (
          <div>
            <button
              type="button"
              aria-label="Dismiss question without answering"
              disabled={responding || context.unavailable}
              onClick={() => {
                void context
                  .onDismiss(request.requestId)
                  .then((ok) => {
                    if (!ok)
                      setError({
                        kind: "dismiss",
                        message: "Could not dismiss the request. Try again.",
                      });
                  })
                  .catch(() =>
                    setError({
                      kind: "dismiss",
                      message: "Could not dismiss the request. Try again.",
                    }),
                  );
              }}
              className="rounded p-1.5 text-muted-foreground hover:bg-muted"
            >
              <XIcon className="size-4" />
            </button>
            {error?.kind === "dismiss" ? (
              <p role="alert" className="text-xs text-destructive">
                {error.message}
              </p>
            ) : null}
          </div>
        ) : null}
      </header>
      <div className="divide-y divide-border">
        {request.questions.map((question, index) => (
          <QuestionField
            key={question.id}
            question={question}
            number={index + 1}
            answer={answers[question.id]}
            invalid={
              missingQuestionId === question.id &&
              resolvePendingUserInputAnswer(question, completeDrafts[question.id]) === null
            }
            disabled={responding}
            onFocus={() => focusQuestion(question)}
            onText={(text) =>
              usePendingUserInputDraftStore.getState().update(key, question, { text })
            }
            onOption={(option) =>
              usePendingUserInputDraftStore.getState().update(key, question, { option })
            }
            fieldRef={(element) => {
              if (element) fields.current.set(question.id, element);
              else fields.current.delete(question.id);
            }}
            context={context}
            request={request}
          />
        ))}
      </div>
      {sendWhenReadyArmed && pendingTranscriptions > 0 ? (
        <div className="border-t border-border px-4 py-2 sm:px-5">
          <SendWhenReadyNotice
            pendingCount={pendingTranscriptions}
            onCancel={() => disarmQuestionSendWhenReady(key)}
          />
        </div>
      ) : null}
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/20 px-4 py-3 sm:px-5">
        <div className="text-xs text-muted-foreground" aria-live="polite">
          {context.unavailable
            ? "Reconnecting. Your answers are saved."
            : `${answerCount} of ${request.questions.length} answered`}
          {error?.kind === "respond" ? (
            <p role="alert" className="mt-1 text-destructive">
              {error.message}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          disabled={responding || context.unavailable || blockedUploads}
          onClick={() => void submit()}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {responding ? "Sending…" : error?.kind === "respond" ? "Retry" : "Submit"}
        </button>
      </footer>
    </section>
  );
});

function QuestionField({
  question,
  number,
  answer,
  invalid,
  disabled,
  onFocus,
  onText,
  onOption,
  fieldRef,
  context,
  request,
}: {
  question: UserInputQuestion;
  number: number;
  answer: PendingUserInputDraftAnswer | undefined;
  invalid: boolean;
  disabled: boolean;
  onFocus: () => void;
  onText: (text: string) => void;
  onOption: (value: string) => void;
  fieldRef: (element: HTMLTextAreaElement | null) => void;
  context: InlinePendingUserInputContext;
  request: PendingUserInput;
}) {
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const target = questionAttachmentDraftId(
    context.environmentId,
    context.threadId,
    request.requestId,
    question.id,
  );
  const draft = useComposerDraftStore((state) => state.draftsByThreadKey[target]);
  const preparing = useQuestionAttachmentPreparation((state) => state.counts[target] ?? 0);
  const uploads = useAttachmentUploadStore(
    useShallow((state) =>
      Object.fromEntries(
        [...(draft?.images ?? []), ...(draft?.files ?? [])].map((attachment) => [
          attachment.id,
          state.uploadsByImageId[attachment.id],
        ]),
      ),
    ),
  );
  const attachments = [...(draft?.images ?? []), ...(draft?.files ?? [])];
  const canAttach =
    context.supportsAttachments && question.allowCustomAnswer !== false && !disabled;
  useEffect(() => {
    if (!context.supportsAttachments) return;
    for (const image of [...(draft?.images ?? []), ...(draft?.files ?? [])]) {
      startAttachmentUpload({ environmentId: context.environmentId, image, draftTarget: target });
    }
  }, [draft?.images, draft?.files, context.environmentId, context.supportsAttachments, target]);
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element || element.value !== (answer?.customAnswer ?? "")) return;
    element.style.height = "auto";
    element.style.height = `${Math.max(72, element.scrollHeight)}px`;
  }, [answer?.customAnswer]);
  const addFiles = async (files: File[]) => {
    if (!canAttach || files.length === 0) return;
    try {
      setAttachmentError(
        await stageQuestionAttachments({
          environmentId: context.environmentId,
          target,
          requestTargets: request.questions.map((item) =>
            questionAttachmentDraftId(
              context.environmentId,
              context.threadId,
              request.requestId,
              item.id,
            ),
          ),
          files,
          maxFileBytes: context.maxFileBytes,
          // Resolution removes this reservation; virtual unmount keeps it.
          isPending: () => (useQuestionAttachmentPreparation.getState().counts[target] ?? 0) > 0,
        }),
      );
    } catch {
      setAttachmentError("The attachment could not be prepared. Try again.");
    }
  };
  return (
    <div
      data-question-id={question.id}
      className="px-4 py-4 sm:px-5 sm:py-5"
      onFocusCapture={onFocus}
      onKeyDown={(event) => {
        if (
          disabled ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          event.target instanceof HTMLTextAreaElement ||
          event.target instanceof HTMLInputElement
        )
          return;
        if (!/^[1-9]$/.test(event.key)) return;
        const option = question.options[Number(event.key) - 1];
        if (option) {
          event.preventDefault();
          event.stopPropagation();
          onOption(option.value ?? option.label);
        }
      }}
      onDragOver={(event) => {
        if (canAttach) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!canAttach) return;
        event.preventDefault();
        void addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <div className="mb-3 flex gap-3">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums">
          {number}
        </span>
        <div>
          <p className="text-xs font-medium text-muted-foreground">{question.header}</p>
          <h3 id={`${id}-question`} className="mt-0.5 whitespace-pre-wrap text-sm font-medium">
            {question.question}
          </h3>
        </div>
      </div>
      <div className="space-y-1.5" role="group" aria-labelledby={`${id}-question`}>
        {question.options.map((option, index) => {
          const value = option.value ?? option.label;
          const selected = answer?.selectedOptionValues?.includes(value) ?? false;
          return (
            <button
              type="button"
              key={value}
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => onOption(value)}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-primary",
                selected ? "border-primary/45 bg-primary/10" : "border-border hover:bg-muted/40",
              )}
            >
              <span
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center border",
                  question.multiSelect ? "rounded" : "rounded-full",
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-muted-foreground/50",
                )}
              >
                {selected ? <CheckIcon className="size-3" /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{option.label}</span>
                {option.description && option.description !== option.label ? (
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {option.description}
                  </span>
                ) : null}
              </span>
              {index < 9 ? (
                <kbd className="text-[10px] text-muted-foreground">{index + 1}</kbd>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="mb-1.5 mt-3 flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
          {question.options.length ? "Additional detail" : "Your answer"}
        </label>
        {question.allowCustomAnswer !== false ? (
          <div className="flex items-center gap-1">
            {context.supportsAttachments ? (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  onChange={(event) => {
                    void addFiles(Array.from(event.target.files ?? []));
                    event.target.value = "";
                  }}
                />
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        disabled={!canAttach || context.unavailable}
                        aria-label={`Attach files to ${question.question}`}
                        onClick={() => fileInput.current?.click()}
                        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
                      />
                    }
                  >
                    <PaperclipIcon className="size-4" />
                  </TooltipTrigger>
                  <TooltipPopup>Attach files</TooltipPopup>
                </Tooltip>
              </>
            ) : null}
            <DictationStartButton
              compact
              disabled={disabled || context.unavailable}
              targetLabel={question.header || question.question}
              onBeforeStart={onFocus}
            />
          </div>
        ) : null}
      </div>
      <div>
        <textarea
          id={id}
          ref={(element) => {
            textarea.current = element;
            fieldRef(element);
          }}
          value={answer?.customAnswer ?? ""}
          disabled={disabled || question.allowCustomAnswer === false}
          aria-label={question.question}
          aria-invalid={invalid || undefined}
          aria-describedby={
            invalid
              ? `${id}-missing`
              : question.allowCustomAnswer === false
                ? `${id}-choice-only`
                : undefined
          }
          onChange={(event) => onText(event.target.value)}
          onPaste={(event) => {
            if (event.clipboardData.files.length && canAttach) {
              event.preventDefault();
              void addFiles(Array.from(event.clipboardData.files));
            }
          }}
          rows={2}
          placeholder={
            question.options.length ? "Add context to your selection…" : "Type your answer…"
          }
          className="block min-h-18 w-full resize-none overflow-hidden rounded-lg border border-border bg-background px-3 py-2 text-sm leading-6 outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 disabled:opacity-50"
        />
        {question.allowCustomAnswer === false ? (
          <p id={`${id}-choice-only`} className="mt-1 text-xs text-muted-foreground">
            This provider accepts only a listed choice.
          </p>
        ) : null}
        {invalid ? (
          <p id={`${id}-missing`} role="alert" className="mt-1 text-xs text-destructive">
            Answer this question before submitting.
          </p>
        ) : null}
        {preparing > 0 ? (
          <p role="status" className="mt-2 text-xs text-muted-foreground">
            Preparing attachments…
          </p>
        ) : null}
        {attachments.map((attachment) => {
          const upload = uploads[attachment.id];
          return (
            <div
              key={attachment.id}
              className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs"
            >
              <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
              <span role="status">
                {upload?.status === "ready"
                  ? "Ready"
                  : upload?.status === "failed"
                    ? upload.reason
                    : `Uploading ${Math.round((upload?.progress ?? 0) * 100)}%`}
              </span>
              {upload?.status === "failed" ? (
                <button
                  type="button"
                  disabled={disabled || context.unavailable}
                  onClick={() =>
                    retryAttachmentUpload({
                      environmentId: context.environmentId,
                      image: attachment,
                      draftTarget: target,
                    })
                  }
                >
                  Retry upload
                </button>
              ) : null}
              <button
                type="button"
                disabled={disabled}
                aria-label={`Remove ${attachment.name}`}
                onClick={() => {
                  releaseDraftAttachment(attachment);
                  const store = useComposerDraftStore.getState();
                  if (attachment.type === "image") {
                    store.removeImage(target, attachment.id);
                    URL.revokeObjectURL(attachment.previewUrl);
                  } else store.removeFile(target, attachment.id);
                }}
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
          );
        })}
        {attachmentError ? (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {attachmentError}
          </p>
        ) : null}
      </div>
    </div>
  );
}
