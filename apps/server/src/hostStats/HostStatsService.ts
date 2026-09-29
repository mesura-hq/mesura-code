import type {
  HostStatsBucket,
  HostStatsMessage,
  HostStatsMesuraServers,
  HostStatsSample,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import { forkParked } from "../serverActivation.ts";
import {
  subscribeBeforeSnapshot,
  type SnapshotSubscription,
} from "../utils/subscribeBeforeSnapshot.ts";
import { HostStatsCollector, MAX_RATE_GAP_MS } from "./HostStatsCollector.ts";
import {
  bucketStartFor,
  BUCKET_MS,
  foldSample,
  HostStatsHistoryBucket,
  SAMPLE_INTERVAL_MS,
  toHistoryBucket,
  toWireBucket,
  validateLoadedBuckets,
  WINDOW_MS,
} from "./hostStatsBuckets.ts";
import { HostAgentCounts, type HostAgentCountsReading } from "./HostAgentCounts.ts";
import { makeSampleMessage, makeSnapshotMessage, readHostFacts } from "./hostStatsWire.ts";
import { MesuraServerDiscovery } from "./mesuraServerDiscovery.ts";

export interface HostStatsServiceShape {
  /** The most recent sample, or null before the first one. */
  readonly latest: Effect.Effect<HostStatsSample | null>;
  /** Every bucket held, oldest first. */
  readonly buckets: Effect.Effect<ReadonlyArray<HostStatsBucket>>;
  /**
   * What `subscribeHostStats` streams: a snapshot of everything held, then one
   * message per sample. Every subscriber shares the one sampling loop.
   */
  readonly subscribe: Effect.Effect<SnapshotSubscription<HostStatsMessage>, never, Scope.Scope>;
  /** One loop iteration: read, fold, persist a closed bucket, publish. */
  readonly sampleOnce: Effect.Effect<void>;
  /** Samples at once, then every 60 seconds; a failed iteration is logged and skipped. */
  readonly run: Effect.Effect<never>;
}

/** Samples the server's own host every minute and keeps 12 hours of 5-minute buckets. */
export class HostStatsService extends Context.Service<HostStatsService, HostStatsServiceShape>()(
  "t3/hostStats/HostStatsService",
) {}

export const HOST_STATS_HISTORY_FILE_NAME = "host-stats-history.json";
const HOST_STATS_HISTORY_VERSION = 1 as const;

/**
 * Server-private. A bucket without a tally still decodes, so a hand-written
 * file keeps its history; its averages are then taken over `sampleCount`.
 */
const HistoryFile = Schema.Struct({
  version: Schema.Literal(HOST_STATS_HISTORY_VERSION),
  buckets: Schema.Array(
    Schema.Struct({
      ...HostStatsHistoryBucket.fields,
      tally: Schema.optionalKey(HostStatsHistoryBucket.fields.tally),
    }),
  ),
});
const HistoryFileJson = Schema.fromJsonString(
  HistoryFile as unknown as Schema.Codec<typeof HistoryFile.Type>,
);
const decodeHistoryFile = Schema.decodeUnknownEffect(HistoryFileJson);
const encodeHistoryFile = Schema.encodeEffect(HistoryFileJson);

export interface MakeHostStatsServiceInput {
  readonly historyPath: string;
  readonly readSample: Effect.Effect<HostStatsSample>;
}

/**
 * Rates span two readings, so across a gap (suspend, `SIGSTOP`, a clock jump)
 * they describe no single moment. The collector drops them on its own gaps;
 * the service drops them on the gaps it sees between the samples it folds.
 */
function dropRatesAcrossGap(sample: HostStatsSample, lastSampledAt: number | null) {
  if (lastSampledAt === null) return sample;
  const elapsedMs = sample.sampledAt - lastSampledAt;
  if (elapsedMs > 0 && elapsedMs <= MAX_RATE_GAP_MS) return sample;
  return { ...sample, cpuPercent: null, netRxBytesPerSec: null, netTxBytesPerSec: null };
}

interface HostStatsState {
  readonly buckets: ReadonlyArray<HostStatsHistoryBucket>;
  readonly latest: HostStatsSample | null;
  /** Folded since the last write, so shutdown has something to save. */
  readonly unsaved: boolean;
}

export const makeHostStatsService = Effect.fn("makeHostStatsService")(function* (
  input: MakeHostStatsServiceInput,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const loadedAt = yield* Clock.currentTimeMillis;

  const emptyHistory: ReadonlyArray<HostStatsHistoryBucket> = [];
  const historyExists = yield* fileSystem
    .exists(input.historyPath)
    .pipe(Effect.orElseSucceed(() => true));
  // A fresh state directory has no history yet: one short warning, no stack.
  const loaded = !historyExists
    ? yield* Effect.logWarning("hostStats.history.missing-starting-empty", {
        historyPath: input.historyPath,
      }).pipe(Effect.as(emptyHistory))
    : yield* fileSystem.readFileString(input.historyPath).pipe(
        Effect.flatMap(decodeHistoryFile),
        Effect.map((file) => validateLoadedBuckets(file.buckets.map(toHistoryBucket), loadedAt)),
        Effect.catchCause((cause) =>
          Effect.logWarning("hostStats.history.unreadable-starting-empty", {
            historyPath: input.historyPath,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(emptyHistory)),
        ),
      );

  const state = yield* Ref.make<HostStatsState>({ buckets: loaded, latest: null, unsaved: false });
  const mutex = yield* Semaphore.make(1);
  const changes = yield* PubSub.sliding<HostStatsMessage>(8);
  // Read once: the facts do not change while the server runs, and a boot time
  // derived from uptime on every snapshot would drift by the time between reads.
  const host = yield* readHostFacts(loadedAt);

  const persist = Effect.gen(function* () {
    const { buckets } = yield* Ref.get(state);
    const serialized = yield* encodeHistoryFile({
      version: HOST_STATS_HISTORY_VERSION,
      buckets,
    }).pipe(Effect.orDie);
    yield* writeFileStringAtomically({ filePath: input.historyPath, contents: serialized }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    yield* Ref.update(state, (current) => ({ ...current, unsaved: false }));
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("hostStats.history.write-failed", {
        historyPath: input.historyPath,
        cause: Cause.pretty(cause),
      }),
    ),
  );

  yield* Effect.addFinalizer(() =>
    Ref.get(state).pipe(Effect.flatMap(({ unsaved }) => (unsaved ? persist : Effect.void))),
  );

  const sampleOnce = Effect.gen(function* () {
    const read = yield* input.readSample;
    const bucketClosed = yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        const previous = yield* Ref.get(state);
        const sample = dropRatesAcrossGap(read, previous.latest?.sampledAt ?? null);
        const buckets = foldSample(previous.buckets, sample, sample.sampledAt, WINDOW_MS);
        yield* Ref.set(state, { buckets, latest: sample, unsaved: true });
        const start = bucketStartFor(sample.sampledAt, BUCKET_MS);
        const bucket = buckets.find((held) => held.start === start);
        // A sample older than the window folds into no bucket held; clients get the sample alone.
        if (bucket !== undefined) {
          const serverNow = yield* Clock.currentTimeMillis;
          yield* PubSub.publish(
            changes,
            makeSampleMessage(serverNow, sample, toWireBucket(bucket)),
          );
        }
        // Closure follows the previous sample's bucket, not the newest bucket held:
        // a loaded bucket one interval ahead (the clock moved back) stays newest
        // while the current bucket closes beneath it.
        return (
          previous.latest !== null &&
          bucketStartFor(previous.latest.sampledAt, BUCKET_MS) !==
            bucketStartFor(sample.sampledAt, BUCKET_MS)
        );
      }),
    );
    if (bucketClosed) yield* persist;
  }).pipe(Effect.withSpan("HostStatsService.sampleOnce"));

  const run = Effect.forever(
    sampleOnce.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("hostStats.sample.failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.andThen(Effect.sleep(Duration.millis(SAMPLE_INTERVAL_MS))),
    ),
  );

  const latest = Ref.get(state).pipe(Effect.map((current) => current.latest));
  const buckets = Ref.get(state).pipe(Effect.map((current) => current.buckets.map(toWireBucket)));

  const snapshot: Effect.Effect<HostStatsMessage> = Effect.gen(function* () {
    const serverNow = yield* Clock.currentTimeMillis;
    const current = yield* Ref.get(state);
    return makeSnapshotMessage({
      serverNow,
      host,
      buckets: current.buckets.map(toWireBucket),
      latest: current.latest,
    });
  });

  return {
    latest,
    buckets,
    subscribe: subscribeBeforeSnapshot(changes, snapshot, mutex),
    sampleOnce,
    run,
  } satisfies HostStatsServiceShape;
});

/**
 * One sample of this host: the collector reads the machine, this server's
 * projection counts its agents, and `/proc` counts the Mesura Code servers.
 * A failed count nulls only its own fields; a null never means zero.
 */
export const readHostSample = (input: {
  readonly collect: Effect.Effect<HostStatsSample>;
  readonly agentCounts: Effect.Effect<HostAgentCountsReading, ProjectionRepositoryError>;
  readonly mesuraServers: Effect.Effect<HostStatsMesuraServers | null>;
}): Effect.Effect<HostStatsSample> =>
  Effect.all(
    [
      input.collect,
      input.agentCounts.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("hostStats.agentCounts.failed", { cause: Cause.pretty(cause) }).pipe(
            Effect.as(null),
          ),
        ),
      ),
      input.mesuraServers,
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(([sample, counts, mesuraServers]) => ({
      ...sample,
      agentsRunning: counts?.agentsRunning ?? null,
      agentSessionsOpen: counts?.agentSessionsOpen ?? null,
      mesuraServers,
    })),
  );

export const layer = Layer.effect(
  HostStatsService,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const collector = yield* HostStatsCollector;
    const agentCounts = yield* HostAgentCounts;
    const discovery = yield* MesuraServerDiscovery;
    const path = yield* Path.Path;
    const service = yield* makeHostStatsService({
      historyPath: path.join(config.stateDir, HOST_STATS_HISTORY_FILE_NAME),
      readSample: readHostSample({
        collect: collector.read,
        agentCounts: agentCounts.read,
        mesuraServers: discovery.discover,
      }),
    });
    // Parked until activation, so a self-update trial never samples.
    yield* forkParked(
      Effect.logInfo("hostStats.sampler.started", { intervalMs: SAMPLE_INTERVAL_MS }).pipe(
        Effect.andThen(service.run),
      ),
    );
    return HostStatsService.of(service);
  }),
);
