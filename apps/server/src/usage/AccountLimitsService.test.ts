import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AccountLimitsSnapshot,
  isFoldableSubscriptionKey,
  ProviderDriverKind,
  ProviderInstanceId,
  type AccountLimitsAccount,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderDriverError } from "../provider/Errors.ts";
import { makeAccountLimitsService } from "./AccountLimitsService.ts";

const encodeLegacyLimitsCache = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(AccountLimitsSnapshot)),
);

function providerInstance(input: {
  readonly id: string;
  readonly driver: "claudeAgent" | "codex";
  readonly enabled?: boolean;
  readonly account?: AccountLimitsAccount;
  readonly read: () => Effect.Effect<unknown, ProviderDriverError>;
}): ProviderInstance {
  return {
    instanceId: ProviderInstanceId.make(input.id),
    driverKind: ProviderDriverKind.make(input.driver),
    enabled: input.enabled ?? true,
    readAccountLimits: () =>
      input.read().pipe(
        Effect.map((payload) => ({
          payload,
          ...(input.account ? { account: input.account } : {}),
        })),
      ),
  } as ProviderInstance;
}

function claudePayload(usedPercent: number) {
  return {
    subscription_type: "max",
    rate_limits: {
      five_hour: { utilization: usedPercent, resets_at: "2026-08-22T18:00:00.000Z" },
    },
  };
}

function makeTestService(instances: Ref.Ref<ReadonlyArray<ProviderInstance>>, cachePath: string) {
  return makeAccountLimitsService({
    cachePath,
    listInstances: Ref.get(instances),
    refreshInterval: "1 minute",
    freshnessTtl: "5 minutes",
  });
}

it.layer(NodeServices.layer)("AccountLimitsService", (it) => {
  it.effect("refreshes immediately, respects TTL, and persists per-instance snapshots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "account-limits-service-" });
      const cachePath = path.join(tempDir, "account-limits.json");
      const reads = yield* Ref.make(0);
      const firstRead = yield* Deferred.make<void>();
      const instances = yield* Ref.make<ReadonlyArray<ProviderInstance>>([
        providerInstance({
          id: "claude_work",
          driver: "claudeAgent",
          read: () =>
            Ref.updateAndGet(reads, (count) => count + 1).pipe(
              Effect.tap(() => Deferred.succeed(firstRead, undefined)),
              Effect.as(claudePayload(20)),
            ),
        }),
      ]);
      const service = yield* makeTestService(instances, cachePath);
      const runFiber = yield* service.run.pipe(Effect.forkScoped);

      yield* Deferred.await(firstRead);
      assert.equal(yield* Ref.get(reads), 1);
      yield* Fiber.interrupt(runFiber);
      yield* service.refreshStale;
      assert.equal(yield* Ref.get(reads), 1);
      yield* TestClock.adjust("5 minutes");
      yield* service.refreshStale;
      assert.equal(yield* Ref.get(reads), 2);

      const summary = yield* service.readSummary();
      assert.equal(summary.snapshots[0]?.reader?.providerInstanceId, "claude_work");
      // A provider that named no account yields an unfoldable subscription, so
      // two machines running this same instance id stay two rows.
      assert.equal(summary.snapshots[0]?.subscription.key, "#instance:claude_work");
      assert.equal(isFoldableSubscriptionKey(summary.snapshots[0]!.subscription.key), false);
      assert.equal(summary.snapshots[0]?.observation?.windows[0]?.usedPercent, 20);
      assert.equal(yield* fs.exists(cachePath), true);
      assert.match(yield* fs.readFileString(cachePath), /"version":1/);
    }).pipe(Effect.scoped),
  );

  it.effect("restores persisted readings after restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "account-limits-restart-" });
      const cachePath = path.join(tempDir, "account-limits.json");
      const instances = yield* Ref.make<ReadonlyArray<ProviderInstance>>([
        providerInstance({
          id: "claude",
          driver: "claudeAgent",
          read: () => Effect.succeed(claudePayload(37)),
        }),
      ]);
      const first = yield* makeTestService(instances, cachePath);
      yield* first.refreshStale;
      const firstSummary = yield* first.readSummary();
      const legacyCache = yield* encodeLegacyLimitsCache(firstSummary.snapshots);
      yield* fs.writeFileString(cachePath, legacyCache);

      const restarted = yield* makeTestService(instances, cachePath);
      const summary = yield* restarted.readSummary();
      assert.equal(summary.snapshots[0]?.observation?.windows[0]?.usedPercent, 37);
      assert.match(yield* fs.readFileString(cachePath), /"version":1/);
    }).pipe(Effect.scoped),
  );

  it.effect("refreshes a rebuilt instance with the same id without reusing its snapshot", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "account-limits-rebuild-" });
      const first = providerInstance({
        id: "claude",
        driver: "claudeAgent",
        read: () => Effect.succeed(claudePayload(22)),
      });
      const replacementReads = yield* Ref.make(0);
      const replacement = providerInstance({
        id: "claude",
        driver: "claudeAgent",
        read: () =>
          Ref.update(replacementReads, (count) => count + 1).pipe(Effect.as(claudePayload(73))),
      });
      const instances = yield* Ref.make<ReadonlyArray<ProviderInstance>>([first]);
      const service = yield* makeTestService(instances, path.join(tempDir, "cache.json"));
      yield* service.refreshStale;
      assert.equal(
        (yield* service.readSummary()).snapshots[0]?.observation?.windows[0]?.usedPercent,
        22,
      );

      yield* Ref.set(instances, [replacement]);
      assert.equal((yield* service.readSummary()).snapshots.length, 0);
      yield* service.refreshStale;

      assert.equal(yield* Ref.get(replacementReads), 1);
      assert.equal(
        (yield* service.readSummary()).snapshots[0]?.observation?.windows[0]?.usedPercent,
        73,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("refreshes a rebuilt instance when the registry publishes a change", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "account-limits-change-" });
      const replacementRead = yield* Deferred.make<void>();
      const first = providerInstance({
        id: "claude",
        driver: "claudeAgent",
        read: () => Effect.succeed(claudePayload(22)),
      });
      const replacement = providerInstance({
        id: "claude",
        driver: "claudeAgent",
        read: () => Deferred.succeed(replacementRead, undefined).pipe(Effect.as(claudePayload(73))),
      });
      const instances = yield* Ref.make<ReadonlyArray<ProviderInstance>>([first]);
      const changes = yield* PubSub.unbounded<void>();
      const subscription = yield* PubSub.subscribe(changes);
      const service = yield* makeAccountLimitsService({
        cachePath: path.join(tempDir, "cache.json"),
        listInstances: Ref.get(instances),
        registryChanges: subscription,
      });
      yield* service.refreshStale;
      const scheduler = yield* service.run.pipe(Effect.forkScoped);

      yield* Ref.set(instances, [replacement]);
      yield* PubSub.publish(changes, undefined);
      yield* Deferred.await(replacementRead);

      yield* Fiber.interrupt(scheduler);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects an old in-flight result after the same id is rebuilt", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "account-limits-race-" });
      const oldReadStarted = yield* Deferred.make<void>();
      const releaseOldRead = yield* Deferred.make<void>();
      const oldInstance = providerInstance({
        id: "claude",
        driver: "claudeAgent",
        read: () =>
          Deferred.succeed(oldReadStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseOldRead)),
            Effect.as(claudePayload(11)),
          ),
      });
      const replacement = providerInstance({
        id: "claude",
        driver: "claudeAgent",
        read: () => Effect.succeed(claudePayload(79)),
      });
      const instances = yield* Ref.make<ReadonlyArray<ProviderInstance>>([oldInstance]);
      const service = yield* makeTestService(instances, path.join(tempDir, "cache.json"));
      const oldRefresh = yield* service.refreshStale.pipe(Effect.forkChild);
      yield* Deferred.await(oldReadStarted);

      yield* Ref.set(instances, [replacement]);
      const replacementRefresh = yield* service.refreshStale.pipe(Effect.forkChild);
      yield* Deferred.succeed(releaseOldRead, undefined);
      yield* Fiber.join(oldRefresh);
      yield* Fiber.join(replacementRefresh);

      const snapshot = (yield* service.readSummary()).snapshots[0];
      assert.equal(snapshot?.observation?.windows[0]?.usedPercent, 79);
    }).pipe(Effect.scoped),
  );

  it.effect("carries the account a reading came from, and keeps it across a failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "account-limits-account-" });
      const shouldFail = yield* Ref.make(false);
      const instances = yield* Ref.make<ReadonlyArray<ProviderInstance>>([
        providerInstance({
          id: "claude",
          driver: "claudeAgent",
          account: { key: "claudeAgent:dev@example.com", label: "dev@example.com" },
          read: () =>
            Ref.get(shouldFail).pipe(
              Effect.flatMap((fail) =>
                fail
                  ? Effect.fail(
                      new ProviderDriverError({
                        driver: "claudeAgent",
                        instanceId: "claude",
                        detail: "unreachable",
                      }),
                    )
                  : Effect.succeed(claudePayload(31)),
              ),
            ),
        }),
      ]);
      const service = yield* makeTestService(instances, path.join(tempDir, "cache.json"));
      yield* service.refreshStale;

      assert.deepEqual((yield* service.readSummary()).snapshots[0]?.subscription, {
        key: "claudeAgent:dev@example.com",
        label: "dev@example.com",
      });

      // The subscription a cached reading belongs to does not change because a
      // poll failed, and the client needs it to keep folding environments.
      yield* Ref.set(shouldFail, true);
      yield* TestClock.adjust("5 minutes");
      yield* service.refreshStale;

      const failed = (yield* service.readSummary()).snapshots[0];
      assert.equal(failed?.lastAttempt.status, "failed");
      assert.equal(failed?.subscription.key, "claudeAgent:dev@example.com");
    }).pipe(Effect.scoped),
  );

  it.effect("dates each window with the reading that produced it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "account-limits-window-age-" });
      const instances = yield* Ref.make<ReadonlyArray<ProviderInstance>>([
        providerInstance({
          id: "claude",
          driver: "claudeAgent",
          read: () =>
            Effect.succeed({
              subscription_type: "max",
              rate_limits: {
                five_hour: { utilization: 20, resets_at: "2026-08-22T18:00:00.000Z" },
                seven_day: { utilization: 40, resets_at: "2026-08-29T12:00:00.000Z" },
              },
            }),
        }),
      ]);
      const service = yield* makeTestService(instances, path.join(tempDir, "cache.json"));
      yield* service.refreshStale;

      const polled = (yield* service.readSummary()).snapshots[0]?.observation;
      const polledAt = polled?.observedAt;
      assert.equal(
        polled?.windows.every((window) => window.observedAt === polledAt),
        true,
      );

      // An event names one window. The windows it carries over keep their own
      // dates, so a stale number never claims the event's freshness.
      yield* service.ingest({
        providerInstanceId: ProviderInstanceId.make("claude"),
        driver: ProviderDriverKind.make("claudeAgent"),
        payload: {
          rate_limit_info: {
            rateLimitType: "five_hour",
            utilization: 55,
            resetsAt: 1_787_000_000,
          },
        },
        createdAt: "2026-09-01T10:00:00.000Z",
      });

      const merged = (yield* service.readSummary()).snapshots[0]?.observation;
      const fiveHour = merged?.windows.find((window) => window.id === "five_hour");
      const sevenDay = merged?.windows.find((window) => window.id === "seven_day");
      assert.equal(fiveHour?.usedPercent, 55);
      assert.equal(fiveHour?.observedAt, "2026-09-01T10:00:00.000Z");
      assert.equal(sevenDay?.usedPercent, 40);
      assert.equal(sevenDay?.observedAt, polledAt);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a newer passive event and rejects an older event", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "account-limits-ingest-" });
      const instances = yield* Ref.make<ReadonlyArray<ProviderInstance>>([
        providerInstance({
          id: "claude",
          driver: "claudeAgent",
          read: () => Effect.succeed(claudePayload(0)),
        }),
      ]);
      const service = yield* makeTestService(instances, path.join(tempDir, "cache.json"));

      yield* service.ingest({
        providerInstanceId: ProviderInstanceId.make("claude"),
        driver: ProviderDriverKind.make("claudeAgent"),
        payload: claudePayload(44),
        createdAt: "2026-08-22T12:00:00.000Z",
      });
      yield* service.ingest({
        providerInstanceId: ProviderInstanceId.make("claude"),
        driver: ProviderDriverKind.make("claudeAgent"),
        payload: claudePayload(10),
        createdAt: "2026-08-22T11:00:00.000Z",
      });

      const summary = yield* service.readSummary();
      assert.equal(summary.snapshots[0]?.observation?.windows[0]?.usedPercent, 44);
      assert.equal(summary.snapshots[0]?.observation?.source, "event");
    }).pipe(Effect.scoped),
  );

  it.effect("attributes a passive event to one instance and suppresses only its poll", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "account-limits-instance-" });
      const workReads = yield* Ref.make(0);
      const personalReads = yield* Ref.make(0);
      const instances = yield* Ref.make<ReadonlyArray<ProviderInstance>>([
        providerInstance({
          id: "codex_work",
          driver: "codex",
          read: () => Ref.update(workReads, (count) => count + 1).pipe(Effect.as({})),
        }),
        providerInstance({
          id: "codex_personal",
          driver: "codex",
          read: () =>
            Ref.update(personalReads, (count) => count + 1).pipe(
              Effect.as({
                rateLimits: {
                  limitId: "codex",
                  primary: { usedPercent: 12, windowDurationMins: 10_080 },
                },
              }),
            ),
        }),
      ]);
      const service = yield* makeTestService(instances, path.join(tempDir, "cache.json"));

      yield* service.ingest({
        providerInstanceId: ProviderInstanceId.make("codex_work"),
        driver: ProviderDriverKind.make("codex"),
        payload: {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 48, windowDurationMins: 10_080 },
          },
        },
        createdAt: "2026-08-22T12:00:00.000Z",
      });
      yield* TestClock.setTime(Date.parse("2026-08-22T12:01:00.000Z"));
      yield* service.refreshStale;

      assert.equal(yield* Ref.get(workReads), 0);
      assert.equal(yield* Ref.get(personalReads), 1);
      const summary = yield* service.readSummary();
      assert.equal(summary.snapshots.length, 2);
      assert.equal(summary.snapshots[0]?.reader?.providerInstanceId, "codex_personal");
      assert.equal(summary.snapshots[1]?.reader?.providerInstanceId, "codex_work");
      assert.equal(summary.snapshots[1]?.observation?.windows[0]?.usedPercent, 48);
    }).pipe(Effect.scoped),
  );

  it.effect("merges sparse Codex meter events without dropping prior windows", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "account-limits-meters-" });
      const instances = yield* Ref.make<ReadonlyArray<ProviderInstance>>([
        providerInstance({
          id: "codex",
          driver: "codex",
          read: () =>
            Effect.succeed({
              rateLimits: {
                limitId: "codex",
                primary: { usedPercent: 40, windowDurationMins: 10_080 },
              },
            }),
        }),
      ]);
      const service = yield* makeTestService(instances, path.join(tempDir, "cache.json"));

      yield* service.ingest({
        providerInstanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        payload: {
          limitId: "codex",
          primary: { usedPercent: 35, windowDurationMins: 10_080 },
        },
        createdAt: "2026-08-22T12:00:00.000Z",
      });
      yield* service.ingest({
        providerInstanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        payload: {
          limitId: "codex_spark",
          limitName: "GPT-5.3-Codex-Spark",
          primary: { usedPercent: 5, windowDurationMins: 300 },
        },
        createdAt: "2026-08-22T12:01:00.000Z",
      });

      yield* TestClock.setTime(Date.parse("2026-08-22T12:06:00.000Z"));
      yield* service.refreshStale;

      const windows = (yield* service.readSummary()).snapshots[0]?.observation?.windows ?? [];
      assert.equal(windows.find((window) => window.meter?.id === "codex")?.usedPercent, 40);
      assert.equal(windows.find((window) => window.meter?.id === "codex_spark")?.usedPercent, 5);
    }).pipe(Effect.scoped),
  );

  it.effect("preserves the last reading when refresh fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "account-limits-failure-" });
      const shouldFail = yield* Ref.make(false);
      const instances = yield* Ref.make<ReadonlyArray<ProviderInstance>>([
        providerInstance({
          id: "claude",
          driver: "claudeAgent",
          read: () =>
            Ref.get(shouldFail).pipe(
              Effect.flatMap((fail) =>
                fail
                  ? Effect.fail(
                      new ProviderDriverError({
                        driver: "claudeAgent",
                        instanceId: "claude",
                        detail: "secret-bearing provider error",
                      }),
                    )
                  : Effect.succeed(claudePayload(61)),
              ),
            ),
        }),
      ]);
      const service = yield* makeTestService(instances, path.join(tempDir, "cache.json"));
      yield* service.refreshStale;
      yield* Ref.set(shouldFail, true);
      yield* TestClock.adjust("5 minutes");
      yield* service.refreshStale;

      const snapshot = (yield* service.readSummary()).snapshots[0];
      assert.equal(snapshot?.observation?.windows[0]?.usedPercent, 61);
      assert.equal(snapshot?.lastAttempt.status, "failed");
      assert.equal(snapshot?.lastAttempt.error, "Account-limit refresh failed.");
    }).pipe(Effect.scoped),
  );

  it.effect("marks an unrecognized provider response as a bounded refresh failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "account-limits-malformed-" });
      const instances = yield* Ref.make<ReadonlyArray<ProviderInstance>>([
        providerInstance({
          id: "claude",
          driver: "claudeAgent",
          read: () => Effect.succeed({ unexpected: "provider schema" }),
        }),
      ]);
      const service = yield* makeTestService(instances, path.join(tempDir, "cache.json"));
      yield* service.refreshStale;

      const snapshot = (yield* service.readSummary()).snapshots[0];
      assert.equal(snapshot?.observation, null);
      assert.equal(snapshot?.lastAttempt.status, "failed");
      assert.equal(snapshot?.lastAttempt.error, "Account-limit refresh failed.");
    }).pipe(Effect.scoped),
  );

  it.effect("removes disabled or unsupported instances during reconciliation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "account-limits-reconcile-" });
      const instance = providerInstance({
        id: "codex_work",
        driver: "codex",
        read: () =>
          Effect.succeed({
            rateLimits: {
              limitId: "codex",
              primary: { usedPercent: 18, windowDurationMins: 10_080, resetsAt: 1_786_677_720 },
            },
          }),
      });
      const instances = yield* Ref.make<ReadonlyArray<ProviderInstance>>([instance]);
      const service = yield* makeTestService(instances, path.join(tempDir, "cache.json"));
      yield* service.refreshStale;
      assert.equal((yield* service.readSummary()).snapshots.length, 1);

      yield* Ref.set(instances, [{ ...instance, enabled: false }]);
      assert.equal((yield* service.readSummary()).snapshots.length, 0);
      yield* service.refreshStale;
      assert.equal((yield* service.readSummary()).snapshots.length, 0);

      yield* Ref.set(instances, [instance]);
      yield* service.refreshStale;
      assert.equal((yield* service.readSummary()).snapshots.length, 1);
      const { readAccountLimits: _readAccountLimits, ...unsupportedInstance } = instance;
      yield* Ref.set(instances, [unsupportedInstance]);
      assert.equal((yield* service.readSummary()).snapshots.length, 0);
      yield* service.refreshStale;
      assert.equal((yield* service.readSummary()).snapshots.length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("coalesces concurrent refreshes for one provider instance", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({
        prefix: "account-limits-single-flight-",
      });
      const reads = yield* Ref.make(0);
      const release = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const instances = yield* Ref.make<ReadonlyArray<ProviderInstance>>([
        providerInstance({
          id: "claude",
          driver: "claudeAgent",
          read: () =>
            Ref.update(reads, (count) => count + 1).pipe(
              Effect.tap(() => Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(release)),
              Effect.as(claudePayload(12)),
            ),
        }),
      ]);
      const service = yield* makeTestService(instances, path.join(tempDir, "cache.json"));
      const first = yield* service.refreshStale.pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const second = yield* service.refreshStale.pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(reads), 1);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
    }).pipe(Effect.scoped),
  );

  it.effect("does not let an older in-flight poll overwrite a newer passive event", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "account-limits-ordering-" });
      const pollStarted = yield* Deferred.make<void>();
      const releasePoll = yield* Deferred.make<void>();
      const instances = yield* Ref.make<ReadonlyArray<ProviderInstance>>([
        providerInstance({
          id: "claude",
          driver: "claudeAgent",
          read: () =>
            Deferred.succeed(pollStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releasePoll)),
              Effect.as(claudePayload(10)),
            ),
        }),
      ]);
      const service = yield* makeTestService(instances, path.join(tempDir, "cache.json"));
      yield* TestClock.setTime(Date.parse("2026-08-22T12:00:00.000Z"));
      const refresh = yield* service.refreshStale.pipe(Effect.forkChild);
      yield* Deferred.await(pollStarted);

      yield* service.ingest({
        providerInstanceId: ProviderInstanceId.make("claude"),
        driver: ProviderDriverKind.make("claudeAgent"),
        payload: claudePayload(55),
        createdAt: "2026-08-22T12:00:00.000Z",
      });
      yield* Deferred.succeed(releasePoll, undefined);
      yield* Fiber.join(refresh);

      const snapshot = (yield* service.readSummary()).snapshots[0];
      assert.equal(snapshot?.observation?.windows[0]?.usedPercent, 55);
      assert.equal(snapshot?.observation?.source, "event");
      assert.equal(snapshot?.lastAttempt.attemptedAt, "2026-08-22T12:00:00.000Z");
    }).pipe(Effect.scoped),
  );

  it.effect("does not resurrect an instance removed during an in-flight poll", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "account-limits-delete-" });
      const pollStarted = yield* Deferred.make<void>();
      const releasePoll = yield* Deferred.make<void>();
      const instance = providerInstance({
        id: "claude",
        driver: "claudeAgent",
        read: () =>
          Deferred.succeed(pollStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releasePoll)),
            Effect.as(claudePayload(88)),
          ),
      });
      const instances = yield* Ref.make<ReadonlyArray<ProviderInstance>>([instance]);
      const service = yield* makeTestService(instances, path.join(tempDir, "cache.json"));
      const refresh = yield* service.refreshStale.pipe(Effect.forkChild);
      yield* Deferred.await(pollStarted);

      yield* Ref.set(instances, []);
      const removalRefresh = yield* service.refreshStale.pipe(Effect.forkChild);
      yield* Deferred.succeed(releasePoll, undefined);
      yield* Fiber.join(refresh);
      yield* Fiber.join(removalRefresh);

      assert.equal((yield* service.readSummary()).snapshots.length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("interrupts an active reader when the scheduler scope closes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "account-limits-shutdown-" });
      const pollStarted = yield* Deferred.make<void>();
      const pollInterrupted = yield* Deferred.make<void>();
      const instances = yield* Ref.make<ReadonlyArray<ProviderInstance>>([
        providerInstance({
          id: "claude",
          driver: "claudeAgent",
          read: () =>
            Deferred.succeed(pollStarted, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(pollInterrupted, undefined)),
            ),
        }),
      ]);
      const cachePath = path.join(tempDir, "cache.json");
      const service = yield* makeTestService(instances, cachePath);
      const scheduler = yield* service.run.pipe(Effect.forkScoped);
      yield* Deferred.await(pollStarted);

      yield* Fiber.interrupt(scheduler);
      yield* Deferred.await(pollInterrupted);

      assert.equal(yield* fs.exists(cachePath), false);
    }).pipe(Effect.scoped),
  );
});
