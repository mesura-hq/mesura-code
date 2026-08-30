import * as Schema from "effect/Schema";
import { AttachmentUploadId } from "@t3tools/contracts";

const DraftComposerRemoteUploadSchema = Schema.Struct({
  uploadId: AttachmentUploadId,
  uploadPath: Schema.String,
  completed: Schema.Boolean,
});

export const DraftComposerImageAttachmentSchema = Schema.Struct({
  id: Schema.String,
  previewUri: Schema.String,
  type: Schema.Literal("image"),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  dataUrl: Schema.String,
  remoteUpload: Schema.optional(DraftComposerRemoteUploadSchema),
});

export const DraftComposerFileAttachmentSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("file"),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  uri: Schema.String,
  remoteUpload: Schema.optional(DraftComposerRemoteUploadSchema),
});

export const DraftComposerAttachmentSchema = Schema.Union([
  DraftComposerImageAttachmentSchema,
  DraftComposerFileAttachmentSchema,
]);
