/**
 * Push fence, acceptance criterion 1: the VAPID key pair in the secret store, through
 * `VapidKeys.layer` over the real `ServerSecretStore`. A restart is a fresh secret store and a
 * fresh `VapidKeys` layer over the same server directory.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no P-256 ECDH, which checks the key pair here.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { VAPID_KEYS_SECRET_NAME, VapidKeys, layer as vapidKeysLayer } from "./vapidKeys.ts";

const layerServerConfig = () =>
  Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "push-vapid-keys-" }));

/** One server run: its own secret store and key service over the shared directory. */
const serverRun = <A, E>(
  effect: Effect.Effect<A, E, VapidKeys | ServerSecretStore.ServerSecretStore>,
) =>
  effect.pipe(
    Effect.provide(
      Layer.fresh(vapidKeysLayer).pipe(Layer.provideMerge(Layer.fresh(ServerSecretStore.layer))),
    ),
  );

const readStoredSecret = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  return (yield* store.get(VAPID_KEYS_SECRET_NAME)).pipe(
    Option.map((bytes) => Buffer.from(bytes).toString("hex")),
  );
});

it.layer(NodeServices.layer)("VapidKeys phase 1 fence (AC1)", (it) => {
  it.effect(
    "push phase 1 AC1: the first server run creates a P-256 key pair and keeps it in the secret store",
    () =>
      Effect.gen(function* () {
        const before = yield* readStoredSecret.pipe(
          Effect.provide(Layer.fresh(ServerSecretStore.layer)),
        );
        assert.isTrue(Option.isNone(before), "no VAPID secret before the first run");

        const { keys, stored } = yield* serverRun(
          Effect.gen(function* () {
            return { keys: yield* VapidKeys, stored: yield* readStoredSecret };
          }),
        );
        assert.isTrue(Option.isSome(stored), "the first run stores the VAPID secret");

        // An uncompressed P-256 point, as `applicationServerKey` needs it.
        const publicPoint = Buffer.from(keys.publicKey, "base64url");
        assert.strictEqual(publicPoint.length, 65);
        assert.strictEqual(publicPoint[0], 0x04);
        assert.strictEqual(publicPoint.toString("base64url"), keys.publicKey);

        // The two halves belong together.
        const privateScalar = Buffer.from(keys.privateKey, "base64url");
        assert.strictEqual(privateScalar.length, 32);
        const ecdh = NodeCrypto.createECDH("prime256v1");
        ecdh.setPrivateKey(privateScalar);
        assert.strictEqual(ecdh.getPublicKey().toString("base64url"), keys.publicKey);

        assert.match(keys.subject, /^(mailto:\S+@\S+|https:\/\/\S+)$/);
      }).pipe(Effect.provide(layerServerConfig())),
  );

  it.effect(
    "push phase 1 AC1: a restarted server returns the same public key and keeps one stored key pair",
    () =>
      Effect.gen(function* () {
        const first = yield* serverRun(
          Effect.gen(function* () {
            return { keys: yield* VapidKeys, stored: yield* readStoredSecret };
          }),
        );
        const second = yield* serverRun(
          Effect.gen(function* () {
            return { keys: yield* VapidKeys, stored: yield* readStoredSecret };
          }),
        );

        assert.strictEqual(second.keys.publicKey, first.keys.publicKey);
        assert.strictEqual(second.keys.privateKey, first.keys.privateKey);
        assert.deepStrictEqual(second.stored, first.stored, "the restart did not rewrite the key");
      }).pipe(Effect.provide(layerServerConfig())),
  );
});
