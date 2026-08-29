// @effect-diagnostics nodeBuiltinImport:off
import * as NodeBuffer from "node:buffer";

import {
  ATTACHMENT_UPLOAD_CONTENT_TYPE,
  ATTACHMENT_UPLOAD_ROUTE_PREFIX,
  ATTACHMENT_UPLOAD_TUS_VERSION,
  AttachmentUploadId,
  AttachmentUploadMetadata,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  AttachmentUploadStoreError,
  isAttachmentUploadStoreError,
  type AttachmentUploadStore,
} from "./attachmentUploadStore.ts";

const decodeTusUploadMetadata = Schema.decodeUnknownEffect(AttachmentUploadMetadata);
const decodeAttachmentUploadId = Schema.decodeUnknownEffect(AttachmentUploadId);

function tusHeaders(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "Tus-Resumable": ATTACHMENT_UPLOAD_TUS_VERSION,
    ...extra,
  };
}

function parseNonNegativeInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseMetadataHeader(value: string | undefined): Effect.Effect<unknown, never> {
  if (!value || value.length > 16_384) return Effect.succeed(null);
  return Effect.try({
    try: () =>
      Object.fromEntries(
        value.split(",").map((entry) => {
          const [key, encoded = ""] = entry.trim().split(/\s+/, 2);
          if (!key || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key)) {
            throw new Error("Invalid upload metadata key.");
          }
          return [key, NodeBuffer.Buffer.from(encoded, "base64").toString("utf8")];
        }),
      ),
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null));
}

function uploadIdFromPath(pathname: string, routePrefix: string): string | null {
  const prefix = `${routePrefix}/`;
  if (!pathname.startsWith(prefix)) return null;
  const candidate = pathname.slice(prefix.length);
  return candidate.length > 0 && !candidate.includes("/") ? candidate : null;
}

function storeErrorResponse(error: AttachmentUploadStoreError) {
  const status =
    error.reason === "not-found"
      ? 404
      : error.reason === "offset-mismatch" || error.reason === "already-claimed"
        ? 409
        : error.reason === "size-limit"
          ? 413
          : error.reason === "storage-failure"
            ? 500
            : 400;
  return HttpServerResponse.text(error.message, { status, headers: tusHeaders() });
}

export const handleAttachmentUploadRequest = Effect.fn("AttachmentUploadHttp.handle")(
  function* (input: {
    readonly request: HttpServerRequest.HttpServerRequest;
    readonly routePrefix?: string;
    readonly store: AttachmentUploadStore;
  }) {
    const routePrefix = input.routePrefix ?? ATTACHMENT_UPLOAD_ROUTE_PREFIX;
    const requestUrl = new URL(input.request.url, "http://environment.invalid");
    const method = input.request.method;

    if (method === "OPTIONS") {
      return HttpServerResponse.empty({
        status: 204,
        headers: tusHeaders({
          "Tus-Version": ATTACHMENT_UPLOAD_TUS_VERSION,
          "Tus-Extension": "creation,termination",
        }),
      });
    }
    if (input.request.headers["tus-resumable"] !== ATTACHMENT_UPLOAD_TUS_VERSION) {
      return HttpServerResponse.text("Unsupported tus protocol version.", {
        status: 412,
        headers: tusHeaders(),
      });
    }

    if (method === "POST" && requestUrl.pathname === routePrefix) {
      const sizeBytes = parseNonNegativeInteger(input.request.headers["upload-length"]);
      const rawMetadata = yield* parseMetadataHeader(input.request.headers["upload-metadata"]);
      const metadata = yield* decodeTusUploadMetadata(rawMetadata).pipe(Effect.option);
      if (sizeBytes === null || metadata._tag === "None") {
        return HttpServerResponse.text("Invalid attachment upload metadata.", {
          status: 400,
          headers: tusHeaders(),
        });
      }
      const created = yield* input.store
        .create({ ...metadata.value, sizeBytes })
        .pipe(Effect.match({ onFailure: storeErrorResponse, onSuccess: (value) => value }));
      if (HttpServerResponse.isHttpServerResponse(created)) return created;
      return HttpServerResponse.empty({
        status: 201,
        headers: tusHeaders({
          Location: `${routePrefix}/${created.uploadId}`,
          "Upload-Offset": "0",
        }),
      });
    }

    const rawUploadId = uploadIdFromPath(requestUrl.pathname, routePrefix);
    const uploadId = yield* decodeAttachmentUploadId(rawUploadId).pipe(Effect.option);
    if (uploadId._tag === "None") {
      return HttpServerResponse.text("Attachment upload was not found.", {
        status: 404,
        headers: tusHeaders(),
      });
    }

    if (method === "HEAD") {
      return yield* input.store.inspect(uploadId.value).pipe(
        Effect.match({
          onFailure: storeErrorResponse,
          onSuccess: (upload) =>
            HttpServerResponse.empty({
              status: 200,
              headers: tusHeaders({
                "Upload-Length": String(upload.sizeBytes),
                "Upload-Offset": String(upload.offsetBytes),
              }),
            }),
        }),
      );
    }

    if (method === "PATCH") {
      if (input.request.headers["content-type"] !== ATTACHMENT_UPLOAD_CONTENT_TYPE) {
        return HttpServerResponse.text("Invalid attachment upload content type.", {
          status: 415,
          headers: tusHeaders(),
        });
      }
      const offsetBytes = parseNonNegativeInteger(input.request.headers["upload-offset"]);
      if (offsetBytes === null) {
        return HttpServerResponse.text("Invalid attachment upload offset.", {
          status: 400,
          headers: tusHeaders(),
        });
      }
      return yield* input.store
        .append({ uploadId: uploadId.value, offsetBytes, body: input.request.stream })
        .pipe(
          Effect.match({
            onFailure: (error) =>
              isAttachmentUploadStoreError(error)
                ? storeErrorResponse(error)
                : HttpServerResponse.text("Failed to read attachment upload bytes.", {
                    status: 400,
                    headers: tusHeaders(),
                  }),
            onSuccess: (upload) =>
              HttpServerResponse.empty({
                status: 204,
                headers: tusHeaders({ "Upload-Offset": String(upload.offsetBytes) }),
              }),
          }),
        );
    }

    if (method === "DELETE") {
      return yield* input.store.cancel(uploadId.value).pipe(
        Effect.match({
          onFailure: storeErrorResponse,
          onSuccess: () => HttpServerResponse.empty({ status: 204, headers: tusHeaders() }),
        }),
      );
    }

    return HttpServerResponse.text("Method Not Allowed", {
      status: 405,
      headers: tusHeaders({ Allow: "OPTIONS, POST, HEAD, PATCH, DELETE" }),
    });
  },
);
