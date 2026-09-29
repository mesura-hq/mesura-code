import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Bumped when a host stats message changes shape incompatibly. */
export const HOST_STATS_CONTRACT_VERSION = 1 as const;

const Percent = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }));
const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

export const HostStatsGpuVendor = Schema.Literals(["amd", "nvidia", "intel", "other"]);
export type HostStatsGpuVendor = typeof HostStatsGpuVendor.Type;

/** `sleeping` is a runtime-suspended GPU the server deliberately did not wake to measure. */
export const HostStatsGpuState = Schema.Literals(["active", "sleeping", "unavailable"]);
export type HostStatsGpuState = typeof HostStatsGpuState.Type;

export const HostStatsGpu = Schema.Struct({
  id: TrimmedNonEmptyString,
  vendor: HostStatsGpuVendor,
  state: HostStatsGpuState,
  busyPercent: Schema.NullOr(Percent),
  vramUsedBytes: Schema.NullOr(NonNegativeInt),
  vramTotalBytes: Schema.NullOr(NonNegativeInt),
});
export type HostStatsGpu = typeof HostStatsGpu.Type;

export const HostStatsMesuraServers = Schema.Struct({
  installed: NonNegativeInt,
  dev: NonNegativeInt,
});
export type HostStatsMesuraServers = typeof HostStatsMesuraServers.Type;

/**
 * One reading of the server's own host. Every metric is null when this host
 * cannot provide it or its reader failed; a null never means zero.
 */
export const HostStatsSample = Schema.Struct({
  /** Epoch milliseconds on the server's clock. */
  sampledAt: NonNegativeInt,
  cpuPercent: Schema.NullOr(Percent),
  load1: Schema.NullOr(NonNegativeFinite),
  cpuCount: Schema.NullOr(NonNegativeInt),
  memUsedBytes: Schema.NullOr(NonNegativeInt),
  memTotalBytes: Schema.NullOr(NonNegativeInt),
  swapUsedBytes: Schema.NullOr(NonNegativeInt),
  swapTotalBytes: Schema.NullOr(NonNegativeInt),
  diskUsedBytes: Schema.NullOr(NonNegativeInt),
  diskTotalBytes: Schema.NullOr(NonNegativeInt),
  gpus: Schema.NullOr(Schema.Array(HostStatsGpu)),
  cpuTemperatureC: Schema.NullOr(Schema.Finite),
  netRxBytesPerSec: Schema.NullOr(NonNegativeFinite),
  netTxBytesPerSec: Schema.NullOr(NonNegativeFinite),
  agentsRunning: Schema.NullOr(NonNegativeInt),
  agentSessionsOpen: Schema.NullOr(NonNegativeInt),
  mesuraServers: Schema.NullOr(HostStatsMesuraServers),
});
export type HostStatsSample = typeof HostStatsSample.Type;

/**
 * Five minutes of samples folded together. An average ignores null samples,
 * and a metric that was null in every sample of the bucket stays null.
 */
export const HostStatsBucket = Schema.Struct({
  /** Epoch milliseconds, aligned to a bucket boundary on the server's clock. */
  start: NonNegativeInt,
  sampleCount: NonNegativeInt,
  cpuAvg: Schema.NullOr(Percent),
  cpuMax: Schema.NullOr(Percent),
  memUsedAvg: Schema.NullOr(NonNegativeFinite),
  swapUsedAvg: Schema.NullOr(NonNegativeFinite),
  diskUsedAvg: Schema.NullOr(NonNegativeFinite),
  gpuBusyAvg: Schema.NullOr(Percent),
  gpuBusyMax: Schema.NullOr(Percent),
  cpuTempMax: Schema.NullOr(Schema.Finite),
  netRxAvg: Schema.NullOr(NonNegativeFinite),
  netTxAvg: Schema.NullOr(NonNegativeFinite),
  agentsRunningMax: Schema.NullOr(NonNegativeInt),
});
export type HostStatsBucket = typeof HostStatsBucket.Type;

/** What a client needs to label a host: the facts that do not change between samples. */
export const HostStatsHostFacts = Schema.Struct({
  hostname: Schema.String,
  /** Node's `process.platform`: `linux`, `darwin`, `win32`. */
  platform: Schema.String,
  /** Node's `process.arch`: `x64`, `arm64`. */
  arch: Schema.String,
  cpuCount: NonNegativeInt,
  /** Epoch milliseconds on the server's clock, so `serverNow - bootedAt` is the uptime. */
  bootedAt: NonNegativeInt,
});
export type HostStatsHostFacts = typeof HostStatsHostFacts.Type;

/**
 * Every bucket as one array per `HostStatsBucket` field, so a snapshot of 144
 * buckets does not repeat each field name 144 times. `slots[i]` is bucket i's
 * offset from `firstStart` in buckets; a missing bucket is a missing slot,
 * never a row of nulls. Every column has one entry per slot, and slots
 * strictly increase; decoding rejects a value that breaks either.
 */
function hasOneValuePerOrderedSlot(encoded: {
  readonly slots: ReadonlyArray<number>;
  readonly columns: Readonly<Record<string, ReadonlyArray<unknown>>>;
}): boolean {
  const slotCount = encoded.slots.length;
  return (
    encoded.slots.every((slot, index) => index === 0 || slot > encoded.slots[index - 1]!) &&
    Object.values(encoded.columns).every((column) => column.length === slotCount)
  );
}

export const HostStatsBucketColumns = Schema.Struct({
  /** The oldest bucket's `start`, or 0 when there are no buckets. */
  firstStart: NonNegativeInt,
  bucketMs: NonNegativeInt,
  slots: Schema.Array(NonNegativeInt),
  columns: Schema.Struct({
    sampleCount: Schema.Array(HostStatsBucket.fields.sampleCount),
    cpuAvg: Schema.Array(HostStatsBucket.fields.cpuAvg),
    cpuMax: Schema.Array(HostStatsBucket.fields.cpuMax),
    memUsedAvg: Schema.Array(HostStatsBucket.fields.memUsedAvg),
    swapUsedAvg: Schema.Array(HostStatsBucket.fields.swapUsedAvg),
    diskUsedAvg: Schema.Array(HostStatsBucket.fields.diskUsedAvg),
    gpuBusyAvg: Schema.Array(HostStatsBucket.fields.gpuBusyAvg),
    gpuBusyMax: Schema.Array(HostStatsBucket.fields.gpuBusyMax),
    cpuTempMax: Schema.Array(HostStatsBucket.fields.cpuTempMax),
    netRxAvg: Schema.Array(HostStatsBucket.fields.netRxAvg),
    netTxAvg: Schema.Array(HostStatsBucket.fields.netTxAvg),
    agentsRunningMax: Schema.Array(HostStatsBucket.fields.agentsRunningMax),
  }),
}).check(Schema.makeFilter(hasOneValuePerOrderedSlot));
export type HostStatsBucketColumns = typeof HostStatsBucketColumns.Type;

type HostStatsBucketColumnName = keyof HostStatsBucketColumns["columns"];
const BUCKET_COLUMN_NAMES = Object.keys(
  HostStatsBucketColumns.fields.columns.fields,
) as ReadonlyArray<HostStatsBucketColumnName>;

/** Buckets ordered by `start` and aligned to `bucketMs`, as the server holds them. */
export function toHostStatsBucketColumns(
  buckets: ReadonlyArray<HostStatsBucket>,
  bucketMs: number,
): HostStatsBucketColumns {
  const firstStart = buckets[0]?.start ?? 0;
  const columns = Object.fromEntries(
    BUCKET_COLUMN_NAMES.map((name) => [name, buckets.map((bucket) => bucket[name])]),
  ) as unknown as HostStatsBucketColumns["columns"];
  return {
    firstStart,
    bucketMs,
    slots: buckets.map((bucket) => Math.round((bucket.start - firstStart) / bucketMs)),
    columns,
  };
}

/**
 * Rows back from columns. Takes a decoded value; one built by hand that breaks
 * the one-value-per-slot invariant throws rather than yield buckets whose
 * required fields are missing.
 */
export function fromHostStatsBucketColumns(
  encoded: HostStatsBucketColumns,
): ReadonlyArray<HostStatsBucket> {
  if (!hasOneValuePerOrderedSlot(encoded)) {
    throw new Error("Host stats bucket columns must hold one value per ordered slot.");
  }
  return encoded.slots.map((slot, index) => {
    const bucket = { start: encoded.firstStart + slot * encoded.bucketMs } as Record<
      string,
      number | null
    >;
    for (const name of BUCKET_COLUMN_NAMES)
      bucket[name] = encoded.columns[name][index] as number | null;
    return bucket as unknown as HostStatsBucket;
  });
}

/** The first message of `subscribeHostStats`: everything the server holds. */
export const HostStatsSnapshotMessage = Schema.Struct({
  type: Schema.Literal("snapshot"),
  /** Compared with `HOST_STATS_CONTRACT_VERSION`; a client on another version shows "needs update". */
  contractVersion: NonNegativeInt,
  /** Epoch milliseconds on the server's clock when the message was built. */
  serverNow: NonNegativeInt,
  sampleIntervalMs: NonNegativeInt,
  bucketMs: NonNegativeInt,
  windowMs: NonNegativeInt,
  host: HostStatsHostFacts,
  buckets: HostStatsBucketColumns,
  latest: Schema.NullOr(HostStatsSample),
});
export type HostStatsSnapshotMessage = typeof HostStatsSnapshotMessage.Type;

/** One per sample: the sample and the bucket it folded into, which replaces the held one. */
export const HostStatsSampleMessage = Schema.Struct({
  type: Schema.Literal("sample"),
  serverNow: NonNegativeInt,
  sample: HostStatsSample,
  bucket: HostStatsBucket,
});
export type HostStatsSampleMessage = typeof HostStatsSampleMessage.Type;

export const HostStatsMessage = Schema.Union([HostStatsSnapshotMessage, HostStatsSampleMessage]);
export type HostStatsMessage = typeof HostStatsMessage.Type;
