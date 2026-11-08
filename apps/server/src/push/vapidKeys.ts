/**
 * Mesura: the VAPID key pair (RFC 8292) this server signs every push with.
 *
 * A browser subscription is bound to the public key it was created with, so the
 * pair is made once and kept in the secret store: a new pair would orphan every
 * subscribed device.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import WebPush from "web-push";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export const VAPID_KEYS_SECRET_NAME = "push-vapid-keys";

/**
 * The JWT `sub` claim. Push services want a contact for the sender; this host
 * has no stable public origin and no operator address to publish, and FCM does
 * not check the value, so it is a reserved, non-routable address.
 */
const VAPID_SUBJECT = "mailto:push@mesura-code.invalid";

const VAPID_KEYS_RESOURCE = "push VAPID key pair";

const StoredVapidKeys = Schema.Struct({ publicKey: Schema.String, privateKey: Schema.String });
type StoredVapidKeys = typeof StoredVapidKeys.Type;
const StoredVapidKeysJson = Schema.fromJsonString(StoredVapidKeys);
const decodeStoredVapidKeys = Schema.decodeUnknownEffect(StoredVapidKeysJson);
const encodeStoredVapidKeys = Schema.encodeEffect(StoredVapidKeysJson);

export class VapidKeys extends Context.Service<
  VapidKeys,
  {
    /** Base64url of the uncompressed P-256 point, as `applicationServerKey` takes it. */
    readonly publicKey: string;
    readonly privateKey: string;
    readonly subject: string;
  }
>()("t3/push/vapidKeys") {}

const readStored = Effect.fn("VapidKeys.readStored")(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
) {
  const stored = yield* secrets.get(VAPID_KEYS_SECRET_NAME);
  if (Option.isNone(stored)) return Option.none<StoredVapidKeys>();
  const decoded = yield* decodeStoredVapidKeys(new TextDecoder().decode(stored.value)).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSecretStore.SecretStoreDecodeError({ resource: VAPID_KEYS_RESOURCE, cause }),
    ),
  );
  return Option.some(decoded);
});

const getOrCreate = Effect.fn("VapidKeys.getOrCreate")(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const existing = yield* readStored(secrets);
  if (Option.isSome(existing)) return existing.value;

  const generated = WebPush.generateVAPIDKeys();
  const encoded = yield* encodeStoredVapidKeys(generated).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSecretStore.SecretStoreEncodeError({ resource: VAPID_KEYS_RESOURCE, cause }),
    ),
  );
  // `create`, not `set`: when two starts race, the pair the other one stored wins.
  return yield* secrets.create(VAPID_KEYS_SECRET_NAME, new TextEncoder().encode(encoded)).pipe(
    Effect.as(generated),
    Effect.catchIf(ServerSecretStore.isSecretAlreadyExistsError, () =>
      readStored(secrets).pipe(
        Effect.flatMap(
          Option.match({
            onSome: Effect.succeed,
            onNone: () =>
              Effect.fail(
                new ServerSecretStore.SecretStoreConcurrentReadError({
                  resource: VAPID_KEYS_RESOURCE,
                }),
              ),
          }),
        ),
      ),
    ),
  );
});

export const layer = Layer.effect(
  VapidKeys,
  Effect.map(getOrCreate(), (keys) => VapidKeys.of({ ...keys, subject: VAPID_SUBJECT })),
);
