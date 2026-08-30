import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { toOpenCodeFileParts } from "./opencodeRuntime.ts";

describe("OpenCode attachment delivery", () => {
  it("delivers a generic PDF as a file part with its environment-local path", () => {
    const attachment = {
      type: "file" as const,
      id: "thread-opencode-00000000-0000-4000-8000-000000000001",
      name: "requirements.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
    };
    const attachmentPath = "/var/lib/mesura/attachments/thread-opencode-file.bin";

    expect(
      toOpenCodeFileParts({
        attachments: [attachment],
        resolveAttachmentPath: () => attachmentPath,
      }),
    ).toEqual([
      {
        type: "file",
        mime: "application/pdf",
        filename: "requirements.pdf",
        url: NodeURL.pathToFileURL(attachmentPath).href,
      },
    ]);
  });
});
