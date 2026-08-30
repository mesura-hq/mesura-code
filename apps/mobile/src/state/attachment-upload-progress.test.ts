import { beforeEach, describe, expect, it } from "vite-plus/test";

import { appAtomRegistry } from "./atom-registry";
import {
  attachmentUploadProgressByIdAtom,
  clearAttachmentUploadProgress,
  setAttachmentUploadProgress,
} from "./attachment-upload-progress";

describe("attachment upload progress", () => {
  beforeEach(() => {
    appAtomRegistry.set(attachmentUploadProgressByIdAtom, {});
  });

  it("removes progress for deleted attachments and retains other uploads", () => {
    setAttachmentUploadProgress("first", 50, 100);
    setAttachmentUploadProgress("second", 25, 100);

    clearAttachmentUploadProgress(["first"]);

    expect(appAtomRegistry.get(attachmentUploadProgressByIdAtom)).toEqual({ second: 25 });
  });
});
