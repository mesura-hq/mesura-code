/** Resident, per-provider-instance account-limit authority. */
import {
  ACCOUNT_LIMITS_CONTRACT_VERSION,
  accountLimitsWindowKey,
  AccountLimitsSnapshot,
  type AccountLimitsFailureReason,
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
import { HttpClient } from "effect/unstable/http";

import * as SubscriptionRegistry from "./SubscriptionRegistry.ts";
import {
  makeSubscriptionHttpGet,
  readOpenCodeGoUsage,
  readZaiUsage,
  type SubscriptionReadError,
} from "./subscriptionReaders.ts";
import {
  normalizeClaudeAccountLimits,
  normalizeClaudeRateLimitEvent,
  normalizeCodexAccountLimits,
  type NormalizedAccountLimits,
} from "./accountLimitsNormalize.ts";

const DEFAULT_REFRESH_INTERVAL = Duration.minutes(1);
const DEFAULT_FRESHNESS_TTL = Duration.minutes(5);
/**
 * The service's own bound on a subscription read.
 *
 * Deliberately longer than the vendor readers' own timeout: this is the
 * backstop for a reader that does not honour one, not the primary limit.
 */
const DEFAULT_SUBSCRIPTION_READ_TIMEOUT = Duration.seconds(30);
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

/**
 * A subscription this environment polls itself, with no agent involved.
 *
 * `read` is already bound to its credential by the caller, so the credential
 * never reaches this service — it authenticates a request and nothing more.
 */
export interface PolledSubscription {
  readonly key: string;
  readonly subscription: AccountLimitsAccount;
  readonly read: (nowMs: number) => Effect.Effect<NormalizedAccountLimits, SubscriptionReadError>;
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
function instanceSubscription(instance: ProviderInstance, ordinal = 0): AccountLimitsAccount {
  return unfoldableInstanceSubscription({
    instanceId: String(instance.instanceId),
    label: instance.displayName,
    ordinal,
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
  readonly listSubscriptions?: Effect.Effect<ReadonlyArray<PolledSubscription>>;
  readonly refreshInterval?: Duration.Input;
  readonly freshnessTtl?: Duration.Input;
  readonly registryChanges?: PubSub.Subscription<void>;
  readonly subscriptionChanges?: PubSub.Subscription<void>;
  readonly subscriptionReadTimeout?: Duration.Input;
}): Effect.Effect<AccountLimitsServiceShape, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const snapshots = new Map<string, AccountLimitsSnapshot>();
    const inFlight = new Set<ProviderInstance>();
    const knownInstances = new Map<string, ProviderInstance>();
    /**
     * Which subscriptions each instance last reported, by instance id.
     *
     * A set rather than one key, because a reader can see several: an OpenCode
     * instance drives every plan it is logged into.
     *
     * A failed read does not name a subscription, so this is how the failure is
     * attributed to the right ones. It is also what pruning reads: a snapshot no
     * live instance claims is orphaned, and a failed read leaves the claims
     * standing precisely so one blip cannot delete a row.
     */
    const claimedSubscriptions = new Map<string, ReadonlySet<string>>();
    const stateLock = yield* Semaphore.make(1);
    const refreshLock = yield* Semaphore.make(1);
    const refreshInterval = Duration.fromInputUnsafe(
      input.refreshInterval ?? DEFAULT_REFRESH_INTERVAL,
    );
    const subscriptionReadTimeout = Duration.fromInputUnsafe(
      input.subscriptionReadTimeout ?? DEFAULT_SUBSCRIPTION_READ_TIMEOUT,
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
                const instanceId = String(reader.providerInstanceId);
                claimedSubscriptions.set(
                  instanceId,
                  new Set([
                    ...(claimedSubscriptions.get(instanceId) ?? []),
                    snapshot.subscription.key,
                  ]),
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
          for (const [key, snapshot] of snapshots) {
            if (snapshot.reader === undefined || isClaimed(key)) continue;
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
        if (claimed.has(subscriptionKey)) return true;
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

    /**
     * Commit every reading one instance produced, plus the claim bookkeeping.
     *
     * `readings` is null when the read itself failed, which names no
     * subscription at all — the failure is then attributed to whichever
     * subscriptions this instance last reported.
     */
    const commitRefresh = Effect.fn("AccountLimitsService.commitRefresh")(function* (
      instance: ProviderInstance,
      attemptedAt: string,
      readings: ReadonlyArray<{
        readonly subscription: AccountLimitsAccount;
        readonly normalized: NormalizedAccountLimits | null;
      }> | null,
    ) {
      if (!(yield* isCurrentInstance(instance))) return;
      yield* stateLock.withPermits(1)(
        Effect.gen(function* () {
          const instanceId = String(instance.instanceId);
          if (knownInstances.get(instanceId) !== instance) return;
          const previousClaims = claimedSubscriptions.get(instanceId) ?? new Set<string>();

          const effective =
            readings ??
            // A failed read: mark every subscription this instance was reading,
            // or its own unfoldable one when it has never reported any.
            (previousClaims.size === 0
              ? [{ subscription: instanceSubscription(instance), normalized: null }]
              : [...previousClaims].map((key) => ({
                  subscription: snapshots.get(key)?.subscription ?? {
                    key,
                    label: key,
                  },
                  normalized: null,
                })));

          for (const reading of effective) {
            const key = reading.subscription.key;
            const previous = snapshots.get(key);
            if (previous && hasNewerAttempt(previous, attemptedAt)) continue;
            const stamped =
              reading.normalized === null
                ? []
                : stampWindows(reading.normalized.windows, attemptedAt);
            snapshots.set(
              key,
              reading.normalized === null
                ? {
                    subscription: previous?.subscription ?? reading.subscription,
                    reader: {
                      providerInstanceId: instance.instanceId,
                      driver: instance.driverKind,
                    },
                    observation: previous?.observation ?? null,
                    lastAttempt: {
                      attemptedAt,
                      status: "failed",
                      error: boundedFailure(),
                      reason: "unknown",
                    },
                  }
                : {
                    subscription: reading.subscription,
                    reader: {
                      providerInstanceId: instance.instanceId,
                      driver: instance.driverKind,
                    },
                    observation: {
                      plan: reading.normalized.plan ?? previous?.observation?.plan ?? null,
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
          }

          // Only a successful read moves the claims. A failed one leaves them
          // standing, which is what stops one blip pruning a subscription.
          if (readings !== null) {
            const nextClaims = new Set(readings.map((reading) => reading.subscription.key));
            claimedSubscriptions.set(instanceId, nextClaims);
            // Drop a subscription this instance stopped reporting, but only
            // when no other instance still reads it — a shared subscription
            // belongs to every reader, and this one's omission is not theirs.
            for (const key of previousClaims) {
              if (!nextClaims.has(key) && !isClaimed(key)) snapshots.delete(key);
            }
          }
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
          onSuccess: (reads) =>
            commitRefresh(
              instance,
              attemptedAt,
              reads.map((read, ordinal) => ({
                // The ordinal only matters for a reader that reports several
                // subscriptions and names none of them; without it they would
                // all key alike and each would overwrite the last.
                subscription: read.account ?? instanceSubscription(instance, ordinal),
                normalized: normalizePoll(instance.driverKind, read.payload),
              })),
            ),
        }),
        Effect.ensuring(
          stateLock.withPermits(1)(Effect.sync(() => void inFlight.delete(instance))),
        ),
      );
    });

    /**
     * Drop a snapshot for a subscription the registry no longer holds.
     *
     * Only a reader-less snapshot is considered here: one that came through an
     * agent is the instance reconciler's to prune, and treating it as orphaned
     * would delete a live row.
     */
    const reconcileSubscriptions = Effect.fn("AccountLimitsService.reconcileSubscriptions")(
      function* (subscriptions: ReadonlyArray<PolledSubscription>) {
        yield* stateLock.withPermits(1)(
          Effect.gen(function* () {
            const configured = new Set(subscriptions.map((subscription) => subscription.key));
            let changed = false;
            for (const [key, snapshot] of snapshots) {
              if (snapshot.reader !== undefined || configured.has(key)) continue;
              snapshots.delete(key);
              changed = true;
            }
            if (changed) yield* persist().pipe(Effect.catchCause(() => Effect.void));
          }),
        );
      },
    );

    const listPolledSubscriptions =
      input.listSubscriptions ?? Effect.succeed([] as ReadonlyArray<PolledSubscription>);

    /**
     * Commit one directly polled subscription's reading.
     *
     * The snapshot carries no reader: nothing read it through an agent, and
     * inventing one would make it prunable by an instance that never existed.
     */
    const commitSubscription = Effect.fn("AccountLimitsService.commitSubscription")(function* (
      subscription: PolledSubscription,
      attemptedAt: string,
      result: NormalizedAccountLimits | { readonly reason: AccountLimitsFailureReason },
    ) {
      yield* stateLock.withPermits(1)(
        Effect.gen(function* () {
          const key = subscription.key;
          const previous = snapshots.get(key);
          if (previous && hasNewerAttempt(previous, attemptedAt)) return;
          const failed = "reason" in result;
          snapshots.set(
            key,
            failed
              ? {
                  subscription: previous?.subscription ?? subscription.subscription,
                  // A failed read keeps the numbers the last good one gave.
                  observation: previous?.observation ?? null,
                  lastAttempt: {
                    attemptedAt,
                    status: "failed",
                    error: boundedFailure(),
                    reason: result.reason,
                  },
                }
              : {
                  subscription: subscription.subscription,
                  observation: {
                    plan: result.plan ?? previous?.observation?.plan ?? null,
                    windows: stampWindows(result.windows, attemptedAt),
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

    const refreshSubscription = Effect.fn("AccountLimitsService.refreshSubscription")(function* (
      subscription: PolledSubscription,
      nowMs: number,
    ) {
      // No in-flight guard here, unlike the instance path, and that is safe
      // rather than an oversight: `refreshLock` makes `refreshStale`
      // single-flight, and the registry lists each subscription once, so this
      // never starts a poll that is already running. Calling it from anywhere
      // else, or letting `listSubscriptions` repeat a key, would end that and
      // needs a guard added with it — these reads hit real vendor endpoints.
      const attemptedAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
      // A second bound, over the one the vendor readers already carry.
      //
      // `read` is an interface, and a reader that ignores its own timeout would
      // otherwise never let this refresh finish — which holds `refreshLock` and
      // stops every later tick, so one unbounded subscription wedges the whole
      // loop rather than only its own row. That was observed, not imagined.
      yield* subscription.read(nowMs).pipe(
        Effect.timeout(subscriptionReadTimeout),
        Effect.matchEffect({
          onFailure: (error) =>
            commitSubscription(
              subscription,
              attemptedAt,
              // Narrow on the tag, not on a field that TimeoutException happens
              // to lack: a later member of this union would otherwise be
              // misclassified silently instead of failing to compile.
              error._tag === "SubscriptionReadError" ? error : { reason: "unreachable" as const },
            ),
          onSuccess: (normalized) => commitSubscription(subscription, attemptedAt, normalized),
        }),
      );
    });

    const refreshStale = refreshLock.withPermits(1)(
      Effect.gen(function* () {
        yield* ensureLoaded;
        const nowMs = yield* Clock.currentTimeMillis;
        const eligible = yield* listEligibleInstances;
        const subscriptions = yield* listPolledSubscriptions;
        yield* reconcileInstances(eligible);
        yield* reconcileSubscriptions(subscriptions);

        const instancePass = Effect.forEach(
          eligible,
          (instance) => {
            // An instance is due when its oldest reading is due. Reading one
            // subscription and not another would leave half a reader stale.
            const claims = claimedSubscriptions.get(String(instance.instanceId));
            let oldestAttemptMs: number | null = null;
            let anyUndated = claims === undefined || claims.size === 0;
            for (const key of claims ?? []) {
              const attemptedAtMs = lastAttemptMillis(snapshots.get(key)!);
              // An unreadable date is maximally stale, not absent. Skipping it
              // would let a sibling's recent reading mask it forever.
              if (attemptedAtMs === null) {
                anyUndated = true;
                continue;
              }
              if (oldestAttemptMs === null || attemptedAtMs < oldestAttemptMs) {
                oldestAttemptMs = attemptedAtMs;
              }
            }
            const elapsed =
              anyUndated || oldestAttemptMs === null
                ? Number.POSITIVE_INFINITY
                : nowMs - oldestAttemptMs;
            if (elapsed >= 0 && elapsed < freshnessTtlMs) return Effect.void;
            return refreshInstance(instance, nowMs);
          },
          { concurrency: 2 },
        );

        const subscriptionPass = Effect.forEach(
          subscriptions,
          (subscription) => {
            const previous = snapshots.get(subscription.key);
            const attemptedAtMs = previous ? lastAttemptMillis(previous) : null;
            const elapsed =
              attemptedAtMs === null ? Number.POSITIVE_INFINITY : nowMs - attemptedAtMs;
            if (elapsed >= 0 && elapsed < freshnessTtlMs) return Effect.void;
            return refreshSubscription(subscription, nowMs);
          },
          { concurrency: 2 },
        );

        // Run both passes together. A network reader must not sit in front of a
        // local one: they answer on completely different timescales.
        yield* Effect.all([instancePass, subscriptionPass], { concurrency: 2 }).pipe(Effect.asVoid);
      }),
    );

    const ingest = Effect.fn("AccountLimitsService.ingest")(function* (
      event: AccountLimitsIngestInput,
    ) {
      yield* ensureLoaded;
      yield* stateLock.withPermits(1)(
        Effect.gen(function* () {
          const instanceId = String(event.providerInstanceId);
          const claims = claimedSubscriptions.get(instanceId);
          const fallbackSubscription = unfoldableInstanceSubscription({
            instanceId,
            label: knownInstances.get(instanceId)?.displayName,
          });
          // An event names one instance, not one subscription, so it can only
          // be applied where that instance reads exactly one. A reader with
          // several — OpenCode, once it lands — falls through to its own
          // unfoldable key here, which is wrong but visible rather than
          // silently filed under one of its real subscriptions. Wiring such a
          // driver to `ingest` needs the event to name the subscription first.
          const claimedKey = claims?.size === 1 ? [...claims][0] : undefined;
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
          claimedSubscriptions.set(instanceId, new Set([...(claims ?? []), key]));
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
            for (const [instanceId, claimedKeys] of claimedSubscriptions) {
              if (claimedKeys.has(snapshot.subscription.key) && liveInstance(instanceId)) {
                return true;
              }
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
    // Adding or removing a subscription refreshes at once rather than waiting
    // out the tick, the same way a provider instance change does.
    const subscriptionRefresh = input.subscriptionChanges
      ? Effect.forever(PubSub.take(input.subscriptionChanges).pipe(Effect.andThen(refreshStale)))
      : Effect.never;
    const run = Effect.raceFirst(
      scheduledRefresh,
      Effect.raceFirst(registryRefresh, subscriptionRefresh),
    );
    return { readSummary, ingest, refreshStale, run } satisfies AccountLimitsServiceShape;
  });
}

/**
 * Bind each configured subscription to the reader that meters it.
 *
 * The credential is fetched here and closed over, so it reaches the request and
 * nothing else — the service never holds one, and a subscription whose
 * credential has gone is simply not polled rather than polled with nothing.
 */
const listSubscriptionsFrom = (
  subscriptions: SubscriptionRegistry.SubscriptionRegistryShape,
  httpClient: HttpClient.HttpClient,
) =>
  Effect.gen(function* () {
    const get = makeSubscriptionHttpGet(httpClient);
    const records = yield* subscriptions.list;
    const polled: PolledSubscription[] = [];
    for (const record of records) {
      const credential = yield* subscriptions.credential(record);
      if (credential === null) continue;
      const read =
        record.namespace === "opencode-go"
          ? (nowMs: number) => readOpenCodeGoUsage({ credential, get, nowMs })
          : record.namespace === "zai"
            ? (nowMs: number) => readZaiUsage({ credential, get, nowMs })
            : null;
      if (read === null) continue;
      polled.push({
        key: record.key,
        subscription: { key: record.key, label: record.label },
        read,
      });
    }
    return polled as ReadonlyArray<PolledSubscription>;
  });

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const registry = yield* ProviderInstanceRegistry;
  const subscriptions = yield* SubscriptionRegistry.SubscriptionRegistry;
  const httpClient = yield* HttpClient.HttpClient;
  const path = yield* Path.Path;
  const registryChanges = yield* registry.subscribeChanges;
  const subscriptionChanges = yield* subscriptions.subscribeChanges;
  return yield* makeAccountLimitsService({
    cachePath: path.join(config.stateDir, "account-limits.json"),
    listInstances: registry.listInstances,
    listSubscriptions: listSubscriptionsFrom(subscriptions, httpClient),
    registryChanges,
    subscriptionChanges,
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
