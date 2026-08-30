import { describe, expect, it } from "vite-plus/test";

import { selectNativeImageAttachments } from "./attachmentDelivery.ts";

describe("provider attachment delivery", () => {
  it("keeps generic files out of provider-native image payloads", () => {
    const image = {
      type: "image" as const,
      id: "thread-delivery-00000000-0000-4000-8000-000000000001",
      name: "reference.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };
    const file = {
      type: "file" as const,
      id: "thread-delivery-00000000-0000-4000-8000-000000000002",
      name: "recording.mp4",
      mimeType: "video/mp4",
      sizeBytes: 8,
    };

    expect(selectNativeImageAttachments([file, image])).toEqual([image]);
  });
});
