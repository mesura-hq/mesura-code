// @effect-diagnostics nodeBuiltinImport:off - `HostOs` has no uptime; boot time is uptime before now.
import * as NodeOS from "node:os";
import {
  HOST_STATS_CONTRACT_VERSION,
  type HostStatsBucket,
  type HostStatsHostFacts,
  type HostStatsSample,
  type HostStatsSampleMessage,
  type HostStatsSnapshotMessage,
  toHostStatsBucketColumns,
} from "@t3tools/contracts";
import {
  HostProcessArchitecture,
  HostProcessHostname,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import { BUCKET_MS, SAMPLE_INTERVAL_MS, WINDOW_MS } from "./hostStatsBuckets.ts";
import { HostOs } from "./portableReaders.ts";

/**
 * What leaves the server is rounded: percents and temperatures to 0.1, bytes
 * and rates to whole numbers, load to 0.01. Full doubles would push a snapshot
 * of 144 buckets and an update with two GPUs past their 25 KB and 1 KB budgets,
 * and no client draws the digits they carry.
 */
const roundToDecimals =
  (decimals: number) =>
  <Value extends number | null>(value: Value): Value => {
    const factor = 10 ** decimals;
    return (value === null ? null : Math.round(value * factor) / factor) as Value;
  };
const tenths = roundToDecimals(1);
const hundredths = roundToDecimals(2);
const whole = roundToDecimals(0);

export function roundSampleForWire(sample: HostStatsSample): HostStatsSample {
  return {
    ...sample,
    cpuPercent: tenths(sample.cpuPercent),
    load1: hundredths(sample.load1),
    gpus: sample.gpus?.map((gpu) => ({ ...gpu, busyPercent: tenths(gpu.busyPercent) })) ?? null,
    cpuTemperatureC: tenths(sample.cpuTemperatureC),
    netRxBytesPerSec: whole(sample.netRxBytesPerSec),
    netTxBytesPerSec: whole(sample.netTxBytesPerSec),
  };
}

export function roundBucketForWire(bucket: HostStatsBucket): HostStatsBucket {
  return {
    ...bucket,
    cpuAvg: tenths(bucket.cpuAvg),
    cpuMax: tenths(bucket.cpuMax),
    memUsedAvg: whole(bucket.memUsedAvg),
    swapUsedAvg: whole(bucket.swapUsedAvg),
    diskUsedAvg: whole(bucket.diskUsedAvg),
    gpuBusyAvg: tenths(bucket.gpuBusyAvg),
    gpuBusyMax: tenths(bucket.gpuBusyMax),
    cpuTempMax: tenths(bucket.cpuTempMax),
    netRxAvg: whole(bucket.netRxAvg),
    netTxAvg: whole(bucket.netTxAvg),
  };
}

/** The host facts, read at `now`; boot time is on the server's clock, like `serverNow`. */
export const readHostFacts = (now: number) =>
  Effect.gen(function* () {
    return {
      hostname: yield* HostProcessHostname,
      platform: yield* HostProcessPlatform,
      arch: yield* HostProcessArchitecture,
      cpuCount: (yield* HostOs).cpus().length,
      bootedAt: Math.max(0, Math.round(now - NodeOS.uptime() * 1000)),
    } satisfies HostStatsHostFacts;
  });

export function makeSnapshotMessage(input: {
  readonly serverNow: number;
  readonly host: HostStatsHostFacts;
  readonly buckets: ReadonlyArray<HostStatsBucket>;
  readonly latest: HostStatsSample | null;
}): HostStatsSnapshotMessage {
  return {
    type: "snapshot",
    contractVersion: HOST_STATS_CONTRACT_VERSION,
    serverNow: input.serverNow,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    bucketMs: BUCKET_MS,
    windowMs: WINDOW_MS,
    host: input.host,
    buckets: toHostStatsBucketColumns(input.buckets.map(roundBucketForWire), BUCKET_MS),
    latest: input.latest === null ? null : roundSampleForWire(input.latest),
  };
}

export function makeSampleMessage(
  serverNow: number,
  sample: HostStatsSample,
  bucket: HostStatsBucket,
): HostStatsSampleMessage {
  return {
    type: "sample",
    serverNow,
    sample: roundSampleForWire(sample),
    bucket: roundBucketForWire(bucket),
  };
}
