import type { DictationJobId, EnvironmentId } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/unstable/reactivity";

import {
  deletePendingAttachmentUpload,
  runAttachmentUploadCycle,
  type AttachmentByteUpload,
} from "../state/attachments.ts";

type UploadCycleInput<E, RE> = Parameters<typeof runAttachmentUploadCycle<E, RE>>[0];

/**
 * Uploads one recording through the signed attachment route and returns its attachment id.
 * A recording that did not reach the server has its pending upload deleted, and the failure is
 * thrown, so the caller marks the job failed. Each client supplies only its byte transport.
 */
export async function uploadDictationRecording<E, RE>(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly createUploadUrl: UploadCycleInput<E, RE>["createUploadUrl"];
  readonly remove: UploadCycleInput<E, RE>["remove"];
  readonly environmentId: EnvironmentId;
  readonly jobId: DictationJobId;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly resolveUploadUrl: (relativeUrl: string) => string | null;
  readonly transport: (url: string) => AttachmentByteUpload;
}): Promise<string> {
  const extension = input.mimeType.startsWith("audio/mp4") ? "m4a" : "webm";
  const result = await runAttachmentUploadCycle({
    registry: input.registry,
    createUploadUrl: input.createUploadUrl,
    remove: input.remove,
    environmentId: input.environmentId,
    upload: {
      type: "file",
      name: `dictation-${input.jobId}.${extension}`,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
    },
    resolveUploadUrl: input.resolveUploadUrl,
    transport: input.transport,
  });
  if (result.status === "uploaded") return result.attachmentId;
  if (result.attachmentId) {
    deletePendingAttachmentUpload({
      registry: input.registry,
      remove: input.remove,
      environmentId: input.environmentId,
      attachmentId: result.attachmentId,
    });
  }
  throw result.status === "failed" ? result.error : new Error("The upload was cancelled.");
}
