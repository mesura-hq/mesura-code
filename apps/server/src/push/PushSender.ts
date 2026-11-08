/**
 * Mesura: one Web Push request to one device. `web-push` signs (VAPID) and encrypts
 * (`aes128gcm`); the request goes through the Effect `HttpClient` rather than
 * `sendNotification`'s own `https.request`, so the server's HTTP stack and test fakes apply.
 */
import { PushNotificationPayload } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import WebPush from "web-push";

import { VapidKeys } from "./vapidKeys.ts";

/** A device's push endpoint and the keys its browser encrypts for. */
export interface PushTarget {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

/** `gone`: the push service no longer knows the subscription (404 or 410). */
export type PushSendResult = { readonly _tag: "delivered" } | { readonly _tag: "gone" };

/** What the push service said, before a rejection becomes a `PushSendError`. */
type PushAnswer =
  | PushSendResult
  | { readonly _tag: "rejected"; readonly status: number; readonly body: string };

export class PushSendError extends Schema.TaggedError<PushSendError>()("PushSendError", {
  /** Readable, and free of the endpoint URL, which works as a bearer token. */
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const encodePayloadJson = Schema.encodeSync(Schema.fromJsonString(PushNotificationPayload));

/** A push only matters while the developer can still act on it. */
const PUSH_TTL_SECONDS = 60 * 60;
const PUSH_REQUEST_TIMEOUT = Duration.seconds(30);
/** A rejection's body is only diagnostic; the status already decided the outcome. */
const PUSH_ERROR_BODY_TIMEOUT = Duration.seconds(5);

export class PushSender extends Context.Service<
  PushSender,
  {
    readonly send: (
      target: PushTarget,
      payload: PushNotificationPayload,
    ) => Effect.Effect<PushSendResult, PushSendError>;
  }
>()("t3/push/PushSender") {}

const make = Effect.gen(function* () {
  const vapid = yield* VapidKeys;
  const client = yield* HttpClient.HttpClient;

  const send = Effect.fn("PushSender.send")(function* (
    target: PushTarget,
    payload: PushNotificationPayload,
  ) {
    if (URL.canParse(target.endpoint)) {
      yield* Effect.annotateCurrentSpan("push.service.host", new URL(target.endpoint).host);
    }
    const details = yield* Effect.try({
      try: () =>
        WebPush.generateRequestDetails(
          {
            endpoint: target.endpoint,
            keys: { p256dh: target.keys.p256dh, auth: target.keys.auth },
          },
          encodePayloadJson(payload),
          {
            vapidDetails: {
              subject: vapid.subject,
              publicKey: vapid.publicKey,
              privateKey: vapid.privateKey,
            },
            TTL: PUSH_TTL_SECONDS,
            urgency: "high",
            contentEncoding: "aes128gcm",
          },
        ),
      catch: (cause) =>
        new PushSendError({
          detail: `Could not encrypt the push: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(details.headers)) {
      // fetch computes the length from the body itself.
      if (name.toLowerCase() !== "content-length") headers[name] = String(value);
    }
    const request = HttpClientRequest.post(details.endpoint).pipe(
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.bodyUint8Array(
        new Uint8Array(details.body ?? new Uint8Array()),
        "application/octet-stream",
      ),
    );

    // One deadline covers the request and body read; the scope aborts the request once the
    // answer is decided, so a held-open body cannot stall the send. No redirects: fetch turns
    // the POST into a GET and a page would read as accepted. No tracing: spans record the
    // endpoint URL, which works as a bearer token.
    const answer = yield* HttpClient.withScope(client)
      .execute(request)
      .pipe(
        Effect.flatMap((response): Effect.Effect<PushAnswer> => {
          if (response.status >= 200 && response.status < 300) {
            return Effect.succeed({ _tag: "delivered" } as const);
          }
          if (response.status === 404 || response.status === 410) {
            return Effect.succeed({ _tag: "gone" } as const);
          }
          return response.text.pipe(
            Effect.timeoutOption(PUSH_ERROR_BODY_TIMEOUT),
            Effect.map(Option.getOrElse(() => "")),
            Effect.orElseSucceed(() => ""),
            Effect.map((body) => ({ _tag: "rejected", status: response.status, body }) as const),
          );
        }),
        Effect.scoped,
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.withTracerEnabled(false),
        Effect.timeoutOrElse({
          duration: PUSH_REQUEST_TIMEOUT,
          orElse: () =>
            Effect.fail(new PushSendError({ detail: "The push service did not answer in time." })),
        }),
        Effect.catchTags({
          HttpClientError: (error) =>
            Effect.fail(
              new PushSendError({
                detail: `The push service could not be reached: ${
                  "description" in error.reason && error.reason.description !== undefined
                    ? error.reason.description
                    : error.reason._tag
                }`,
              }),
            ),
        }),
      );

    if (answer._tag !== "rejected") return answer;
    const excerpt = answer.body.slice(0, 200);
    return yield* new PushSendError({
      detail: `The push service answered ${answer.status}${excerpt === "" ? "" : `: ${excerpt}`}`,
    });
  });

  return PushSender.of({ send });
});

export const layer = Layer.effect(PushSender, make);
