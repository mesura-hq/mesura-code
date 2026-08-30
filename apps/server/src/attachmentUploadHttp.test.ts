import * as NodeServices from "@effect/platform-node/NodeServices";
import { PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as Path from "effect/Path";

import { handleAttachmentUploadRequest } from "./attachmentUploadHttp.ts";
import { makeAttachmentUploadStore } from "./attachmentUploadStore.ts";

const metadata = (entries: Readonly<Record<string, string>>) =>
  Object.entries(entries)
    .map(([key, value]) => `${key} ${Buffer.from(value).toString("base64")}`)
    .join(",");

describe("attachment upload tus protocol", () => {
  it.effect("creates, appends, inspects, and cancels a resumable upload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "mesura-upload-http-" });
        const store = yield* makeAttachmentUploadStore({
          uploadsDir: path.join(root, "uploads"),
          attachmentsDir: path.join(root, "attachments"),
        });
        const routePrefix = "/api/attachments/uploads";
        const handle = (request: Request) =>
          handleAttachmentUploadRequest({
            request: HttpServerRequest.fromWeb(request),
            routePrefix,
            store,
          });

        const created = yield* handle(
          new Request(`https://environment.test${routePrefix}`, {
            method: "POST",
            headers: {
              "Tus-Resumable": "1.0.0",
              "Upload-Length": "3",
              "Upload-Metadata": metadata({
                threadId: "thread-1",
                name: "recording.mp4",
                mimeType: "video/mp4",
                kind: "file",
              }),
            },
          }),
        );
        expect(created.status).toBe(201);
        const location = created.headers.location;
        expect(location).toMatch(/^\/api\/attachments\/uploads\//);

        const patched = yield* handle(
          new Request(`https://environment.test${location}`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/offset+octet-stream",
              "Tus-Resumable": "1.0.0",
              "Upload-Offset": "0",
            },
            body: new Uint8Array([1, 2, 3]),
          }),
        );
        expect(patched.status).toBe(204);
        expect(patched.headers["upload-offset"]).toBe("3");

        const inspected = yield* handle(
          new Request(`https://environment.test${location}`, {
            method: "HEAD",
            headers: { "Tus-Resumable": "1.0.0" },
          }),
        );
        expect(inspected.status).toBe(200);
        expect(inspected.headers["upload-offset"]).toBe("3");
        expect(inspected.headers["upload-length"]).toBe("3");

        const cancelled = yield* handle(
          new Request(`https://environment.test${location}`, {
            method: "DELETE",
            headers: { "Tus-Resumable": "1.0.0" },
          }),
        );
        expect(cancelled.status).toBe(204);

        const oversized = yield* handle(
          new Request(`https://environment.test${routePrefix}`, {
            method: "POST",
            headers: {
              "Tus-Resumable": "1.0.0",
              "Upload-Length": String(PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1),
              "Upload-Metadata": metadata({
                threadId: "thread-1",
                name: "too-large.bin",
                mimeType: "application/octet-stream",
                kind: "file",
              }),
            },
          }),
        );
        expect(oversized.status).toBe(413);

        const bounded = yield* handle(
          new Request(`https://environment.test${routePrefix}`, {
            method: "POST",
            headers: {
              "Tus-Resumable": "1.0.0",
              "Upload-Length": "2",
              "Upload-Metadata": metadata({
                threadId: "thread-1",
                name: "bounded.bin",
                mimeType: "application/octet-stream",
                kind: "file",
              }),
            },
          }),
        );
        const boundedLocation = bounded.headers.location;
        expect(bounded.status).toBe(201);
        expect(boundedLocation).toBeTruthy();

        const bodyTooLarge = yield* handle(
          new Request(`https://environment.test${boundedLocation}`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/offset+octet-stream",
              "Tus-Resumable": "1.0.0",
              "Upload-Offset": "0",
            },
            body: new Uint8Array([1, 2, 3]),
          }),
        );
        expect(bodyTooLarge.status).toBe(413);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
