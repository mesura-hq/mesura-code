import { describe, expect, it } from "vite-plus/test";

import {
  attachmentSendBlockReason,
  dataTransferHasDeviceFiles,
  failedAttachmentIdsFromSettled,
  partitionDeviceFiles,
} from "./composerAttachments";

describe("attachmentSendBlockReason", () => {
  it("blocks send while an upload is pending", () => {
    expect(attachmentSendBlockReason(["ready", "uploading"])).toBe(
      "Wait for attachments to finish uploading",
    );
  });

  it("requires a failed upload to be retried or removed", () => {
    expect(attachmentSendBlockReason(["failed"])).toBe("Retry or remove failed attachments");
  });

  it("allows send when all uploads are ready", () => {
    expect(attachmentSendBlockReason(["ready", "ready"])).toBeNull();
  });
});

describe("partitionDeviceFiles", () => {
  it("keeps images on the preview path and sends video and PDF files to uploads", () => {
    const image = { type: "image/png" } as File;
    const video = { type: "video/mp4" } as File;
    const pdf = { type: "application/pdf" } as File;

    expect(partitionDeviceFiles([image, video, pdf])).toEqual({
      images: [image],
      files: [video, pdf],
    });
  });
});

describe("dataTransferHasDeviceFiles", () => {
  it("distinguishes an operating-system file drag from plain text", () => {
    expect(dataTransferHasDeviceFiles(["Files", "text/uri-list"])).toBe(true);
    expect(dataTransferHasDeviceFiles(["text/plain"])).toBe(false);
  });
});

describe("failedAttachmentIdsFromSettled", () => {
  it("marks only the expired upload and preserves another ready upload", () => {
    expect(
      failedAttachmentIdsFromSettled(
        [{ id: "expired" }, { id: "ready" }],
        [
          { status: "rejected", reason: new Error("expired") },
          { status: "fulfilled", value: undefined },
        ],
      ),
    ).toEqual(["expired"]);
  });
});
