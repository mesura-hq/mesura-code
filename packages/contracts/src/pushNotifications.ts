import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Mesura: Web Push from the host server to the devices that subscribe. The
 * server signs with its own VAPID key pair and encrypts every message for the
 * device (RFC 8291), so the browser vendor's push service only relays it.
 */

const Base64UrlString = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/));

/** Push services are HTTPS by the Push API's own rule; anything else is not a subscription. */
const PushEndpoint = Schema.String.check(
  Schema.makeFilter((value: string) => {
    if (!URL.canParse(value)) return "A push endpoint must be a URL.";
    return new URL(value).protocol === "https:" || "A push endpoint must be an https URL.";
  }),
);

/** Which thread states this device wants a push for. */
export const PushPreferences = Schema.Struct({
  approval: Schema.Boolean,
  input: Schema.Boolean,
  failed: Schema.Boolean,
  completed: Schema.Boolean,
});
export type PushPreferences = typeof PushPreferences.Type;

const DEFAULT_PUSH_PREFERENCES: PushPreferences = {
  approval: true,
  input: true,
  failed: true,
  completed: false,
};

/** A browser's `PushSubscription.toJSON()`, with a device label and its preferences. */
export const PushSubscriptionInput = Schema.Struct({
  endpoint: PushEndpoint,
  keys: Schema.Struct({ p256dh: Base64UrlString, auth: Base64UrlString }),
  /** A short device name the client derives from its user agent. */
  label: Schema.String.check(Schema.isMaxLength(120)),
  preferences: PushPreferences.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PUSH_PREFERENCES)),
  ),
});
export type PushSubscriptionInput = typeof PushSubscriptionInput.Type;

export const PushPublicKeyInput = Schema.Struct({});

export const PushPublicKey = Schema.Struct({
  /** The VAPID public key, base64url, for `pushManager.subscribe`'s `applicationServerKey`. */
  publicKey: Schema.String,
});
export type PushPublicKey = typeof PushPublicKey.Type;

export const PushEndpointInput = Schema.Struct({ endpoint: Schema.String });
export type PushEndpointInput = typeof PushEndpointInput.Type;

export const PushSubscriptionStatus = Schema.Struct({
  subscribed: Schema.Boolean,
  /** Present when `subscribed` is true. */
  preferences: Schema.optional(PushPreferences),
});
export type PushSubscriptionStatus = typeof PushSubscriptionStatus.Type;

export const PushUnsubscribeResult = Schema.Struct({
  /** False when the server held no subscription for the endpoint. */
  removed: Schema.Boolean,
});
export type PushUnsubscribeResult = typeof PushUnsubscribeResult.Type;

export const PushSendTestResult = Schema.Struct({
  /** `gone`: the push service no longer knows the device, and the server forgot it. */
  outcome: Schema.Literals(["delivered", "gone"]),
});
export type PushSendTestResult = typeof PushSendTestResult.Type;

/** The JSON a push carries; the service worker shows it as one notification. */
export const PushNotificationPayload = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  /** A newer notification with the same tag replaces the older one. */
  tag: Schema.String,
  /** The web app route a tap opens. */
  url: Schema.String,
});
export type PushNotificationPayload = typeof PushNotificationPayload.Type;

export class PushNotificationError extends Schema.TaggedError<PushNotificationError>()(
  "PushNotificationError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
