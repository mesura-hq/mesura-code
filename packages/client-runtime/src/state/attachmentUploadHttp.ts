import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as HttpMethod from "effect/unstable/http/HttpMethod";
import { ATTACHMENT_UPLOAD_ROUTE_PREFIX } from "@t3tools/contracts";

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
