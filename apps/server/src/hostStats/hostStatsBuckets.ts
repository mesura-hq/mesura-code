import { HostStatsBucket, type HostStatsSample } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const SAMPLE_INTERVAL_MS = 60_000;
export const BUCKET_MS = 300_000;
export const WINDOW_MS = 12 * 3_600_000;

/** How each averaged bucket field reads its value from one sample. */
const AVERAGED_METRICS = {
  cpuAvg: (sample) => sample.cpuPercent,
  memUsedAvg: (sample) => sample.memUsedBytes,
  swapUsedAvg: (sample) => sample.swapUsedBytes,
  diskUsedAvg: (sample) => sample.diskUsedBytes,
  gpuBusyAvg: busiestGpuPercent,
  netRxAvg: (sample) => sample.netRxBytesPerSec,
  netTxAvg: (sample) => sample.netTxBytesPerSec,
} satisfies Record<string, (sample: HostStatsSample) => number | null>;

/** How each maximum bucket field reads its value from one sample. */
const MAXIMUM_METRICS = {
  cpuMax: (sample) => sample.cpuPercent,
  gpuBusyMax: busiestGpuPercent,
  cpuTempMax: (sample) => sample.cpuTemperatureC,
  agentsRunningMax: (sample) => sample.agentsRunning,
} satisfies Record<string, (sample: HostStatsSample) => number | null>;

type AveragedField = keyof typeof AVERAGED_METRICS;
type MaximumField = keyof typeof MAXIMUM_METRICS;
const AVERAGED_FIELDS = Object.keys(AVERAGED_METRICS) as ReadonlyArray<AveragedField>;
const MAXIMUM_FIELDS = Object.keys(MAXIMUM_METRICS) as ReadonlyArray<MaximumField>;

const MetricTally = Schema.Struct({
  sum: Schema.Finite,
  count: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});
type MetricTally = typeof MetricTally.Type;

/** The non-null sum and count behind each average, so an average stays exact across folds. */
const BucketTally = Schema.Struct(
  Object.fromEntries(AVERAGED_FIELDS.map((field) => [field, MetricTally])) as Record<
    AveragedField,
    typeof MetricTally
  >,
);
type BucketTally = typeof BucketTally.Type;

/**
 * A bucket as the server holds and persists it: the wire bucket plus its tally.
 * The tally is server-private; `toWireBucket` strips it before a bucket leaves.
 */
export const HostStatsHistoryBucket = Schema.Struct({
  ...HostStatsBucket.fields,
  tally: BucketTally,
});
export type HostStatsHistoryBucket = typeof HostStatsHistoryBucket.Type;

/**
 * The busiest measured GPU of a sample. A GPU that is sleeping or has no busy
 * reading contributes nothing; a sample without one yields null.
 */
function busiestGpuPercent(sample: HostStatsSample): number | null {
  let busiest: number | null = null;
  for (const gpu of sample.gpus ?? []) {
    if (gpu.state !== "active" || gpu.busyPercent === null) continue;
    busiest = busiest === null ? gpu.busyPercent : Math.max(busiest, gpu.busyPercent);
  }
  return busiest;
}

export function bucketStartFor(sampledAt: number, bucketMs: number): number {
  return Math.floor(sampledAt / bucketMs) * bucketMs;
}

/**
 * The tally of a bucket that has none (a hand-written history file): each
 * average is taken over every sample the bucket counts.
 */
function derivedTally(bucket: HostStatsBucket): BucketTally {
  return Object.fromEntries(
    AVERAGED_FIELDS.map((field) => {
      const average = bucket[field];
      return [
        field,
        average === null
          ? { sum: 0, count: 0 }
          : { sum: average * bucket.sampleCount, count: bucket.sampleCount },
      ];
    }),
  ) as BucketTally;
}

export function toHistoryBucket(bucket: HostStatsBucket): HostStatsHistoryBucket {
  return "tally" in bucket
    ? (bucket as HostStatsHistoryBucket)
    : { ...bucket, tally: derivedTally(bucket) };
}

export function toWireBucket(bucket: HostStatsBucket): HostStatsBucket {
  const { tally: _tally, ...wire } = toHistoryBucket(bucket);
  return wire;
}

const averageOf = (tally: MetricTally) => (tally.count === 0 ? null : tally.sum / tally.count);

const maximumOf = (current: number | null, value: number | null) =>
  value === null ? current : current === null ? value : Math.max(current, value);

function addSample(
  bucket: HostStatsHistoryBucket | null,
  start: number,
  sample: HostStatsSample,
): HostStatsHistoryBucket {
  const averages = {} as Record<AveragedField, number | null>;
  const tally = {} as Record<AveragedField, MetricTally>;
  for (const field of AVERAGED_FIELDS) {
    const previous = bucket?.tally[field] ?? { sum: 0, count: 0 };
    const value = AVERAGED_METRICS[field](sample);
    tally[field] =
      value === null ? previous : { sum: previous.sum + value, count: previous.count + 1 };
    averages[field] = averageOf(tally[field]);
  }
  const maxima = {} as Record<MaximumField, number | null>;
  for (const field of MAXIMUM_FIELDS) {
    maxima[field] = maximumOf(bucket?.[field] ?? null, MAXIMUM_METRICS[field](sample));
  }
  return {
    start,
    sampleCount: (bucket?.sampleCount ?? 0) + 1,
    ...averages,
    ...maxima,
    tally,
  };
}

/** Keeps the buckets that start inside the window ending at `now`: at most `windowMs / BUCKET_MS`. */
export function trimBuckets<Bucket extends HostStatsBucket>(
  buckets: ReadonlyArray<Bucket>,
  now: number,
  windowMs: number,
): ReadonlyArray<Bucket> {
  return buckets.filter((bucket) => bucket.start > now - windowMs);
}

/**
 * Folds one sample into its bucket, then trims. Only a sample creates a
 * bucket, so time without samples (a suspend, a clock jump) leaves a gap.
 */
export function foldSample(
  buckets: ReadonlyArray<HostStatsBucket>,
  sample: HostStatsSample,
  now: number,
  windowMs: number,
): ReadonlyArray<HostStatsHistoryBucket> {
  const start = bucketStartFor(sample.sampledAt, BUCKET_MS);
  const held = buckets.map(toHistoryBucket);
  const index = held.findIndex((bucket) => bucket.start === start);
  const folded = addSample(index === -1 ? null : held[index]!, start, sample);
  const next =
    index === -1
      ? [...held, folded].toSorted((left, right) => left.start - right.start)
      : held.with(index, folded);
  return trimBuckets(next, now, windowMs);
}

/**
 * Buckets read back from disk: aligned to a bucket boundary, ordered, one per
 * start, none expired, and none more than one bucket in the future. A future
 * bucket means the wall clock moved backwards since it was written; keeping it
 * would re-emit it later.
 */
export function validateLoadedBuckets<Bucket extends HostStatsBucket>(
  buckets: ReadonlyArray<Bucket>,
  now: number,
): ReadonlyArray<Bucket> {
  const byStart = new Map(
    buckets
      .filter((bucket) => bucket.start % BUCKET_MS === 0 && bucket.start <= now + BUCKET_MS)
      .map((bucket) => [bucket.start, bucket]),
  );
  return trimBuckets(
    [...byStart.values()].toSorted((left, right) => left.start - right.start),
    now,
    WINDOW_MS,
  );
}
