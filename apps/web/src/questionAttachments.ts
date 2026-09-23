import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import {
  validateComposerAttachmentFile,
  prepareComposerImageAttachment,
} from "./components/chat/composerAttachmentFiles";
import { startAttachmentUpload } from "./lib/attachmentUploadQueue";
import type { ApprovalRequestId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { DraftId, useComposerDraftStore } from "./composerDraftStore";
import { releaseDraftAttachments } from "./lib/attachmentUploadQueue";

export function questionAttachmentDraftPrefix(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): string {
  return `${encodeURIComponent(JSON.stringify(environmentId))}:question-${encodeURIComponent(JSON.stringify(threadId))}-`;
}

export function questionAttachmentDraftId(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  questionId: string,
): DraftId {
  return DraftId.make(
    `${questionAttachmentDraftPrefix(environmentId, threadId)}${encodeURIComponent(JSON.stringify([requestId, questionId]))}`,
  );
}

export const useQuestionAttachmentPreparation = create<{ counts: Record<string, number> }>(() => ({
  counts: {},
}));

/** Count both staged files and in-flight preparation against the shared question limit. */
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
