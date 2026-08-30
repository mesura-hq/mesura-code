export type ComposerAttachmentUploadStatus =
  | "preparing"
  | "uploading"
  | "ready"
  | "failed"
  | "cancelled";

export interface ComposerAttachmentUpload {
  readonly id: string;
  readonly file: File;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly kind: "image" | "file";
  readonly status: ComposerAttachmentUploadStatus;
  readonly uploadedBytes: number;
  readonly objectUrl?: string | undefined;
  readonly uploadId?: string | undefined;
  readonly uploadPath?: string | undefined;
  readonly error?: string | undefined;
}

export function formatAttachmentSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function attachmentSendBlockReason(
  statuses: ReadonlyArray<ComposerAttachmentUploadStatus>,
): string | null {
  if (statuses.some((status) => status === "preparing" || status === "uploading")) {
    return "Wait for attachments to finish uploading";
  }
  if (statuses.some((status) => status === "failed")) {
    return "Retry or remove failed attachments";
  }
  if (statuses.some((status) => status === "cancelled")) {
    return "Remove cancelled attachments";
  }
  return null;
}

export function partitionDeviceFiles(files: ReadonlyArray<File>): {
  images: File[];
  files: File[];
} {
  const images: File[] = [];
  const genericFiles: File[] = [];
  for (const file of files) {
    if (file.type.startsWith("image/")) images.push(file);
    else genericFiles.push(file);
  }
  return { images, files: genericFiles };
}

export function dataTransferHasDeviceFiles(types: Iterable<string>): boolean {
  return Array.from(types).includes("Files");
}

export function failedAttachmentIdsFromSettled(
  attachments: ReadonlyArray<Pick<ComposerAttachmentUpload, "id">>,
  results: ReadonlyArray<PromiseSettledResult<unknown>>,
): string[] {
  return results.flatMap((result, index) =>
    result.status === "rejected" && attachments[index] ? [attachments[index].id] : [],
  );
}
