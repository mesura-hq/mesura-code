// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import type { ChatAttachment, ChatImageAttachment } from "@t3tools/contracts";

import { resolveAttachmentPath } from "../attachmentStore.ts";

export interface ReadableAttachmentDelivery {
  readonly attachment: ChatAttachment;
  readonly attachmentPath: string;
}

export type AttachmentDeliveryResolution =
  | { readonly ok: true; readonly deliveries: ReadonlyArray<ReadableAttachmentDelivery> }
  | {
      readonly ok: false;
      readonly attachment: ChatAttachment;
      readonly issue: string;
      readonly cause?: unknown;
    };

export function selectNativeImageAttachments(
  attachments: ReadonlyArray<ChatAttachment> | undefined,
): ReadonlyArray<ChatImageAttachment> {
  return (attachments ?? []).filter(
    (attachment): attachment is ChatImageAttachment => attachment.type === "image",
  );
}

export function resolveReadableAttachmentDeliveries(input: {
  readonly attachmentsDir: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}): AttachmentDeliveryResolution {
  const deliveries: ReadableAttachmentDelivery[] = [];
  for (const attachment of input.attachments) {
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment,
    });
    if (attachmentPath === null) {
      return { ok: false, attachment, issue: "has no safe environment-local path" };
    }
    try {
      const fileInfo = NodeFS.lstatSync(attachmentPath);
      if (fileInfo.isSymbolicLink()) {
        return { ok: false, attachment, issue: "cannot be a symbolic link" };
      }
      if (!fileInfo.isFile()) {
        return { ok: false, attachment, issue: "is not a regular file" };
      }
      NodeFS.accessSync(attachmentPath, NodeFS.constants.R_OK);
      deliveries.push({ attachment, attachmentPath });
    } catch (cause) {
      return { ok: false, attachment, issue: "is not readable", cause };
    }
  }
  return { ok: true, deliveries };
}

export function appendReadableAttachmentPaths(input: {
  readonly message: string;
  readonly attachmentsDir: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}): AttachmentDeliveryResolution & { readonly message?: string } {
  const resolution = resolveReadableAttachmentDeliveries(input);
  if (!resolution.ok) return resolution;
  const pathLines = resolution.deliveries.map(
    ({ attachment, attachmentPath }) =>
      `[Attached ${attachment.type} "${attachment.name}" is saved at: ${attachmentPath}]`,
  );
  return {
    ...resolution,
    message: [input.message, pathLines.join("\n")].filter((part) => part.length > 0).join("\n\n"),
  };
}
