import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { PendingUserInputDraftAnswer } from "@t3tools/client-runtime/state/pending-user-input";
import {
  onThreadRequestsResolved,
  pruneResolvedUserInputDrafts,
  resolvedQuestionDraftKeys,
  userInputDraftKey,
} from "@t3tools/client-runtime/state/thread-requests";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import type {
  EnvironmentId,
  RuntimeRequestId,
  ScopedThreadRef,
  ThreadContextRecord,
  ThreadId,
} from "@t3tools/contracts";
import { create } from "zustand";
import {
  validateComposerAttachmentFile,
  prepareComposerImageAttachment,
} from "./components/chat/composerAttachmentFiles";
import { DraftId, useComposerDraftStore } from "./composerDraftStore";
import { releaseDraftAttachments, startAttachmentUpload } from "./lib/attachmentUploadQueue";
import {
  carryDisplacedCustomAnswerIntoPrompt,
  threadContextsReferencedByAnswer,
} from "./pendingUserInput";

/** Edited question answers, keyed by `userInputDraftKey`; suggested answers are not stored. */
export const usePendingUserInputAnswers = create<
  Record<string, Record<string, PendingUserInputDraftAnswer>>
>(() => ({}));
export const usePendingUserInputQuestionIndex = create<Record<string, number>>(() => ({}));

type AnswerDraftsByRequestKey = Record<string, Record<string, PendingUserInputDraftAnswer>>;
type InlineAnswerDraftSource = (
  environmentId: EnvironmentId,
  threadId: ThreadId,
  unansweredRequestIds: ReadonlyArray<RuntimeRequestId>,
) => AnswerDraftsByRequestKey;
/** Mesura: inline question cards keep their answers in their own store, read here as well. */
let readInlineAnswerDrafts: InlineAnswerDraftSource = () => ({});
export function setInlineAnswerDraftSource(read: InlineAnswerDraftSource): void {
  readInlineAnswerDrafts = read;
}

export function questionAttachmentDraftPrefix(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): string {
  return `${encodeURIComponent(JSON.stringify(environmentId))}:question-${encodeURIComponent(JSON.stringify(threadId))}-`;
}

export function questionAttachmentDraftId(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  requestId: string,
  questionId: string,
): DraftId {
  return DraftId.make(
    `${questionAttachmentDraftPrefix(environmentId, threadId)}${encodeURIComponent(JSON.stringify([requestId, questionId]))}`,
  );
}

type OpenQuestionAttachmentDraft = {
  readonly draftId: DraftId;
  readonly requestKeys: ReadonlyArray<DraftId>;
};

const openQuestionDrafts = new Map<string, OpenQuestionAttachmentDraft>();

export function openQuestionAttachmentDraft(
  threadRef: ScopedThreadRef,
): OpenQuestionAttachmentDraft | null {
  return openQuestionDrafts.get(scopedThreadKey(threadRef)) ?? null;
}

export function countQuestionRequestAttachments(draftId: DraftId): number | null {
  for (const draft of openQuestionDrafts.values()) {
    if (draft.draftId === draftId) return countQuestionAttachments(draft.requestKeys);
  }
  return null;
}

export function trackOpenQuestionAttachmentDraft(
  threadRef: ScopedThreadRef,
  draft: OpenQuestionAttachmentDraft,
): () => void {
  const key = scopedThreadKey(threadRef);
  openQuestionDrafts.set(key, draft);
  return () => {
    if (openQuestionDrafts.get(key) === draft) openQuestionDrafts.delete(key);
  };
}

export const useQuestionAttachmentPreparation = create<{ counts: Record<string, number> }>(() => ({
  counts: {},
}));

export function countQuestionAttachments(keys: ReadonlyArray<DraftId>): number {
  const store = useComposerDraftStore.getState();
  const { counts } = useQuestionAttachmentPreparation.getState();
  return keys.reduce((total, key) => {
    const draft = store.getComposerDraft(key);
    return total + (draft?.images.length ?? 0) + (draft?.files.length ?? 0) + (counts[key] ?? 0);
  }, 0);
}

export function changeQuestionAttachmentPreparation(key: DraftId, delta: number): void {
  useQuestionAttachmentPreparation.setState((state) =>
    delta < 0 && !(key in state.counts)
      ? state
      : {
          counts: { ...state.counts, [key]: Math.max(0, (state.counts[key] ?? 0) + delta) },
        },
  );
}

export function clearQuestionAttachmentDraft(key: DraftId): void {
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(key);
  if (draft) {
    releaseDraftAttachments([...draft.images, ...draft.files]);
    for (const image of draft.images) {
      if (image.previewUrl.startsWith("blob:")) URL.revokeObjectURL(image.previewUrl);
    }
  }
  store.clearComposerContent(key);
  useQuestionAttachmentPreparation.setState(({ counts }) => {
    const next = { ...counts };
    delete next[key];
    return { counts: next };
  });
}

/** Clears the thread's question attachment drafts for every request outside `pendingRequestIds`. */
function pruneResolvedQuestionAttachmentDrafts(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  pendingRequestIds: ReadonlyArray<string>,
): void {
  const keys = new Set([
    ...Object.keys(useComposerDraftStore.getState().draftsByThreadKey),
    ...Object.keys(useQuestionAttachmentPreparation.getState().counts),
  ]);
  const prefix = questionAttachmentDraftPrefix(environmentId, threadId);
  for (const key of resolvedQuestionDraftKeys(keys, prefix, pendingRequestIds)) {
    clearQuestionAttachmentDraft(DraftId.make(key));
  }
}

/** Stage question files in the same drafts and upload queue as composer attachments. */
export async function stageQuestionAttachments(input: {
  environmentId: EnvironmentId;
  target: DraftId;
  requestTargets: ReadonlyArray<DraftId>;
  files: ReadonlyArray<File>;
  maxFileBytes: number | null;
  isPending: () => boolean;
}): Promise<string | null> {
  let error: string | null = null;
  const accepted: Array<Extract<ReturnType<typeof validateComposerAttachmentFile>, { ok: true }>> =
    [];
  let reserved = countQuestionAttachments(input.requestTargets);
  for (const file of input.files) {
    if (reserved >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per request.`;
      continue;
    }
    const validated = validateComposerAttachmentFile(file, input.maxFileBytes);
    if (!validated.ok) {
      error = validated.error;
      continue;
    }
    accepted.push(validated);
    reserved += 1;
  }
  changeQuestionAttachmentPreparation(input.target, accepted.length);
  try {
    for (const item of accepted) {
      if (!input.isPending()) break;
      const prepared =
        item.kind === "image"
          ? await prepareComposerImageAttachment(item.file)
          : { ok: true as const, attachment: item.attachment };
      if (!prepared.ok) {
        error = prepared.error;
        continue;
      }
      const attachment = prepared.attachment;
      if (!input.isPending()) {
        if (attachment.type === "image") URL.revokeObjectURL(attachment.previewUrl);
        break;
      }
      const store = useComposerDraftStore.getState();
      const ids =
        attachment.type === "image"
          ? store.addImages(input.target, [attachment])
          : store.addFiles(input.target, [attachment], { appendReference: false });
      if (ids.includes(attachment.id))
        startAttachmentUpload({
          environmentId: input.environmentId,
          image: attachment,
          draftTarget: input.target,
        });
      else if (attachment.type === "image") URL.revokeObjectURL(attachment.previewUrl);
    }
  } finally {
    changeQuestionAttachmentPreparation(input.target, -accepted.length);
  }
  return error;
}
/**
 * Stop cancels an open question and a provider timeout expires it; neither sent
 * the typed answers, so they move to the thread's own draft (not a queued-message
 * edit the composer may be showing) with the thread chips they reference.
 */
function returnUnsentAnswersToThreadDraft(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  unansweredRequestIds: ReadonlyArray<RuntimeRequestId>,
): void {
  const answers = {
    ...usePendingUserInputAnswers.getState(),
    ...readInlineAnswerDrafts(environmentId, threadId, unansweredRequestIds),
  };
  const store = useComposerDraftStore.getState();
  const target = scopeThreadRef(environmentId, threadId);
  const currentPrompt = store.getComposerDraft(target)?.prompt ?? "";
  let prompt = currentPrompt;
  const threadContexts: ThreadContextRecord[] = [];
  for (const requestId of unansweredRequestIds) {
    const drafts = answers[userInputDraftKey(environmentId, threadId, requestId)] ?? {};
    for (const [questionId, { customAnswer }] of Object.entries(drafts)) {
      const nextPrompt = carryDisplacedCustomAnswerIntoPrompt(prompt, customAnswer);
      if (nextPrompt === prompt) continue;
      prompt = nextPrompt;
      const questionDraft = store.getComposerDraft(
        questionAttachmentDraftId(environmentId, threadId, requestId, questionId),
      );
      threadContexts.push(
        ...threadContextsReferencedByAnswer(
          customAnswer ?? "",
          questionDraft?.threadContexts ?? [],
        ),
      );
    }
  }
  if (prompt === currentPrompt) return;
  store.setPrompt(target, prompt);
  store.addThreadContexts(target, threadContexts, { appendReference: false });
}

// Resolution can come from anywhere: another device, an interrupt, the turn
// ending, or a reload over drafts for requests resolved meanwhile. One listener,
// so unsent answers and their chips are read before their drafts are pruned.
onThreadRequestsResolved(({ environmentId, threadId, pendingRequestIds, unansweredRequestIds }) => {
  returnUnsentAnswersToThreadDraft(environmentId, threadId, unansweredRequestIds);
  usePendingUserInputAnswers.setState(
    (existing) =>
      pruneResolvedUserInputDrafts(existing, environmentId, threadId, pendingRequestIds),
    true,
  );
  usePendingUserInputQuestionIndex.setState(
    (existing) =>
      pruneResolvedUserInputDrafts(existing, environmentId, threadId, pendingRequestIds),
    true,
  );
  pruneResolvedQuestionAttachmentDrafts(environmentId, threadId, pendingRequestIds);
});
