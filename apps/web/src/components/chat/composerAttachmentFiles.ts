import { randomUUID } from "../../lib/utils";
import {
  type EnvironmentId,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import {
  clampFileAttachmentUploadBytes,
  fileAttachmentTooLargeMessage,
} from "@t3tools/client-runtime/state/attachments";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import { isHeicImageFile, prepareImageForAttachment } from "../../lib/imageCompression";
import { isVideoAttachment, videoMimeType } from "../../types";
import { isSvgAttachment } from "@t3tools/shared/image";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/mediaPreview";

type ComposerAttachmentFileKind = "image" | "file" | "unsupported-image";

interface FileAttachmentCapabilityState {
  readonly attachmentUploadsCapabilityKnown: boolean;
  readonly supportsAttachmentUploads: boolean;
  readonly maxFileAttachmentBytes: number | null;
}

const IMAGE_MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/**
 * Some sources (drags from other apps, files piped through a shell) hand over a
 * `File` with an empty or generic MIME type.
 */
function inferImageMimeTypeFromName(name: string): string | null {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) {
    return null;
  }
  return IMAGE_MIME_TYPE_BY_EXTENSION[name.slice(dotIndex + 1).toLowerCase()] ?? null;
}

function inferImageMimeTypeForUnknownFile(file: Pick<File, "name" | "type">): string | null {
  const mimeType = file.type.toLowerCase();
  if (mimeType !== "" && mimeType !== "application/octet-stream") {
    return null;
  }
  return inferImageMimeTypeFromName(file.name);
}

export function normalizeComposerImageFileMimeType(file: File): File {
  const inferredMimeType = inferImageMimeTypeForUnknownFile(file);
  if (!inferredMimeType) {
    return file;
  }
  return new File([file], file.name, {
    type: inferredMimeType,
    lastModified: file.lastModified,
  });
}

function isDngFile(file: Pick<File, "name" | "type">): boolean {
  const mimeType = file.type.split(";", 1)[0]?.trim().toLowerCase();
  return (
    file.name.toLowerCase().endsWith(".dng") ||
    mimeType === "image/dng" ||
    mimeType === "image/x-dng" ||
    mimeType === "image/x-adobe-dng"
  );
}

export function composerFileAttachmentMimeType(file: Pick<File, "name" | "type">): string {
  // Downstream image detection uses MIME, even for attachments staged as files.
  if (isDngFile(file)) return "image/x-adobe-dng";
  if (isSvgAttachment({ name: file.name, mimeType: file.type })) return "image/svg+xml";
  return (
    videoMimeType({ name: file.name, mimeType: file.type }) ??
    (file.type || "application/octet-stream")
  );
}

export function classifyComposerAttachmentFile(
  file: Pick<File, "name" | "type">,
): ComposerAttachmentFileKind {
  if (isSvgAttachment({ name: file.name, mimeType: file.type })) return "file";
  if (isDngFile(file)) return "file";
  if (isHeicImageFile(file)) {
    return "image";
  }
  if (inferImageMimeTypeForUnknownFile(file)) {
    return "image";
  }
  if (!file.type.toLowerCase().startsWith("image/")) {
    return "file";
  }
  if (isProviderSendTurnSupportedImageMimeType(file.type)) return "image";
  // These can be previewed as files, but providers must not receive them as images.
  return isWorkspaceImagePreviewPath(file.name) ? "file" : "unsupported-image";
}

export function isPreviewableComposerVideo(
  file: ComposerFileAttachment,
  environmentId: EnvironmentId,
): boolean {
  return (
    isVideoAttachment(file) &&
    (file.file !== null ||
      (file.uploadedAttachmentId !== undefined && file.uploadEnvironmentId === environmentId))
  );
}

export function composerOtherFilesForPresentation(
  files: ReadonlyArray<ComposerFileAttachment>,
  environmentId: EnvironmentId,
  inlineFileIds: ReadonlySet<string>,
): ComposerFileAttachment[] {
  return files.filter(
    (file) => !isPreviewableComposerVideo(file, environmentId) && !inlineFileIds.has(file.id),
  );
}

export function fileAttachmentStagingLimit(input: FileAttachmentCapabilityState): number | null {
  if (!input.attachmentUploadsCapabilityKnown) {
    return PROVIDER_SEND_TURN_MAX_FILE_BYTES;
  }
  if (!input.supportsAttachmentUploads || input.maxFileAttachmentBytes === null) {
    return null;
  }
  return clampFileAttachmentUploadBytes(input.maxFileAttachmentBytes);
}

export function fileAttachmentCapabilityBlockReason(
  input: FileAttachmentCapabilityState & {
    readonly files: ReadonlyArray<{ readonly name: string; readonly sizeBytes: number }>;
  },
): string | null {
  if (input.files.length === 0) {
    return null;
  }
  if (!input.attachmentUploadsCapabilityKnown) {
    return "Waiting for the server before file attachments can send";
  }
  const maxFileAttachmentBytes = fileAttachmentStagingLimit(input);
  if (maxFileAttachmentBytes === null) {
    return "This server does not accept file attachments right now. Remove the files to send.";
  }
  const oversizedFile = input.files.find((file) => file.sizeBytes > maxFileAttachmentBytes);
  if (oversizedFile) {
    return fileAttachmentTooLargeMessage(oversizedFile.name, maxFileAttachmentBytes);
  }
  return null;
}

/** Release only unpersisted uploads; hydrated files still need their server copies. */
export function attachmentsToReleaseOnUploadCapabilityLoss(
  attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>,
): Array<ComposerImageAttachment | ComposerFileAttachment> {
  return attachments.filter(
    (attachment) => !(attachment.type === "file" && attachment.uploadedAttachmentId !== undefined),
  );
}

export function shouldHandleComposerAttachmentPaste(input: {
  readonly files: ReadonlyArray<File>;
  readonly plainText: string;
}): boolean {
  if (
    input.files.some((file) => {
      if (isDngFile(file)) return true;
      const classification = classifyComposerAttachmentFile(file);
      return (
        classification === "image" ||
        classification === "unsupported-image" ||
        isSvgAttachment({ name: file.name, mimeType: file.type })
      );
    })
  ) {
    return true;
  }

  if (input.plainText.length > 0) {
    return false;
  }

  return input.files.some((file) => classifyComposerAttachmentFile(file) === "file");
}

/** Shared validation and MIME normalization for message and question files. */
export function validateComposerAttachmentFile(
  file: File,
  maxFileBytes: number | null,
):
  | { ok: true; kind: "image"; file: File }
  | { ok: true; kind: "file"; attachment: ComposerFileAttachment }
  | { ok: false; error: string } {
  const kind = classifyComposerAttachmentFile(file);
  if (kind === "unsupported-image")
    return {
      ok: false,
      error: `'${file.name}' is not a supported image type. Attach GIF, HEIC, HEIF, JPEG, PNG, or WebP images.`,
    };
  if (kind === "image") return { ok: true, kind, file: normalizeComposerImageFileMimeType(file) };
  if (maxFileBytes === null)
    return { ok: false, error: "This server does not support file attachments." };
  if (file.size <= 0) return { ok: false, error: `'${file.name}' is empty or could not be read.` };
  if (file.size > maxFileBytes)
    return { ok: false, error: fileAttachmentTooLargeMessage(file.name, maxFileBytes) };
  const mimeType = composerFileAttachmentMimeType(file);
  const normalized =
    file.type === mimeType
      ? file
      : new File([file], file.name, { type: mimeType, lastModified: file.lastModified });
  return {
    ok: true,
    kind,
    attachment: {
      type: "file",
      id: randomUUID(),
      name: file.name || "file",
      mimeType,
      sizeBytes: file.size,
      file: normalized,
    },
  };
}

/** Images share compression, failure messages, and preview ownership on both surfaces. */
export async function prepareComposerImageAttachment(
  file: File,
): Promise<{ ok: true; attachment: ComposerImageAttachment } | { ok: false; error: string }> {
  const prepared = await prepareImageForAttachment(
    normalizeComposerImageFileMimeType(file),
    PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  );
  if (!prepared.ok)
    return {
      ok: false,
      error:
        prepared.reason === "unreadable"
          ? `'${file.name}' could not be read as an image.`
          : `'${file.name}' is too large to attach, even after compression.`,
    };
  return {
    ok: true,
    attachment: {
      type: "image",
      id: randomUUID(),
      name: prepared.file.name || "image",
      mimeType: prepared.file.type,
      sizeBytes: prepared.file.size,
      previewUrl: URL.createObjectURL(prepared.file),
      file: prepared.file,
    },
  };
}
