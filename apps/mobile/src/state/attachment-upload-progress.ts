import type { MessageId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./atom-registry";

export const attachmentUploadProgressByIdAtom = Atom.make<Record<string, number>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:attachment-upload-progress"),
);

export function setAttachmentUploadProgress(
  attachmentId: string,
  uploadedBytes: number,
  totalBytes: number,
): void {
  appAtomRegistry.set(attachmentUploadProgressByIdAtom, {
    ...appAtomRegistry.get(attachmentUploadProgressByIdAtom),
    [attachmentId]: totalBytes > 0 ? Math.round((uploadedBytes / totalBytes) * 100) : 0,
  });
}

export function clearAttachmentUploadProgress(attachmentIds: ReadonlyArray<string>): void {
  const removedIds = new Set(attachmentIds);
  appAtomRegistry.set(
    attachmentUploadProgressByIdAtom,
    Object.fromEntries(
      Object.entries(appAtomRegistry.get(attachmentUploadProgressByIdAtom)).filter(
        ([attachmentId]) => !removedIds.has(attachmentId),
      ),
    ),
  );
}

export const dispatchingQueuedMessageIdAtom = Atom.make<MessageId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-outbox:dispatching-message-id"),
);
