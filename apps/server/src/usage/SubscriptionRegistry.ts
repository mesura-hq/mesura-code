// @effect-diagnostics nodeBuiltinImport:off -- a synchronous sha256 fingerprint of a credential, computed in a pure helper.
/**
 * The subscriptions this environment meters. A provider instance reads a subscription but does
 * not own it, so a plan keeps its row while its agent is idle, uninstalled or never started.
 * Credentials stay in the secret store, never in the record: every subscription listing reads it.
 *
 * @module usage/SubscriptionRegistry
 */
import { accountLimitsSubscriptionKey, AccountLimitsNamespace } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import {
  discoverOpenCodeCredentials,
  openCodeDataDirectories,
} from "./openCodeCredentialDiscovery.ts";
import { ServerConfig } from "../config.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";

const SUBSCRIPTIONS_FILE_VERSION = 1 as const;

const StoredSubscription = Schema.Struct({
  // The closed union, not a string: a hand-edited or future-version file must
  // not smuggle an unknown namespace into a type the rest of the system trusts.
  namespace: AccountLimitsNamespace,
  identifier: Schema.String,
  label: Schema.String,
  secretName: Schema.String,
});
const SubscriptionsFile = Schema.Struct({
  version: Schema.Literal(SUBSCRIPTIONS_FILE_VERSION),
  subscriptions: Schema.Array(StoredSubscription),
});
const decodeSubscriptionsFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    SubscriptionsFile as unknown as Schema.Codec<typeof SubscriptionsFile.Type>,
  ),
);
const encodeSubscriptionsFile = Schema.encodeEffect(
  Schema.fromJsonString(
    SubscriptionsFile as unknown as Schema.Codec<typeof SubscriptionsFile.Type>,
  ),
);

export interface SubscriptionRecord {
  readonly key: string;
  readonly namespace: AccountLimitsNamespace;
  /** A digest of the credential, never the credential. */
  readonly identifier: string;
  readonly label: string;
  readonly secretName: string;
}

/**
 * The narrow slice of the secret store this registry needs, as plain functions.
 *
 * Taken as an input rather than reached for as a service so the registry can be
 * driven from a test without a layer, which is how `AccountLimitsService` is
 * built too.
 */
export interface SubscriptionSecrets {
  readonly get: (name: string) => Effect.Effect<Option.Option<string>>;
  readonly set: (name: string, value: string) => Effect.Effect<void>;
  readonly remove: (name: string) => Effect.Effect<void>;
}

export interface SubscriptionRegistryShape {
  readonly list: Effect.Effect<ReadonlyArray<SubscriptionRecord>>;
  readonly credential: (record: SubscriptionRecord) => Effect.Effect<string | null>;
  readonly upsert: (input: {
    readonly namespace: AccountLimitsNamespace;
    readonly label: string;
    readonly credential: string;
  }) => Effect.Effect<void>;
  readonly remove: (key: string) => Effect.Effect<void>;
  readonly subscribeChanges: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
}

export class SubscriptionRegistry extends Context.Service<
  SubscriptionRegistry,
  SubscriptionRegistryShape
>()("t3/usage/SubscriptionRegistry") {}

/**
 * The OpenCode Go and Z.ai plans report no account, so a credential digest names the subscription.
 * Environments that share a key fold into one row, and the key never leaves the server.
 * Rotating the credential starts a new row, and the next successful read prunes the old one.
 * An OpenCode-local account id differs per machine, so two machines would never fold on it.
 */
export function subscriptionIdentifierFromCredential(credential: string): string {
  return NodeCrypto.createHash("sha256").update(credential).digest("hex").slice(0, 16);
}

export const makeSubscriptionRegistry = Effect.fn(function* (input: {
  readonly recordPath: string;
  readonly secrets: SubscriptionSecrets;
}): Effect.fn.Return<SubscriptionRegistryShape, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const records = new Map<string, SubscriptionRecord>();
  const stateLock = yield* Semaphore.make(1);
  const changes = yield* PubSub.unbounded<void>();

  const toRecord = (stored: typeof StoredSubscription.Type): SubscriptionRecord => ({
    key: accountLimitsSubscriptionKey({
      namespace: stored.namespace,
      identifier: stored.identifier,
    }),
    namespace: stored.namespace,
    identifier: stored.identifier,
    label: stored.label,
    secretName: stored.secretName,
  });

  /**
   * A file this version cannot decode loads as empty: the array decodes as a unit, so one unknown
   * namespace rejects every entry. Discovery re-seeds the records at the next start, so a corrupt
   * or future-version file costs one boot, not a subscription. Nothing here removes a secret.
   */
  const ensureLoaded = yield* Effect.cached(
    fileSystem.readFileString(input.recordPath).pipe(
      Effect.flatMap(decodeSubscriptionsFile),
      Effect.catchCause(() =>
        Effect.succeed({ version: SUBSCRIPTIONS_FILE_VERSION, subscriptions: [] }),
      ),
      Effect.tap((stored) =>
        Effect.sync(() => {
          for (const subscription of stored.subscriptions) {
            const record = toRecord(subscription);
            records.set(record.key, record);
          }
        }),
      ),
      Effect.asVoid,
    ),
  );

  const persist = Effect.fn("SubscriptionRegistry.persist")(function* () {
    const serialized = yield* encodeSubscriptionsFile({
      version: SUBSCRIPTIONS_FILE_VERSION,
      subscriptions: [...records.values()]
        .sort((left, right) => left.key.localeCompare(right.key))
        .map((record) => ({
          namespace: record.namespace,
          identifier: record.identifier,
          label: record.label,
          secretName: record.secretName,
        })),
    }).pipe(Effect.orDie);
    yield* writeFileStringAtomically({ filePath: input.recordPath, contents: serialized }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  });

  const list = Effect.gen(function* () {
    yield* ensureLoaded;
    return [...records.values()].sort((left, right) => left.key.localeCompare(right.key));
  });

  const credential = (record: SubscriptionRecord) =>
    input.secrets.get(record.secretName).pipe(Effect.map(Option.getOrNull));

  const upsert = Effect.fn("SubscriptionRegistry.upsert")(function* (upsertInput: {
    readonly namespace: AccountLimitsNamespace;
    readonly label: string;
    readonly credential: string;
  }) {
    yield* ensureLoaded;
    const identifier = subscriptionIdentifierFromCredential(upsertInput.credential);
    const key = accountLimitsSubscriptionKey({ namespace: upsertInput.namespace, identifier });
    const secretName = `subscription-${upsertInput.namespace}-${identifier}`;
    yield* stateLock.withPermits(1)(
      Effect.gen(function* () {
        const previous = records.get(key);
        records.set(key, {
          key,
          namespace: upsertInput.namespace,
          identifier,
          label: upsertInput.label,
          secretName,
        });
        yield* input.secrets.set(secretName, upsertInput.credential);
        // Seeding the same credential twice is the ordinary case — discovery
        // runs on every start — so only a real change costs a write. The
        // secret name cannot differ here: it is built from the same namespace
        // and identifier the key was, so only the label can have moved.
        if (previous?.label !== upsertInput.label) {
          yield* persist().pipe(Effect.ignoreCause);
          yield* PubSub.publish(changes, undefined);
        }
      }),
    );
  });

  const remove = Effect.fn("SubscriptionRegistry.remove")(function* (key: string) {
    yield* ensureLoaded;
    yield* stateLock.withPermits(1)(
      Effect.gen(function* () {
        const record = records.get(key);
        if (record === undefined) return;
        records.delete(key);
        yield* input.secrets.remove(record.secretName).pipe(Effect.ignoreCause);
        yield* persist().pipe(Effect.ignoreCause);
        yield* PubSub.publish(changes, undefined);
      }),
    );
  });

  return {
    list,
    credential,
    upsert,
    remove,
    subscribeChanges: PubSub.subscribe(changes),
  } satisfies SubscriptionRegistryShape;
});

/**
 * Seed records from whatever OpenCode is logged into, once.
 *
 * Discovery only *finds* a subscription. The record it writes then stands on
 * its own, so uninstalling OpenCode — or driving the same plan through another
 * agent — leaves the row exactly where it was.
 */
export const seedFromOpenCode = Effect.fn("SubscriptionRegistry.seedFromOpenCode")(
  function* (input: {
    readonly registry: SubscriptionRegistryShape;
    readonly environment: NodeJS.ProcessEnv;
    readonly readFile: (filePath: string) => Effect.Effect<Option.Option<string>>;
  }) {
    for (const dataDir of openCodeDataDirectories(input.environment)) {
      const found = yield* discoverOpenCodeCredentials({ dataDir, readFile: input.readFile });
      if (found.length === 0) continue;
      for (const credential of found) {
        yield* input.registry.upsert({
          namespace: credential.namespace,
          label: credential.label,
          credential: credential.credential,
        });
      }
      // The first directory that answers is the one OpenCode is using.
      return;
    }
  },
);

export const layer = Layer.effect(
  SubscriptionRegistry,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    const store = yield* ServerSecretStore;
    const fileSystem = yield* FileSystem.FileSystem;
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const registry = yield* makeSubscriptionRegistry({
      recordPath: path.join(config.stateDir, "subscriptions.json"),
      // A secret store failure must not take the registry down with it. A
      // subscription whose credential cannot be read is one that cannot be
      // polled, and the panel already renders that as a failed reading.
      secrets: {
        get: (name) =>
          store.get(name).pipe(
            Effect.map(Option.map((bytes) => decoder.decode(bytes))),
            Effect.orElseSucceed(() => Option.none<string>()),
          ),
        set: (name, value) => store.set(name, encoder.encode(value)).pipe(Effect.ignore),
        remove: (name) => store.remove(name).pipe(Effect.ignore),
      },
    });

    yield* seedFromOpenCode({
      registry,
      environment: process.env,
      readFile: (filePath) =>
        fileSystem.readFileString(filePath).pipe(
          Effect.map(Option.some<string>),
          Effect.orElseSucceed(() => Option.none<string>()),
        ),
    });

    return registry;
  }),
);
