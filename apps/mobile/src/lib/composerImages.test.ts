import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";

const files = new Map<string, { base64: string; deleted: boolean }>();
let pickedResult: unknown = { canceled: true };

vi.mock("expo-file-system", () => ({
  Paths: { document: "file:///documents" },
  Directory: class {
    readonly uri: string;

    constructor(base: string, name: string) {
      this.uri = `${base}/${name}`;
    }

    create(): void {}
  },
  File: class {
    readonly uri: string;

    constructor(uriOrDirectory: string | { readonly uri: string }, name?: string) {
      this.uri =
        typeof uriOrDirectory === "string"
          ? uriOrDirectory
          : `${uriOrDirectory.uri}/${name ?? "attachment.bin"}`;
    }

    static pickFileAsync(): Promise<unknown> {
      return Promise.resolve(pickedResult);
    }

    get exists(): boolean {
      return files.has(this.uri) && files.get(this.uri)?.deleted === false;
    }

    async base64(): Promise<string> {
      const entry = files.get(this.uri);
      if (!entry || entry.deleted) {
        throw new Error("missing file");
      }
      return entry.base64;
    }

    delete(): void {
      const entry = files.get(this.uri);
      if (entry) {
        entry.deleted = true;
      }
    }
  },
}));

vi.mock("./uuid", () => ({
  uuidv4: () => "attachment-id",
}));

import {
  convertPastedImagesToAttachments,
  isOwnedPastedImageUri,
  pickComposerAttachments,
  removeOwnedComposerAttachment,
  toUploadChatImageAttachments,
} from "./composerImages";

describe("toUploadChatImageAttachments", () => {
  it("strips client draft id and previewUri for the startTurn wire shape", () => {
    expect(
      toUploadChatImageAttachments([
        {
          id: "client-draft-id",
          type: "image",
          name: "pasted-image.png",
          mimeType: "image/png",
          sizeBytes: 12,
          dataUrl: "data:image/png;base64,AA==",
          previewUri: "file:///tmp/preview.png",
        },
      ]),
    ).toEqual([
      {
        type: "image",
        name: "pasted-image.png",
        mimeType: "image/png",
        sizeBytes: 12,
        dataUrl: "data:image/png;base64,AA==",
      },
    ]);
  });
});

describe("native pasted image cleanup", () => {
  beforeEach(() => {
    files.clear();
    pickedResult = { canceled: true };
  });

  it("recognizes only files created in the native composer paste directory", () => {
    expect(
      isOwnedPastedImageUri(
        "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/id.png",
      ),
    ).toBe(true);
    expect(isOwnedPastedImageUri("file:///private/var/mobile/photos/id.png")).toBe(false);
    expect(isOwnedPastedImageUri("https://example.com/t3-composer-paste/id.png")).toBe(false);
  });

  it("converts owned files to data-backed previews and deletes the source", async () => {
    const uri =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/id.png";
    files.set(uri, { base64: "aGVsbG8=", deleted: false });

    const attachments = await convertPastedImagesToAttachments({
      uris: [uri],
      existingCount: 0,
    });

    expect(attachments).toEqual([
      expect.objectContaining({
        dataUrl: "data:image/png;base64,aGVsbG8=",
        previewUri: "data:image/png;base64,aGVsbG8=",
      }),
    ]);
    expect(files.get(uri)?.deleted).toBe(true);
  });

  it("deletes rejected and overflow owned files without deleting user-owned files", async () => {
    const rejected =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/bad.png";
    const overflow =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/overflow.png";
    const userOwned = "file:///private/var/mobile/photos/library.png";
    files.set(rejected, { base64: "", deleted: false });
    files.set(overflow, { base64: "aGVsbG8=", deleted: false });
    files.set(userOwned, { base64: "aGVsbG8=", deleted: false });

    await convertPastedImagesToAttachments({
      uris: [rejected, overflow, userOwned],
      existingCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1,
    });

    expect(files.get(rejected)?.deleted).toBe(true);
    expect(files.get(overflow)?.deleted).toBe(true);
    expect(files.get(userOwned)?.deleted).toBe(false);
  });
});

describe("owned generic attachment cleanup", () => {
  it("copies a generic selection into app-owned storage without base64", async () => {
    const copy = vi.fn(async (destination: { readonly uri: string }) => {
      files.set(destination.uri, { base64: "", deleted: false });
    });
    pickedResult = {
      canceled: false,
      result: [
        {
          name: "notes.pdf",
          type: "application/pdf",
          size: 42,
          copy,
        },
      ],
    };

    const result = await pickComposerAttachments({ existingCount: 0 });

    expect(result.error).toBeNull();
    expect(result.attachments).toEqual([
      {
        id: "attachment-id",
        type: "file",
        name: "notes.pdf",
        mimeType: "application/pdf",
        sizeBytes: 42,
        uri: "file:///documents/composer-attachments/attachment-id-notes.pdf",
      },
    ]);
    expect(copy).toHaveBeenCalledOnce();
  });

  it("deletes an app-owned queued video after delivery", async () => {
    const uri = "file:///documents/composer-attachments/video-recording.mp4";
    files.set(uri, { base64: "", deleted: false });

    await removeOwnedComposerAttachment({
      id: "video",
      type: "file",
      name: "recording.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1,
      uri,
    });

    expect(files.get(uri)?.deleted).toBe(true);
  });

  it("deletes an app-owned native paste file retained in a draft", async () => {
    const uri = "file:///documents/t3-composer-paste/pasted.png";
    files.set(uri, { base64: "", deleted: false });

    await removeOwnedComposerAttachment({
      id: "pasted",
      type: "image",
      name: "pasted.png",
      mimeType: "image/png",
      sizeBytes: 1,
      dataUrl: "data:image/png;base64,AA==",
      previewUri: uri,
    });

    expect(files.get(uri)?.deleted).toBe(true);
  });
});
