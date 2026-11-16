import { Persistence } from "@t3tools/client-runtime/platform";
import { EnvironmentQueryStore } from "@t3tools/client-runtime/state/query-persistence";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";

import * as ConnectionStorage from "./storage";

function idbRequest<A>(request: IDBRequest<A>): Promise<A> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

it.effect.each(["voice-history-outbox", "query"])(
  "upgrades the %s version-5 layout without losing its rows",
  (existingStore) =>
    Effect.gen(function* () {
      const name = "t3code:connection-runtime";
      yield* Effect.promise(() => idbRequest(indexedDB.deleteDatabase(name)));
      const request = indexedDB.open(name, 5);
      request.addEventListener("upgradeneeded", () => {
        const store = request.result.createObjectStore(existingStore);
        if (existingStore === "query") {
          store.createIndex("environment-updated", ["environmentId", "updatedAt", "bytes"]);
        }
        store.put({ transcript: "unconfirmed", payload: "cached" }, "retained");
      });
      const old = yield* Effect.promise(() => idbRequest(request));
      old.close();

      // The layer opens IndexedDB lazily. Read through its store before checking the upgrade.
      yield* Effect.gen(function* () {
        yield* (yield* Persistence.ConnectionTargetStore).list;
      }).pipe(Effect.provide(ConnectionStorage.layer));
      const upgraded = yield* Effect.acquireRelease(
        Effect.promise(() => idbRequest(indexedDB.open(name, 6))),
        (database) => Effect.sync(() => database.close()),
      );
      expect(upgraded.objectStoreNames.contains("voice-history-outbox")).toBe(true);
      expect(upgraded.objectStoreNames.contains("query")).toBe(true);
      const row = yield* Effect.promise(() =>
        idbRequest(upgraded.transaction(existingStore).objectStore(existingStore).get("retained")),
      );
      expect(row).toEqual({ transcript: "unconfirmed", payload: "cached" });
    }),
);

describe("IndexedDB query cache", () => {
  it.effect("round trips per environment and clears with the environment", () =>
    Effect.gen(function* () {
      const store = (yield* EnvironmentQueryStore)!;
      const first = EnvironmentId.make("query-first");
      yield* store.save(first, "pr", "cached");
      expect(yield* store.load(first, "pr")).toEqual(Option.some("cached"));
      expect(yield* store.load(EnvironmentId.make("query-second"), "pr")).toEqual(Option.none());
      yield* (yield* Persistence.EnvironmentCacheStore).clear(first);
      expect(yield* store.load(first, "pr")).toEqual(Option.none());
    }).pipe(Effect.provide(ConnectionStorage.layer)),
  );

  it.effect("two tabs' bursts of saves end within 256 rows and 32 MiB", () =>
    Effect.gen(function* () {
      const openTab = Layer.build(Layer.fresh(ConnectionStorage.layer)).pipe(
        Effect.map((context) => Context.get(context, EnvironmentQueryStore)!),
      );
      const tabs = [yield* openTab, yield* openTab];
      const environmentId = EnvironmentId.make("query-bounded");
      const saveAll = (keys: ReadonlyArray<string>, payload: (key: string) => string) =>
        Effect.forEach(keys, (key, index) =>
          tabs[index % 2]!.save(environmentId, key, payload(key)).pipe(
            Effect.andThen(TestClock.adjust("1 millis")),
          ),
        );
      const loadAll = (keys: ReadonlyArray<string>) =>
        Effect.forEach(keys, (key) => tabs[0]!.load(environmentId, key)).pipe(
          Effect.map((loaded) => loaded.filter(Option.isSome).map((stored) => stored.value)),
        );

      const rows = Array.from({ length: 300 }, (_, index) => `row-${index}`);
      yield* saveAll(rows, (key) => key);
      const keptRows = yield* loadAll(rows);
      expect(keptRows.length).toBeLessThanOrEqual(256);
      expect(keptRows).not.toContain("row-0");
      expect(keptRows).toContain("row-299");

      const answer = "x".repeat(4 * 1024 * 1024);
      const large = Array.from({ length: 9 }, (_, index) => `large-${index}`);
      yield* saveAll(large, () => answer);
      const keptBytes = (yield* loadAll([...rows, ...large])).reduce(
        (total, payload) => total + payload.length,
        0,
      );
      expect(keptBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
      expect(yield* tabs[1]!.load(environmentId, "large-8")).toEqual(Option.some(answer));
    }),
  );

  it.effect("drops the older copy when an answer grows too large to keep", () =>
    Effect.gen(function* () {
      const store = (yield* EnvironmentQueryStore)!;
      const environmentId = EnvironmentId.make("query-oversize");
      yield* store.save(environmentId, "diff", "small");
      yield* store.save(environmentId, "diff", "x".repeat(4 * 1024 * 1024 + 1));
      expect(yield* store.load(environmentId, "diff")).toEqual(Option.none());
    }).pipe(Effect.provide(ConnectionStorage.layer)),
  );
});
