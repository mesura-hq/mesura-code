import type { HostStatsBucket, HostStatsSample } from "@t3tools/contracts";
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

export interface HostStatsServiceShape {
  /** The most recent sample, or null before the first one. */
  readonly latest: Effect.Effect<HostStatsSample | null>;
  /** Every bucket held, oldest first. */
  readonly buckets: Effect.Effect<ReadonlyArray<HostStatsBucket>>;
  readonly subscribe: Effect.Effect<
    SnapshotSubscription<HostStatsSample | null>,
    never,
    Scope.Scope
  >;
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
  const changes = yield* PubSub.sliding<HostStatsSample | null>(8);

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
        yield* Ref.set(state, {
          buckets: foldSample(previous.buckets, sample, sample.sampledAt, WINDOW_MS),
          latest: sample,
          unsaved: true,
        });
        yield* PubSub.publish(changes, sample);
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

  return {
    latest,
    buckets: Ref.get(state).pipe(Effect.map((current) => current.buckets.map(toWireBucket))),
    subscribe: subscribeBeforeSnapshot(changes, latest, mutex),
    sampleOnce,
    run,
  } satisfies HostStatsServiceShape;
});

export const layer = Layer.effect(
  HostStatsService,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const collector = yield* HostStatsCollector;
    const path = yield* Path.Path;
    const service = yield* makeHostStatsService({
      historyPath: path.join(config.stateDir, HOST_STATS_HISTORY_FILE_NAME),
      readSample: collector.read,
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
