import {
  AttachmentUploadRequestError,
  cancelEnvironmentAttachmentUpload,
  uploadEnvironmentAttachment,
  verifyEnvironmentAttachmentUpload,
} from "@t3tools/client-runtime/state/attachment-upload-http";
import { ManagedRelayDpopSigner } from "@t3tools/client-runtime/relay";
import type { AttachmentUploadKind, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { runtime } from "./runtime";
import { readPreparedConnection } from "../state/session";

function requirePreparedConnection(environmentId: EnvironmentId) {
  const prepared = readPreparedConnection(environmentId);
  if (!prepared) throw new Error("The environment is not connected.");
  return prepared;
}

export async function uploadComposerFile(input: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  kind: AttachmentUploadKind;
  file: File;
  signal: AbortSignal;
  onProgress: (uploadedBytes: number, totalBytes: number) => void;
  onCreated?: (uploadId: string, uploadPath: string) => void;
}) {
  const prepared = requirePreparedConnection(input.environmentId);
  return runtime.runPromise(
    Effect.gen(function* () {
      const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
      return yield* uploadEnvironmentAttachment({
        prepared,
        signer,
        threadId: input.threadId,
        kind: input.kind,
        file: input.file,
        name: input.file.name || "attachment.bin",
        mimeType: input.file.type || "application/octet-stream",
        signal: input.signal,
        onProgress: input.onProgress,
        ...(input.onCreated ? { onCreated: input.onCreated } : {}),
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
}

export async function cancelComposerFileUpload(input: {
  environmentId: EnvironmentId;
  uploadPath: string;
}) {
  const prepared = requirePreparedConnection(input.environmentId);
  return runtime.runPromise(
    Effect.gen(function* () {
      const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
      yield* cancelEnvironmentAttachmentUpload({ prepared, signer, uploadPath: input.uploadPath });
    }),
  );
}

export async function verifyComposerFileUpload(input: {
  environmentId: EnvironmentId;
  uploadPath: string;
}) {
  const prepared = requirePreparedConnection(input.environmentId);
  return runtime.runPromise(
    Effect.gen(function* () {
      const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
      yield* verifyEnvironmentAttachmentUpload({
        prepared,
        signer,
        uploadPath: input.uploadPath,
      });
    }),
  );
}
