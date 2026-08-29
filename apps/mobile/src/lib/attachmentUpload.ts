import {
  AttachmentUploadRequestError,
  cancelEnvironmentAttachmentUpload,
  uploadEnvironmentAttachment,
} from "@t3tools/client-runtime/state/attachment-upload-http";
import { ManagedRelayDpopSigner } from "@t3tools/client-runtime/relay";
import type { EnvironmentId, ThreadId, UploadedChatAttachmentReference } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { DraftComposerAttachment, DraftComposerRemoteUpload } from "./composerImages";
import { appAtomRegistry } from "../state/atom-registry";
import { environmentSession } from "../state/session";
import { runtime } from "./runtime";

async function attachmentBlob(attachment: DraftComposerAttachment): Promise<Blob> {
  if (attachment.type === "image") {
    if (attachment.previewUri.startsWith("file:")) {
      const { File } = await import("expo-file-system");
      return new File(attachment.previewUri);
    }
    return fetch(attachment.dataUrl).then((response) => response.blob());
  }
  const { File } = await import("expo-file-system");
  return new File(attachment.uri);
}

export async function uploadMobileComposerAttachments(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly onProgress?: (attachmentId: string, uploadedBytes: number, totalBytes: number) => void;
  readonly onUploadState?: (
    attachmentId: string,
    remoteUpload: DraftComposerRemoteUpload,
  ) => Promise<void>;
}): Promise<ReadonlyArray<UploadedChatAttachmentReference>> {
  const preparedOption = appAtomRegistry.get(
    environmentSession.preparedConnectionValueAtom(input.environmentId),
  );
  if (Option.isNone(preparedOption)) throw new Error("The environment is not connected.");
  const prepared = preparedOption.value;
  const references: UploadedChatAttachmentReference[] = [];
  for (const attachment of input.attachments) {
    if (attachment.remoteUpload?.completed) {
      references.push({ type: "uploaded", uploadId: attachment.remoteUpload.uploadId });
      input.onProgress?.(attachment.id, attachment.sizeBytes, attachment.sizeBytes);
      continue;
    }
    const file = await attachmentBlob(attachment);
    const uploaded = await runtime.runPromise(
      Effect.gen(function* () {
        const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
        return yield* uploadEnvironmentAttachment({
          prepared,
          signer,
          threadId: input.threadId,
          kind: attachment.type,
          file,
          name: attachment.name,
          mimeType: attachment.mimeType,
          ...(attachment.remoteUpload
            ? {
                existingUpload: {
                  uploadId: attachment.remoteUpload.uploadId,
                  uploadPath: attachment.remoteUpload.uploadPath,
                },
              }
            : {}),
          onCreated: (uploadId, uploadPath) =>
            input.onUploadState?.(attachment.id, {
              uploadId,
              uploadPath,
              completed: false,
            }),
          onProgress: (uploadedBytes, totalBytes) =>
            input.onProgress?.(attachment.id, uploadedBytes, totalBytes),
        }).pipe(
          Effect.mapError(
            (cause) =>
              new AttachmentUploadRequestError({
                method: "UPLOAD",
                url: prepared.httpBaseUrl,
                cause,
              }),
          ),
        );
      }),
    );
    await input.onUploadState?.(attachment.id, {
      uploadId: uploaded.uploadId,
      uploadPath: uploaded.uploadPath,
      completed: true,
    });
    references.push({ type: "uploaded", uploadId: uploaded.uploadId });
  }
  return references;
}

export async function cancelMobileComposerAttachmentUploads(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
}): Promise<void> {
  const preparedOption = appAtomRegistry.get(
    environmentSession.preparedConnectionValueAtom(input.environmentId),
  );
  if (Option.isNone(preparedOption)) return;
  await Promise.allSettled(
    input.attachments.flatMap((attachment) => {
      const uploadPath = attachment.remoteUpload?.uploadPath;
      if (!uploadPath) return [];
      return [
        runtime.runPromise(
          Effect.gen(function* () {
            const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
            yield* cancelEnvironmentAttachmentUpload({
              prepared: preparedOption.value,
              signer,
              uploadPath,
            });
          }),
        ),
      ];
    }),
  );
}
