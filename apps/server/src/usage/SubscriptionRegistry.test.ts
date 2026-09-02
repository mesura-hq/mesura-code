import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";

import { makeSubscriptionRegistry } from "./SubscriptionRegistry.ts";

function fakeSecrets(store: Ref.Ref<ReadonlyMap<string, string>>) {
  return {
    get: (name: string) =>
      Ref.get(store).pipe(
        Effect.map((map) => (map.has(name) ? Option.some(map.get(name)!) : Option.none())),
      ),
    set: (name: string, value: string) =>
      Ref.update(store, (map) => new Map([...map, [name, value]])),
    remove: (name: string) =>
      Ref.update(store, (map) => new Map([...map].filter(([key]) => key !== name))),
  };
}

it.layer(NodeServices.layer)("SubscriptionRegistry", (it) => {
  it.effect("persists a record that names no provider instance", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "subs-" });
      const recordPath = path.join(dir, "subscriptions.json");
      const secrets = fakeSecrets(yield* Ref.make<ReadonlyMap<string, string>>(new Map()));
      const registry = yield* makeSubscriptionRegistry({ recordPath, secrets });

      yield* registry.upsert({
        namespace: "opencode-go",
        label: "OpenCode Go",
        credential: "go-secret-value",
      });

      const stored = yield* fs.readFileString(recordPath);
      assert.equal(stored.includes("opencode-go"), true);
      assert.equal(stored.includes("providerInstanceId"), false);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the credential out of the record and in the secret store", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "subs-secret-" });
      const recordPath = path.join(dir, "subscriptions.json");
      const kept = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
      const registry = yield* makeSubscriptionRegistry({ recordPath, secrets: fakeSecrets(kept) });

      yield* registry.upsert({
        namespace: "zai",
        label: "GLM Coding Plan",
        credential: "zai-secret-value",
      });

      // The key authenticates a request and seeds the account digest. It never
      // reaches the record, the snapshot, or the wire.
      const stored = yield* fs.readFileString(recordPath);
      assert.equal(stored.includes("zai-secret-value"), false);
      assert.equal([...(yield* Ref.get(kept)).values()].includes("zai-secret-value"), true);

      const records = yield* registry.list;
      assert.equal(yield* registry.credential(records[0]!), "zai-secret-value");
    }).pipe(Effect.scoped),
  );

  it.effect("identifies a subscription by a digest of its credential, never the credential", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "subs-id-" });
      const registry = yield* makeSubscriptionRegistry({
        recordPath: path.join(dir, "subscriptions.json"),
        secrets: fakeSecrets(yield* Ref.make<ReadonlyMap<string, string>>(new Map())),
      });

      yield* registry.upsert({ namespace: "zai", label: "GLM", credential: "zai-secret-value" });
      const records = yield* registry.list;
      assert.equal(records[0]?.identifier.includes("zai-secret-value"), false);
      assert.equal(records[0]?.key.startsWith("zai:"), true);
    }).pipe(Effect.scoped),
  );

  it.effect("is idempotent, so seeding twice yields one record per subscription", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "subs-idem-" });
      const registry = yield* makeSubscriptionRegistry({
        recordPath: path.join(dir, "subscriptions.json"),
        secrets: fakeSecrets(yield* Ref.make<ReadonlyMap<string, string>>(new Map())),
      });

      yield* registry.upsert({ namespace: "zai", label: "GLM", credential: "same" });
      yield* registry.upsert({ namespace: "zai", label: "GLM", credential: "same" });
      assert.equal((yield* registry.list).length, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a record and its credential after the source store disappears", () =>
    Effect.gen(function* () {
      // Discovery seeds a record once. Uninstalling OpenCode must not remove
      // the subscription, which is the whole reason the record exists.
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "subs-survive-" });
      const recordPath = path.join(dir, "subscriptions.json");
      const kept = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
      const first = yield* makeSubscriptionRegistry({ recordPath, secrets: fakeSecrets(kept) });
      yield* first.upsert({ namespace: "opencode-go", label: "Go", credential: "go-secret" });

      const restarted = yield* makeSubscriptionRegistry({ recordPath, secrets: fakeSecrets(kept) });
      const records = yield* restarted.list;
      assert.equal(records.length, 1);
      assert.equal(yield* restarted.credential(records[0]!), "go-secret");
    }).pipe(Effect.scoped),
  );
  it.effect("removes the record and its credential together", () =>
    Effect.gen(function* () {
      // The only destructive path in the module. Leaving the credential behind
      // would keep a usable key on disk for a subscription nothing lists.
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "subs-remove-" });
      const kept = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
      const registry = yield* makeSubscriptionRegistry({
        recordPath: path.join(dir, "subscriptions.json"),
        secrets: fakeSecrets(kept),
      });
      yield* registry.upsert({ namespace: "zai", label: "GLM", credential: "zai-secret-value" });
      const record = (yield* registry.list)[0]!;

      yield* registry.remove(record.key);

      assert.deepEqual(yield* registry.list, []);
      assert.equal((yield* Ref.get(kept)).size, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("announces a change, which is what a poller waits on", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "subs-changes-" });
      const registry = yield* makeSubscriptionRegistry({
        recordPath: path.join(dir, "subscriptions.json"),
        secrets: fakeSecrets(yield* Ref.make<ReadonlyMap<string, string>>(new Map())),
      });
      const subscription = yield* registry.subscribeChanges;

      yield* registry.upsert({ namespace: "opencode-go", label: "Go", credential: "go-secret" });
      yield* PubSub.take(subscription);

      const record = (yield* registry.list)[0]!;
      yield* registry.remove(record.key);
      yield* PubSub.take(subscription);
      assert.deepEqual(yield* registry.list, []);
    }).pipe(Effect.scoped),
  );
});
