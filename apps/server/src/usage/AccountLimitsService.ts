/** Resident, per-provider-instance account-limit authority. */
import {
  ACCOUNT_LIMITS_CONTRACT_VERSION,
  accountLimitsWindowKey,
  AccountLimitsSnapshot,
  unfoldableInstanceSubscription,
  type AccountLimitsAccount,
  type AccountLimitsSummary,
  type AccountLimitsWindow,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import {
  normalizeClaudeAccountLimits,
  normalizeClaudeRateLimitEvent,
  normalizeCodexAccountLimits,
  type NormalizedAccountLimits,
} from "./accountLimitsNormalize.ts";

const DEFAULT_REFRESH_INTERVAL = Duration.minutes(1);
const DEFAULT_FRESHNESS_TTL = Duration.minutes(5);
const ACCOUNT_LIMITS_CACHE_VERSION = 2 as const;

const LimitsCacheFile = Schema.Struct({
  version: Schema.Literal(ACCOUNT_LIMITS_CACHE_VERSION),
  snapshots: Schema.Array(AccountLimitsSnapshot),
});
/**
 * Version 1 files are read as empty rather than migrated.
 *
 * Every key in a version 1 file is a provider instance id, and a subscription
 * cannot be recovered from one — migrating would invent subscriptions that were
 * never read. The decode fails, the caller's `catchCause` yields an empty cache,
 * and the next poll repopulates it from the providers themselves.
 */
const decodeLimitsCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(LimitsCacheFile as unknown as Schema.Codec<typeof LimitsCacheFile.Type>),
);
const encodeLimitsCache = Schema.encodeEffect(
  Schema.fromJsonString(LimitsCacheFile as unknown as Schema.Codec<typeof LimitsCacheFile.Type>),
);

export interface AccountLimitsIngestInput {
  readonly providerInstanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly payload: unknown;
  readonly createdAt: string;
}

export interface AccountLimitsServiceShape {
  readonly readSummary: () => Effect.Effect<AccountLimitsSummary>;
  readonly ingest: (input: AccountLimitsIngestInput) => Effect.Effect<void>;
  readonly refreshStale: Effect.Effect<void>;
  readonly run: Effect.Effect<never>;
}

export class AccountLimitsService extends Context.Service<
  AccountLimitsService,
  AccountLimitsServiceShape
>()("t3/usage/AccountLimitsService") {}

export const layerTest = Layer.succeed(
  AccountLimitsService,
  AccountLimitsService.of({
    readSummary: () =>
      Effect.succeed({
        contractVersion: ACCOUNT_LIMITS_CONTRACT_VERSION,
        readAt: "1970-01-01T00:00:00.000Z",
        snapshots: [],
      }),
    ingest: () => Effect.void,
    refreshStale: Effect.void,
    run: Effect.never,
  }),
);

/**
 * The subscription of a reading whose provider named no account.
 *
 * The subscription registry replaces this in a later phase. Until then a
 * reading whose provider named no account still needs *some* subscription,
 * because the contract now requires one — and the instance it was read through
 * is the only identity available. That keeps today's one-row-per-instance
 * behaviour exactly as it was rather than folding anything new.
 */
function instanceSubscription(instance: ProviderInstance): AccountLimitsAccount {
  return unfoldableInstanceSubscription({
    instanceId: String(instance.instanceId),
    label: instance.displayName,
  });
}

function lastAttemptMillis(snapshot: AccountLimitsSnapshot): number | null {
  const millis = Date.parse(snapshot.lastAttempt.attemptedAt);
  return Number.isFinite(millis) ? millis : null;
}

function boundedFailure(): string {
  return "Account-limit refresh failed.";
}

function hasNewerAttempt(snapshot: AccountLimitsSnapshot, attemptedAt: string): boolean {
  return Date.parse(snapshot.lastAttempt.attemptedAt) >= Date.parse(attemptedAt);
}

function normalizePoll(
  driver: ProviderDriverKind,
  payload: unknown,
): NormalizedAccountLimits | null {
  if (driver === "claudeAgent") return normalizeClaudeAccountLimits(payload);
  if (driver === "codex") return normalizeCodexAccountLimits(payload);
  return null;
}

/**
 * Replace a window in place rather than moving it to the end. A provider event
 * names one window, and appending it would reorder the panel's bars on every
 * event and order them back on the next full poll.
 */
function mergeWindow(
  previous: readonly AccountLimitsWindow[],
  next: AccountLimitsWindow,
): readonly AccountLimitsWindow[] {
  const nextKey = accountLimitsWindowKey(next);
  return previous.some((window) => accountLimitsWindowKey(window) === nextKey)
    ? previous.map((window) => (accountLimitsWindowKey(window) === nextKey ? next : window))
    : [...previous, next];
}

function mergeWindows(
  previous: readonly AccountLimitsWindow[],
  next: readonly AccountLimitsWindow[],
): readonly AccountLimitsWindow[] {
  return next.reduce<readonly AccountLimitsWindow[]>(mergeWindow, previous);
}

/**
 * Date each window with the reading that produced it.
 *
 * A merge carries windows a provider did not report this time, so one
 * observation holds numbers of different ages. Without a per-window date the
 * merged result claims the newest reading's freshness for all of them, which is
 * what made two environments on one subscription disagree while both looked
 * current.
 *
 * The date is when the reading was asked for, not when it came back, so it runs
 * early by however long the provider took to answer — seconds for a poll that
 * spawns a CLI. Readings of one subscription sit minutes apart, so that bias
 * never decides which environment a window comes from.
 */
function stampWindows(
  windows: readonly AccountLimitsWindow[],
  observedAt: string,
): readonly AccountLimitsWindow[] {
  return windows.map((window) => ({ ...window, observedAt }));
}

/**
 * One reading built from a provider event.
 *
 * Two payload shapes arrive on this path. A full usage payload normalizes like
 * a poll does. A Claude rate-limit event names one window instead, and that one
 * is merged into the windows already held so the rest keep their own dates.
 */
function eventReading(
  event: AccountLimitsIngestInput,
  previous: AccountLimitsSnapshot | undefined,
): { readonly plan: string | null; readonly windows: readonly AccountLimitsWindow[] } | null {
  const held = previous?.observation?.windows ?? [];
  const polled = normalizePoll(event.driver, event.payload);
  if (polled !== null) {
    return { plan: polled.plan, windows: stampWindows(polled.windows, event.createdAt) };
  }
  if (event.driver !== "claudeAgent") return null;
  const window = normalizeClaudeRateLimitEvent(event.payload);
  if (window === null) return null;
  return {
    plan: previous?.observation?.plan ?? null,
    windows: mergeWindow(held, { ...window, observedAt: event.createdAt }),
  };
}

export function makeAccountLimitsService(input: {
  readonly cachePath: string;
  readonly listInstances: Effect.Effect<ReadonlyArray<ProviderInstance>>;
  readonly refreshInterval?: Duration.Input;
  readonly freshnessTtl?: Duration.Input;
  readonly registryChanges?: PubSub.Subscription<void>;
}): Effect.Effect<AccountLimitsServiceShape, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const snapshots = new Map<string, AccountLimitsSnapshot>();
    const inFlight = new Set<ProviderInstance>();
    const knownInstances = new Map<string, ProviderInstance>();
    /**
     * Which subscription each instance last reported, by instance id.
     *
     * A failed read does not name a subscription, so this is how the failure is
     * attributed to the right one. It is also what pruning reads: a snapshot no
     * live instance claims is orphaned, and a failed read leaves the claim
     * standing precisely so one blip cannot delete a row.
     */
    const claimedSubscriptions = new Map<string, string>();
    const stateLock = yield* Semaphore.make(1);
    const refreshLock = yield* Semaphore.make(1);
    const refreshInterval = Duration.fromInputUnsafe(
      input.refreshInterval ?? DEFAULT_REFRESH_INTERVAL,
    );
    const freshnessTtlMs = Duration.toMillis(
      Duration.fromInputUnsafe(input.freshnessTtl ?? DEFAULT_FRESHNESS_TTL),
    );
    const listEligibleInstances = input.listInstances.pipe(
      Effect.map((instances) =>
        instances.filter(
          (instance) => instance.enabled && instance.readAccountLimits !== undefined,
        ),
      ),
    );

    const ensureLoaded = yield* Effect.cached(
      fileSystem.readFileString(input.cachePath).pipe(
        Effect.flatMap(decodeLimitsCache),
        Effect.catchCause(() =>
          Effect.succeed({ version: ACCOUNT_LIMITS_CACHE_VERSION, snapshots: [] }),
        ),
        Effect.tap((stored) =>
          Effect.sync(() => {
            for (const snapshot of stored.snapshots) {
              snapshots.set(snapshot.subscription.key, snapshot);
              const reader = snapshot.reader;
              if (reader !== undefined) {
                claimedSubscriptions.set(
                  String(reader.providerInstanceId),
                  snapshot.subscription.key,
                );
              }
            }
          }),
        ),
        Effect.asVoid,
      ),
    );

    const persist = Effect.fn("AccountLimitsService.persist")(function* () {
      const serialized = yield* encodeLimitsCache({
        version: ACCOUNT_LIMITS_CACHE_VERSION,
        snapshots: [...snapshots.values()].sort((left, right) =>
          left.subscription.key.localeCompare(right.subscription.key),
        ),
      }).pipe(Effect.orDie);
      yield* writeFileStringAtomically({ filePath: input.cachePath, contents: serialized }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
    });

    const reconcileInstances = Effect.fn("AccountLimitsService.reconcileInstances")(function* (
      eligible: ReadonlyArray<ProviderInstance>,
    ) {
      yield* stateLock.withPermits(1)(
        Effect.gen(function* () {
          const activeIds = new Set(eligible.map((instance) => String(instance.instanceId)));
          let changed = false;

          for (const key of knownInstances.keys()) {
            if (!activeIds.has(key)) knownInstances.delete(key);
          }
          for (const key of claimedSubscriptions.keys()) {
            if (!activeIds.has(key)) claimedSubscriptions.delete(key);
          }
          for (const instance of eligible) {
            const key = String(instance.instanceId);
            const previousInstance = knownInstances.get(key);
            // A replaced instance may have been reconfigured onto another
            // account, so its old claim is not evidence about the new one.
            if (previousInstance !== undefined && previousInstance !== instance) {
              claimedSubscriptions.delete(key);
              changed = true;
            }
            knownInstances.set(key, instance);
          }

          // A snapshot no live instance claims is orphaned. A directly polled
          // subscription has no instance to claim it and is never orphaned this
          // way — its own source decides whether it still exists.
          const claimed = new Set(claimedSubscriptions.values());
          for (const [key, snapshot] of snapshots) {
            if (snapshot.reader === undefined || claimed.has(key)) continue;
            snapshots.delete(key);
            changed = true;
          }

          if (changed) yield* persist().pipe(Effect.catchCause(() => Effect.void));
        }),
      );
    });

    /** Whether any instance still reads this subscription. */
    const isClaimed = (subscriptionKey: string) => {
      for (const claimed of claimedSubscriptions.values()) {
        if (claimed === subscriptionKey) return true;
      }
      return false;
    };

    const isCurrentInstance = (instance: ProviderInstance) =>
      listEligibleInstances.pipe(
        Effect.map((eligible) =>
          eligible.some(
            (current) => current.instanceId === instance.instanceId && current === instance,
          ),
        ),
      );

    const commitRefresh = Effect.fn("AccountLimitsService.commitRefresh")(function* (
      instance: ProviderInstance,
      attemptedAt: string,
      normalized: NormalizedAccountLimits | null,
      account?: AccountLimitsAccount | undefined,
    ) {
      if (!(yield* isCurrentInstance(instance))) return;
      yield* stateLock.withPermits(1)(
        Effect.gen(function* () {
          const instanceId = String(instance.instanceId);
          if (knownInstances.get(instanceId) !== instance) return;
          // A read that failed named no subscription, so it is attributed to
          // the one this instance last reported. Without that memory a failure
          // would open a second row rather than mark the row it belongs to.
          const claimedKey = claimedSubscriptions.get(instanceId);
          const subscription =
            account ??
            (claimedKey !== undefined ? snapshots.get(claimedKey)?.subscription : undefined) ??
            instanceSubscription(instance);
          const key = subscription.key;
          const previous = snapshots.get(key);
          if (previous && hasNewerAttempt(previous, attemptedAt)) return;
          // Only a successful read moves the claim. A failed one leaves it
          // standing, which is what stops one blip pruning the subscription.
          if (normalized !== null) {
            claimedSubscriptions.set(instanceId, key);
            // Only drop the subscription this instance moved off when no other
            // instance still reads it. A shared subscription belongs to every
            // reader of it, and this one's move omits nothing on their behalf.
            if (claimedKey !== undefined && claimedKey !== key && !isClaimed(claimedKey)) {
              snapshots.delete(claimedKey);
            }
          }
          const stamped = normalized === null ? [] : stampWindows(normalized.windows, attemptedAt);
          snapshots.set(
            key,
            normalized === null
              ? {
                  subscription,
                  reader: { providerInstanceId: instance.instanceId, driver: instance.driverKind },
                  observation: previous?.observation ?? null,
                  lastAttempt: {
                    attemptedAt,
                    status: "failed",
                    error: boundedFailure(),
                  },
                }
              : {
                  subscription,
                  reader: { providerInstanceId: instance.instanceId, driver: instance.driverKind },
                  observation: {
                    plan: normalized.plan ?? previous?.observation?.plan ?? null,
                    windows:
                      instance.driverKind === "codex"
                        ? mergeWindows(previous?.observation?.windows ?? [], stamped)
                        : stamped,
                    observedAt: attemptedAt,
                    source: "poll",
                  },
                  lastAttempt: { attemptedAt, status: "succeeded", error: null },
                },
          );
          yield* persist().pipe(Effect.catchCause(() => Effect.void));
        }),
      );
    });

    const refreshInstance = Effect.fn("AccountLimitsService.refreshInstance")(function* (
      instance: ProviderInstance,
      nowMs: number,
    ) {
      const claimed = yield* stateLock.withPermits(1)(
        Effect.sync(() => {
          if (inFlight.has(instance)) return false;
          inFlight.add(instance);
          return true;
        }),
      );
      if (!claimed || !instance.readAccountLimits) return;

      const attemptedAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
      yield* instance.readAccountLimits().pipe(
        Effect.matchEffect({
          onFailure: () => commitRefresh(instance, attemptedAt, null),
          onSuccess: (read) =>
            commitRefresh(
              instance,
              attemptedAt,
              normalizePoll(instance.driverKind, read.payload),
              read.account,
            ),
        }),
        Effect.ensuring(
          stateLock.withPermits(1)(Effect.sync(() => void inFlight.delete(instance))),
        ),
      );
    });

    const refreshStale = refreshLock.withPermits(1)(
      Effect.gen(function* () {
        yield* ensureLoaded;
        const nowMs = yield* Clock.currentTimeMillis;
        const eligible = yield* listEligibleInstances;
        yield* reconcileInstances(eligible);

        yield* Effect.forEach(
          eligible,
          (instance) => {
            const claimedKey = claimedSubscriptions.get(String(instance.instanceId));
            const previous = claimedKey === undefined ? undefined : snapshots.get(claimedKey);
            const attemptedAtMs = previous ? lastAttemptMillis(previous) : null;
            const elapsed =
              attemptedAtMs === null ? Number.POSITIVE_INFINITY : nowMs - attemptedAtMs;
            if (elapsed >= 0 && elapsed < freshnessTtlMs) return Effect.void;
            return refreshInstance(instance, nowMs);
          },
          { concurrency: 2 },
        ).pipe(Effect.asVoid);
      }),
    );

    const ingest = Effect.fn("AccountLimitsService.ingest")(function* (
      event: AccountLimitsIngestInput,
    ) {
      yield* ensureLoaded;
      yield* stateLock.withPermits(1)(
        Effect.gen(function* () {
          const instanceId = String(event.providerInstanceId);
          const claimedKey = claimedSubscriptions.get(instanceId);
          const fallbackSubscription = unfoldableInstanceSubscription({
            instanceId,
            label: knownInstances.get(instanceId)?.displayName,
          });
          const key = claimedKey ?? fallbackSubscription.key;
          const previous = snapshots.get(key);
          if (
            previous?.observation &&
            Date.parse(previous.observation.observedAt) > Date.parse(event.createdAt)
          ) {
            return;
          }

          const reading = eventReading(event, previous);
          if (reading === null) return;

          snapshots.set(key, {
            subscription: previous?.subscription ?? fallbackSubscription,
            reader: { providerInstanceId: event.providerInstanceId, driver: event.driver },
            observation: {
              plan: reading.plan ?? previous?.observation?.plan ?? null,
              windows:
                event.driver === "codex"
                  ? mergeWindows(previous?.observation?.windows ?? [], reading.windows)
                  : reading.windows,
              observedAt: event.createdAt,
              source: "event",
            },
            lastAttempt: { attemptedAt: event.createdAt, status: "succeeded", error: null },
          });
          claimedSubscriptions.set(instanceId, key);
          yield* persist().pipe(Effect.catchCause(() => Effect.void));
        }),
      );
    });

    const readSummary = Effect.fn("AccountLimitsService.readSummary")(function* () {
      yield* ensureLoaded;
      const nowMs = yield* Clock.currentTimeMillis;
      const eligible = yield* listEligibleInstances;
      const activeInstances = new Map(
        eligible.map((instance) => [String(instance.instanceId), instance]),
      );
      return {
        contractVersion: ACCOUNT_LIMITS_CONTRACT_VERSION,
        readAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
        snapshots: [...snapshots.values()]
          .filter((snapshot) => {
            // A directly polled subscription has no instance behind it.
            if (snapshot.reader === undefined) return true;
            const liveInstance = (instanceId: string) => {
              const current = activeInstances.get(instanceId);
              if (current === undefined) return false;
              const known = knownInstances.get(instanceId);
              return known === undefined || known === current;
            };
            // Two kinds of evidence, and both are needed. `reader` is the only
            // one an instance whose every read failed ever produces, since a
            // claim is moved by success alone. The claims are the only one that
            // survives the last writer of a shared subscription being removed.
            if (
              liveInstance(String(snapshot.reader.providerInstanceId)) &&
              activeInstances.get(String(snapshot.reader.providerInstanceId))?.driverKind ===
                snapshot.reader.driver
            ) {
              return true;
            }
            for (const [instanceId, claimedKey] of claimedSubscriptions) {
              if (claimedKey === snapshot.subscription.key && liveInstance(instanceId)) return true;
            }
            return false;
          })
          .sort((left, right) => left.subscription.key.localeCompare(right.subscription.key)),
      } satisfies AccountLimitsSummary;
    });

    const scheduledRefresh = Effect.forever(
      refreshStale.pipe(Effect.andThen(Effect.sleep(refreshInterval))),
    );
    const registryRefresh = input.registryChanges
      ? Effect.forever(PubSub.take(input.registryChanges).pipe(Effect.andThen(refreshStale)))
      : Effect.never;
    const run = Effect.raceFirst(scheduledRefresh, registryRefresh);
    return { readSummary, ingest, refreshStale, run } satisfies AccountLimitsServiceShape;
  });
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const registry = yield* ProviderInstanceRegistry;
  const path = yield* Path.Path;
  const registryChanges = yield* registry.subscribeChanges;
  return yield* makeAccountLimitsService({
    cachePath: path.join(config.stateDir, "account-limits.json"),
    listInstances: registry.listInstances,
    registryChanges,
  });
});

export const layer = Layer.effect(
  AccountLimitsService,
  Effect.gen(function* () {
    const service = yield* make;
    yield* service.run.pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);
    return service;
  }),
);
