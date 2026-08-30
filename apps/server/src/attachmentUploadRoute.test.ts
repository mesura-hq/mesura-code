import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { makeAttachmentUploadStore } from "./attachmentUploadStore.ts";
import { handleAuthenticatedAttachmentUploadRequest } from "./http.ts";

const uploadMetadata = Object.entries({
  threadId: "thread-route-auth",
  name: "authorized.pdf",
  mimeType: "application/pdf",
  kind: "file",
})
  .map(([key, value]) => `${key} ${Buffer.from(value).toString("base64")}`)
  .join(",");

describe("authenticated attachment upload route", () => {
  it.effect("requires operate scope for uploads and leaves OPTIONS unauthenticated", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "mesura-upload-route-auth-",
        });
        const store = yield* makeAttachmentUploadStore({
          uploadsDir: path.join(root, "uploads"),
          attachmentsDir: path.join(root, "attachments"),
        });
        const authenticatedMethods: string[] = [];
        const authLayer = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          authenticateHttpRequest: (request) => {
            authenticatedMethods.push(request.method);
            const authorization = request.headers.authorization;
            const cookie = request.headers.cookie;
            const dpop = request.headers.dpop;
            if (!authorization && !cookie) {
              return Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}));
            }
            const scopes: Array<AuthEnvironmentScope> =
              authorization === "Bearer read-only" ? [AuthOrchestrationReadScope] : [];
            if (
              authorization === "Bearer valid" ||
              cookie === "mesura_session=valid" ||
              (authorization === "DPoP valid" && dpop === "proof")
            ) {
              scopes.push(AuthOrchestrationOperateScope);
            }
            return Effect.succeed({
              sessionId: AuthSessionId.make("session-upload-route"),
              subject: "upload-route-test",
              method: "bearer-access-token" as const,
              scopes,
            });
          },
        });
        const handle = (request: Request) =>
          handleAuthenticatedAttachmentUploadRequest(store).pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(request),
            ),
            Effect.provide(authLayer),
          );
        const createRequest = (headers: Readonly<Record<string, string>> = {}) =>
          new Request("https://environment.test/api/attachments/uploads", {
            method: "POST",
            headers: {
              "Tus-Resumable": "1.0.0",
              "Upload-Length": "1",
              "Upload-Metadata": uploadMetadata,
              ...headers,
            },
          });

        expect((yield* handle(createRequest())).status).toBe(401);
        for (const method of ["HEAD", "PATCH", "DELETE"] as const) {
          expect(
            (yield* handle(
              new Request(
                "https://environment.test/api/attachments/uploads/upload-00000000-0000-4000-8000-000000000001",
                { method },
              ),
            )).status,
          ).toBe(401);
        }
        expect((yield* handle(createRequest({ Authorization: "Bearer read-only" }))).status).toBe(
          403,
        );
        expect((yield* handle(createRequest({ Authorization: "Bearer valid" }))).status).toBe(201);
        expect((yield* handle(createRequest({ Cookie: "mesura_session=valid" }))).status).toBe(201);
        expect(
          (yield* handle(createRequest({ Authorization: "DPoP valid", DPoP: "proof" }))).status,
        ).toBe(201);
        expect(
          (yield* handle(
            new Request("https://environment.test/api/attachments/uploads", {
              method: "OPTIONS",
            }),
          )).status,
        ).toBe(204);
        expect(authenticatedMethods).toEqual([
          "POST",
          "HEAD",
          "PATCH",
          "DELETE",
          "POST",
          "POST",
          "POST",
          "POST",
        ]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
