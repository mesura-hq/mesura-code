/**
 * Read the two vendor endpoints that meter a directly polled subscription.
 *
 * Neither plan is reachable through any agent's own protocol — OpenCode's
 * server API has no usage, quota or billing route at all — so these are the
 * only door. Both are read over plain HTTP with the subscription's own
 * credential, which is why they need no agent running.
 *
 * A failure is classified rather than flattened. "We could not reach it" and
 * "we reached it and could not understand it" need opposite responses: the
 * first is the vendor's outage, the second is our bug and the panel says so.
 *
 * Known gap: Z.ai reports its own status inside the body at HTTP 200, so a
 * rejected credential arrives as an unparseable body and is classified
 * `unrecognized` — our bug — rather than `unauthorized`. Fixing that needs the
 * vendor's auth-failure code set, which is undocumented; guessing at codes
 * would misfile a different set of responses instead. Revisit if Z.ai
 * documents them, or once a real rejection shows which code it carries.
 *
 * @module usage/subscriptionReaders
 */
import { AccountLimitsFailureReason } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import {
  normalizeOpenCodeGoAccountLimits,
  normalizeZaiAccountLimits,
  type NormalizedAccountLimits,
} from "./accountLimitsNormalize.ts";

/**
 * How long a vendor read may take.
 *
 * The refresh loop runs at concurrency 2, so a socket with no bound would wedge
 * every reader behind it, the local Claude and Codex ones included.
 */
export const SUBSCRIPTION_READ_TIMEOUT = Duration.seconds(10);

export const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
export const ZAI_USAGE_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

export interface SubscriptionHttpRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
}

export interface SubscriptionHttpResponse {
  readonly status: number;
  readonly body: string;
}

/** A request that did not produce a response at all. */
export class SubscriptionTransportError extends Schema.TaggedError<SubscriptionTransportError>()(
  "SubscriptionTransportError",
  { detail: Schema.String },
) {}

export class SubscriptionReadError extends Schema.TaggedError<SubscriptionReadError>()(
  "SubscriptionReadError",
  {
    reason: AccountLimitsFailureReason,
    detail: Schema.String,
  },
) {}

const decodeJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown) as unknown as Schema.Codec<unknown, string>,
);

interface ReadInput {
  readonly credential: string;
  /**
   * The reading's own time. Required, not defaulted: one vendor reports a
   * second offset rather than a time, and a missing base would render a reset
   * date in 1970 instead of admitting it does not know one.
   */
  readonly nowMs: number;
  /**
   * Performs the request. Taken as an input so a test drives it without a
   * layer, and so the credential never travels further than this call.
   */
  readonly get: (
    request: SubscriptionHttpRequest,
  ) => Effect.Effect<SubscriptionHttpResponse, SubscriptionTransportError>;
}

/**
 * One vendor read: fetch, classify the status, then normalize.
 *
 * The detail never carries the credential or the body — a bounded reason is
 * what the panel needs, and a response body is exactly the thing most likely to
 * quote a token back at us.
 */
function readUsage(input: {
  readonly request: SubscriptionHttpRequest;
  readonly get: (
    request: SubscriptionHttpRequest,
  ) => Effect.Effect<SubscriptionHttpResponse, SubscriptionTransportError>;
  readonly normalize: (payload: unknown) => NormalizedAccountLimits | null;
  readonly vendor: string;
}): Effect.Effect<NormalizedAccountLimits, SubscriptionReadError> {
  return Effect.gen(function* () {
    const response = yield* input.get(input.request).pipe(
      Effect.timeout(SUBSCRIPTION_READ_TIMEOUT),
      Effect.mapError(
        () =>
          new SubscriptionReadError({
            reason: "unreachable",
            detail: `${input.vendor} usage endpoint did not answer.`,
          }),
      ),
    );

    if (response.status === 401 || response.status === 403) {
      return yield* Effect.fail(
        new SubscriptionReadError({
          reason: "unauthorized",
          detail: `${input.vendor} rejected the subscription's credential.`,
        }),
      );
    }
    // A throttle is a transient vendor condition, not something we misparsed.
    // Letting it fall through would report it to the user as our bug.
    if (response.status === 429 || response.status >= 500) {
      return yield* Effect.fail(
        new SubscriptionReadError({
          reason: "unreachable",
          detail: `${input.vendor} usage endpoint answered ${response.status}.`,
        }),
      );
    }

    const unrecognized = new SubscriptionReadError({
      reason: "unrecognized",
      detail: `${input.vendor} usage reading was not understood.`,
    });
    const payload = yield* decodeJson(response.body).pipe(Effect.mapError(() => unrecognized));
    const normalized = input.normalize(payload);
    if (normalized === null) return yield* Effect.fail(unrecognized);
    return normalized;
  });
}

/** The OpenCode Go plan, authenticated with a bearer token. */
export function readOpenCodeGoUsage(input: ReadInput) {
  return readUsage({
    request: {
      url: OPENCODE_GO_USAGE_URL,
      headers: { Authorization: `Bearer ${input.credential}` },
    },
    get: input.get,
    normalize: (payload) => normalizeOpenCodeGoAccountLimits(payload, input.nowMs),
    vendor: "OpenCode Go",
  });
}

/**
 * The Z.ai GLM Coding Plan.
 *
 * The credential goes in `Authorization` raw rather than as a bearer token,
 * which is what the endpoint documents; it accepts both today, and the
 * documented form is the one that will keep working.
 */
export function readZaiUsage(input: ReadInput) {
  return readUsage({
    request: {
      url: ZAI_USAGE_URL,
      headers: { Authorization: input.credential, "Accept-Language": "en-US,en" },
    },
    get: input.get,
    normalize: normalizeZaiAccountLimits,
    vendor: "Z.ai",
  });
}

/**
 * Adapt Effect's HTTP client to the narrow `get` the readers take.
 *
 * The status is reported rather than filtered, because these readers classify
 * on it: a 401 and a 500 mean different things to the panel. The error detail
 * carries the vendor's name and nothing from the response, since a body is the
 * likeliest place a token gets echoed back at us.
 */
export function makeSubscriptionHttpGet(
  httpClient: HttpClient.HttpClient,
): (
  request: SubscriptionHttpRequest,
) => Effect.Effect<SubscriptionHttpResponse, SubscriptionTransportError> {
  return (request) =>
    HttpClientRequest.get(request.url).pipe(
      HttpClientRequest.setHeaders(request.headers),
      httpClient.execute,
      Effect.flatMap((response) =>
        response.text.pipe(Effect.map((body) => ({ status: response.status, body }))),
      ),
      Effect.mapError(() => new SubscriptionTransportError({ detail: "usage request failed" })),
    );
}
