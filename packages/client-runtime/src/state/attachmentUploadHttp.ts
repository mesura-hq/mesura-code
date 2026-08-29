import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as HttpMethod from "effect/unstable/http/HttpMethod";
import {
  ATTACHMENT_UPLOAD_CONTENT_TYPE,
  ATTACHMENT_UPLOAD_ROUTE_PREFIX,
  ATTACHMENT_UPLOAD_TUS_VERSION,
  AttachmentUploadId,
  type AttachmentUploadKind,
  type ThreadId,
} from "@t3tools/contracts";

import type { PreparedConnection } from "../connection/model.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { buildEnvironmentAuthHeaders } from "./environmentHttpAuth.ts";

export class AttachmentUploadRequestError extends Schema.TaggedErrorClass<AttachmentUploadRequestError>()(
  "AttachmentUploadRequestError",
  {
    method: Schema.String,
    url: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The ${this.method} attachment upload request failed.`;
  }
}

export const executeAttachmentUploadRequest = Effect.fn("AttachmentUploadHttp.execute")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
    readonly fetch?: (request: Request) => Promise<Response>;
    readonly method: HttpMethod.HttpMethod;
    readonly uploadPath: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: BodyInit;
    readonly signal?: AbortSignal;
  }) {
    const url = yield* Effect.try({
      try: () => {
        const environmentUrl = new URL(input.prepared.httpBaseUrl);
        const requestUrl = new URL(input.uploadPath, `${environmentUrl.origin}/`);
        const isUploadPath =
          requestUrl.pathname === ATTACHMENT_UPLOAD_ROUTE_PREFIX ||
          requestUrl.pathname.startsWith(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`);
        if (
          !input.uploadPath.startsWith("/") ||
          requestUrl.origin !== environmentUrl.origin ||
          !isUploadPath
        ) {
          throw new Error("Attachment upload path is outside the environment upload endpoint.");
        }
        return requestUrl.toString();
      },
      catch: (cause) =>
        new AttachmentUploadRequestError({
          method: input.method,
          url: input.uploadPath,
          cause,
        }),
    });
    const authorizationHeaders = yield* buildEnvironmentAuthHeaders(
      input.prepared.httpAuthorization,
      input.method,
      url,
      input.signer,
    );
    const headers = new Headers(input.headers);
    if (authorizationHeaders.authorization) {
      headers.set("authorization", authorizationHeaders.authorization);
    }
    if (authorizationHeaders.dpop) {
      headers.set("dpop", authorizationHeaders.dpop);
    }
    const request = new Request(url, {
      method: input.method,
      headers,
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.prepared.httpAuthorization === null ? { credentials: "include" as const } : {}),
    });
    return yield* Effect.tryPromise({
      try: () => (input.fetch ?? globalThis.fetch)(request),
      catch: (cause) =>
        new AttachmentUploadRequestError({
          method: input.method,
          url,
          cause,
        }),
    });
  },
);

const DEFAULT_UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024;
const decodeAttachmentUploadId = Schema.decodeUnknownEffect(AttachmentUploadId);

function encodeUploadMetadata(entries: Readonly<Record<string, string>>): string {
  return Object.entries(entries)
    .map(([key, value]) => {
      const bytes = new TextEncoder().encode(value);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return `${key} ${btoa(binary)}`;
    })
    .join(",");
}

function responseHeader(response: Response, name: string): string | null {
  return response.headers.get(name) ?? response.headers.get(name.toLowerCase());
}

const expectUploadResponse = Effect.fn("AttachmentUploadHttp.expectResponse")(function* (
  response: Response,
  allowedStatuses: ReadonlyArray<number>,
) {
  if (allowedStatuses.includes(response.status)) return response;
  return yield* new AttachmentUploadRequestError({
    method: "HTTP",
    url: response.url,
    cause: `Unexpected attachment upload response ${response.status}`,
  });
});

export const uploadEnvironmentAttachment = Effect.fn("AttachmentUploadHttp.uploadAttachment")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
    readonly threadId: ThreadId;
    readonly kind: AttachmentUploadKind;
    readonly file: Blob & { readonly name?: string };
    readonly name: string;
    readonly mimeType: string;
    readonly signal?: AbortSignal;
    readonly chunkBytes?: number;
    readonly fetch?: (request: Request) => Promise<Response>;
    readonly maxResumeAttempts?: number;
    readonly onCreated?: (uploadId: AttachmentUploadId, uploadPath: string) => void;
    readonly onProgress?: (uploadedBytes: number, totalBytes: number) => void;
  }) {
    const commonHeaders = { "Tus-Resumable": ATTACHMENT_UPLOAD_TUS_VERSION };
    const created = yield* executeAttachmentUploadRequest({
      prepared: input.prepared,
      signer: input.signer,
      method: "POST",
      uploadPath: ATTACHMENT_UPLOAD_ROUTE_PREFIX,
      headers: {
        ...commonHeaders,
        "Upload-Length": String(input.file.size),
        "Upload-Metadata": encodeUploadMetadata({
          threadId: input.threadId,
          kind: input.kind,
          name: input.name,
          mimeType: input.mimeType,
        }),
      },
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.fetch ? { fetch: input.fetch } : {}),
    }).pipe(Effect.flatMap((response) => expectUploadResponse(response, [201])));
    const uploadPath = responseHeader(created, "Location");
    if (!uploadPath) {
      return yield* new AttachmentUploadRequestError({
        method: "POST",
        url: created.url,
        cause: "Attachment upload response did not include Location.",
      });
    }
    const uploadIdValue = uploadPath.split("/").at(-1);
    const uploadId = yield* decodeAttachmentUploadId(uploadIdValue).pipe(
      Effect.mapError(
        (cause) => new AttachmentUploadRequestError({ method: "POST", url: created.url, cause }),
      ),
    );
    input.onCreated?.(uploadId, uploadPath);
    const chunkBytes = Math.max(64 * 1024, input.chunkBytes ?? DEFAULT_UPLOAD_CHUNK_BYTES);
    const maxResumeAttempts = Math.max(0, input.maxResumeAttempts ?? 3);
    let offset = 0;
    let resumeAttempts = 0;
    input.onProgress?.(offset, input.file.size);
    while (offset < input.file.size) {
      const end = Math.min(input.file.size, offset + chunkBytes);
      const chunk = input.file.slice(offset, end);
      const patchResult = yield* executeAttachmentUploadRequest({
        prepared: input.prepared,
        signer: input.signer,
        ...(input.fetch ? { fetch: input.fetch } : {}),
        method: "PATCH",
        uploadPath,
        headers: {
          ...commonHeaders,
          "Content-Type": ATTACHMENT_UPLOAD_CONTENT_TYPE,
          "Upload-Offset": String(offset),
        },
        body: chunk,
        ...(input.signal ? { signal: input.signal } : {}),
      }).pipe(
        Effect.flatMap((response) => expectUploadResponse(response, [204])),
        Effect.result,
      );
      if (patchResult._tag === "Failure") {
        if (input.signal?.aborted || resumeAttempts >= maxResumeAttempts) {
          return yield* patchResult.failure;
        }
        resumeAttempts += 1;
        const headResult = yield* executeAttachmentUploadRequest({
          prepared: input.prepared,
          signer: input.signer,
          ...(input.fetch ? { fetch: input.fetch } : {}),
          method: "HEAD",
          uploadPath,
          headers: commonHeaders,
          ...(input.signal ? { signal: input.signal } : {}),
        }).pipe(
          Effect.flatMap((response) => expectUploadResponse(response, [200, 204])),
          Effect.result,
        );
        if (headResult._tag === "Failure") {
          if (resumeAttempts >= maxResumeAttempts) {
            return yield* headResult.failure;
          }
          continue;
        }
        const resumedOffset = Number(responseHeader(headResult.success, "Upload-Offset"));
        if (
          !Number.isSafeInteger(resumedOffset) ||
          resumedOffset < 0 ||
          resumedOffset > input.file.size
        ) {
          return yield* new AttachmentUploadRequestError({
            method: "HEAD",
            url: headResult.success.url,
            cause: "Attachment upload returned an invalid resume offset.",
          });
        }
        offset = resumedOffset;
        input.onProgress?.(offset, input.file.size);
        continue;
      }
      const patched = patchResult.success;
      const acknowledged = Number(responseHeader(patched, "Upload-Offset"));
      if (!Number.isSafeInteger(acknowledged) || acknowledged <= offset || acknowledged > end) {
        return yield* new AttachmentUploadRequestError({
          method: "PATCH",
          url: patched.url,
          cause: "Attachment upload returned an invalid offset.",
        });
      }
      offset = acknowledged;
      resumeAttempts = 0;
      input.onProgress?.(offset, input.file.size);
    }
    return { type: "uploaded" as const, uploadId, uploadPath };
  },
);

export const cancelEnvironmentAttachmentUpload = Effect.fn("AttachmentUploadHttp.cancelAttachment")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
    readonly uploadPath: string;
  }) {
    yield* executeAttachmentUploadRequest({
      prepared: input.prepared,
      signer: input.signer,
      method: "DELETE",
      uploadPath: input.uploadPath,
      headers: { "Tus-Resumable": ATTACHMENT_UPLOAD_TUS_VERSION },
    }).pipe(
      Effect.flatMap((response) => expectUploadResponse(response, [204, 404])),
      Effect.asVoid,
    );
  },
);

export const verifyEnvironmentAttachmentUpload = Effect.fn("AttachmentUploadHttp.verifyAttachment")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
    readonly uploadPath: string;
  }) {
    yield* executeAttachmentUploadRequest({
      prepared: input.prepared,
      signer: input.signer,
      method: "HEAD",
      uploadPath: input.uploadPath,
      headers: { "Tus-Resumable": ATTACHMENT_UPLOAD_TUS_VERSION },
    }).pipe(
      Effect.flatMap((response) => expectUploadResponse(response, [200, 204])),
      Effect.asVoid,
    );
  },
);
