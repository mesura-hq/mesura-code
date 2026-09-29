/**
 * Phase 2 fence of the hosts dock plan: acceptance criteria 2, 3, 6 and 7, as
 * the pure bucket functions carry them.
 *
 * Entry point: the pure functions `HostStatsService` folds every sample
 * through. The service-level half of each criterion is in
 * `HostStatsService.test.ts`.
 */
import type { HostStatsBucket, HostStatsSample } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  BUCKET_MS,
  bucketStartFor,
  foldSample,
  SAMPLE_INTERVAL_MS,
  trimBuckets,
  validateLoadedBuckets,
  WINDOW_MS,
} from "./hostStatsBuckets.ts";

const at = (iso: string) => Date.parse(iso);
const NOON = at("2026-09-28T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 3_600_000;

function sampleAt(sampledAt: number, overrides: Partial<HostStatsSample> = {}): HostStatsSample {
  return {
    sampledAt,
    cpuPercent: 25,
    load1: 1,
    cpuCount: 8,
    memUsedBytes: 4_000,
    memTotalBytes: 16_000,
    swapUsedBytes: 0,
    swapTotalBytes: 8_000,
    diskUsedBytes: 100_000,
    diskTotalBytes: 500_000,
    gpus: [
      {
        id: "0000:03:00.0",
        vendor: "amd",
        state: "active",
        busyPercent: 10,
        vramUsedBytes: 1_000,
        vramTotalBytes: 8_000,
      },
    ],
    cpuTemperatureC: 45,
    netRxBytesPerSec: 1_000,
    netTxBytesPerSec: 100,
    agentsRunning: 0,
    agentSessionsOpen: 0,
    mesuraServers: null,
    ...overrides,
  };
}

function gpuBusy(busyPercent: number | null): HostStatsSample["gpus"] {
  return [
    {
      id: "0000:03:00.0",
      vendor: "amd",
      state: busyPercent === null ? "sleeping" : "active",
      busyPercent,
      vramUsedBytes: null,
      vramTotalBytes: null,
    },
  ];
}

function bucketAt(start: number, overrides: Partial<HostStatsBucket> = {}): HostStatsBucket {
  return {
    start,
    sampleCount: 5,
    cpuAvg: 25,
    cpuMax: 30,
    memUsedAvg: 4_000,
    swapUsedAvg: 0,
    diskUsedAvg: 100_000,
    gpuBusyAvg: 10,
    gpuBusyMax: 12,
    cpuTempMax: 45,
    netRxAvg: 1_000,
    netTxAvg: 100,
    agentsRunningMax: 0,
    ...overrides,
  };
}

/**
 * The contract's fields only. The fold may carry its own bookkeeping on a
 * bucket (per-metric sample counts, say); these specs pin what clients see.
 */
function contractFields(bucket: HostStatsBucket): HostStatsBucket {
  return {
    start: bucket.start,
    sampleCount: bucket.sampleCount,
    cpuAvg: bucket.cpuAvg,
    cpuMax: bucket.cpuMax,
    memUsedAvg: bucket.memUsedAvg,
    swapUsedAvg: bucket.swapUsedAvg,
    diskUsedAvg: bucket.diskUsedAvg,
    gpuBusyAvg: bucket.gpuBusyAvg,
    gpuBusyMax: bucket.gpuBusyMax,
    cpuTempMax: bucket.cpuTempMax,
    netRxAvg: bucket.netRxAvg,
    netTxAvg: bucket.netTxAvg,
    agentsRunningMax: bucket.agentsRunningMax,
  };
}

/** Folds each sample in order, with `now` at that sample, the way the service does. */
function foldAll(
  samples: ReadonlyArray<HostStatsSample>,
  initial: ReadonlyArray<HostStatsBucket> = [],
): ReadonlyArray<HostStatsBucket> {
  return samples.reduce<ReadonlyArray<HostStatsBucket>>(
    (buckets, sample) => foldSample(buckets, sample, sample.sampledAt, WINDOW_MS),
    initial,
  );
}

describe("hostStatsBuckets phase 2 fence", () => {
  it("phase 2: the sampling constants are the plan's 60 s, 5 min and 12 h", () => {
    assert.strictEqual(SAMPLE_INTERVAL_MS, 60_000);
    assert.strictEqual(BUCKET_MS, 300_000);
    assert.strictEqual(WINDOW_MS, 12 * HOUR);
    assert.strictEqual(WINDOW_MS / BUCKET_MS, 144);
  });

  it("phase 2 AC2: bucketStartFor aligns a sample to its 5-minute wall-clock boundary", () => {
    assert.strictEqual(bucketStartFor(at("2026-09-28T12:03:27.500Z"), BUCKET_MS), NOON);
    assert.strictEqual(bucketStartFor(at("2026-09-28T12:04:59.999Z"), BUCKET_MS), NOON);
    assert.strictEqual(
      bucketStartFor(at("2026-09-28T12:05:00.000Z"), BUCKET_MS),
      at("2026-09-28T12:05:00.000Z"),
    );
    assert.strictEqual(
      bucketStartFor(at("2026-09-28T23:59:59.999Z"), BUCKET_MS),
      at("2026-09-28T23:55:00.000Z"),
    );
  });

  it("phase 2 AC2: one bucket holds the count, averages and maxima of its samples", () => {
    // The nulls sit mid-bucket on purpose: an average weighted by `sampleCount`
    // instead of by the non-null samples gives 17.5, 575, 65, 175 and 15 here.
    const buckets = foldAll([
      sampleAt(NOON + 10_000, {
        cpuPercent: 10,
        memUsedBytes: 1_000,
        swapUsedBytes: 0,
        diskUsedBytes: 500,
        gpus: gpuBusy(50),
        cpuTemperatureC: 40,
        netRxBytesPerSec: 100,
        netTxBytesPerSec: 10,
        agentsRunning: 0,
      }),
      sampleAt(NOON + MINUTE + 10_000, {
        cpuPercent: null,
        memUsedBytes: 2_000,
        swapUsedBytes: 0,
        diskUsedBytes: null,
        gpus: gpuBusy(null),
        cpuTemperatureC: 55,
        netRxBytesPerSec: null,
        netTxBytesPerSec: 20,
        agentsRunning: 2,
      }),
      sampleAt(NOON + 2 * MINUTE + 10_000, {
        cpuPercent: 40,
        memUsedBytes: 3_000,
        swapUsedBytes: 0,
        diskUsedBytes: 700,
        gpus: gpuBusy(70),
        cpuTemperatureC: null,
        netRxBytesPerSec: 300,
        netTxBytesPerSec: 30,
        agentsRunning: 1,
      }),
      sampleAt(NOON + 3 * MINUTE + 10_000, {
        cpuPercent: 10,
        memUsedBytes: 2_000,
        swapUsedBytes: 0,
        diskUsedBytes: 600,
        gpus: gpuBusy(90),
        cpuTemperatureC: 50,
        netRxBytesPerSec: 200,
        netTxBytesPerSec: null,
        agentsRunning: null,
      }),
    ]);

    assert.deepStrictEqual(buckets.map(contractFields), [
      {
        start: NOON,
        sampleCount: 4,
        cpuAvg: 20,
        cpuMax: 40,
        memUsedAvg: 2_000,
        swapUsedAvg: 0,
        diskUsedAvg: 600,
        gpuBusyAvg: 70,
        gpuBusyMax: 90,
        cpuTempMax: 55,
        netRxAvg: 200,
        netTxAvg: 20,
        agentsRunningMax: 2,
      },
    ]);
  });

  it("phase 2 AC2: a metric that is null in every sample of a bucket stays null, never zero", () => {
    const allNull = {
      cpuPercent: null,
      memUsedBytes: null,
      swapUsedBytes: null,
      diskUsedBytes: null,
      gpus: null,
      cpuTemperatureC: null,
      netRxBytesPerSec: null,
      netTxBytesPerSec: null,
      agentsRunning: null,
    } satisfies Partial<HostStatsSample>;
    const buckets = foldAll([sampleAt(NOON, allNull), sampleAt(NOON + MINUTE, allNull)]);

    assert.deepStrictEqual(buckets.map(contractFields), [
      {
        start: NOON,
        sampleCount: 2,
        cpuAvg: null,
        cpuMax: null,
        memUsedAvg: null,
        swapUsedAvg: null,
        diskUsedAvg: null,
        gpuBusyAvg: null,
        gpuBusyMax: null,
        cpuTempMax: null,
        netRxAvg: null,
        netTxAvg: null,
        agentsRunningMax: null,
      },
    ]);
  });

  it("phase 2 AC2: a sample on the next boundary opens a new bucket after the previous one", () => {
    const buckets = foldAll([
      sampleAt(NOON + 4 * MINUTE, { cpuPercent: 40 }),
      sampleAt(NOON + 5 * MINUTE, { cpuPercent: 60 }),
    ]);

    assert.deepStrictEqual(
      buckets.map((bucket) => [bucket.start, bucket.sampleCount, bucket.cpuAvg]),
      [
        [NOON, 1, 40],
        [NOON + 5 * MINUTE, 1, 60],
      ],
    );
  });

  it("phase 2 AC3: trimBuckets drops buckets older than 12 hours and keeps newer ones", () => {
    const now = NOON + 2 * MINUTE;
    const kept = trimBuckets(
      [
        bucketAt(NOON - 13 * HOUR),
        bucketAt(NOON - 12 * HOUR - BUCKET_MS),
        bucketAt(NOON - 11 * HOUR),
        bucketAt(NOON),
      ],
      now,
      WINDOW_MS,
    );

    assert.deepStrictEqual(
      kept.map((bucket) => bucket.start),
      [NOON - 11 * HOUR, NOON],
    );
  });

  it("phase 2 AC3: foldSample drops a bucket older than 12 hours on append", () => {
    const buckets = foldAll([sampleAt(NOON)], [bucketAt(NOON - 13 * HOUR)]);

    assert.deepStrictEqual(
      buckets.map((bucket) => bucket.start),
      [NOON],
    );
  });

  it("phase 2 AC3: thirteen hours of minute samples never hold more than 144 buckets", () => {
    let buckets: ReadonlyArray<HostStatsBucket> = [];
    let largest = 0;
    let now = NOON;
    for (let minute = 0; minute < 13 * 60; minute += 1) {
      now = NOON + minute * MINUTE;
      buckets = foldSample(buckets, sampleAt(now), now, WINDOW_MS);
      largest = Math.max(largest, buckets.length);
    }

    assert.strictEqual(largest, 144);
    assert.strictEqual(buckets.length, 144);
    assert.isTrue(buckets.every((bucket) => bucket.start >= now - WINDOW_MS));
    assert.strictEqual(buckets.at(-1)?.start, bucketStartFor(now, BUCKET_MS));
  });

  it("phase 2 AC3: validateLoadedBuckets drops buckets older than 12 hours", () => {
    const now = NOON + 2 * MINUTE;
    const loaded = validateLoadedBuckets(
      [bucketAt(NOON - 13 * HOUR), bucketAt(NOON - 6 * HOUR), bucketAt(NOON)],
      now,
    );

    assert.deepStrictEqual(
      loaded.map((bucket) => bucket.start),
      [NOON - 6 * HOUR, NOON],
    );
  });

  it("phase 2 AC6: validateLoadedBuckets drops buckets more than one bucket in the future", () => {
    const now = NOON + 2 * MINUTE;
    const loaded = validateLoadedBuckets(
      [
        bucketAt(NOON - BUCKET_MS),
        bucketAt(NOON),
        bucketAt(NOON + BUCKET_MS),
        bucketAt(NOON + 2 * BUCKET_MS),
        bucketAt(NOON + HOUR),
      ],
      now,
    );

    assert.deepStrictEqual(
      loaded.map((bucket) => bucket.start),
      [NOON - BUCKET_MS, NOON, NOON + BUCKET_MS],
    );
  });

  it("phase 2 AC7: a 10-minute gap between samples creates no bucket for the missed time", () => {
    const buckets = foldAll([
      sampleAt(NOON),
      sampleAt(NOON + MINUTE),
      sampleAt(NOON + 11 * MINUTE),
      sampleAt(NOON + 12 * MINUTE),
    ]);

    assert.deepStrictEqual(
      buckets.map((bucket) => [bucket.start, bucket.sampleCount]),
      [
        [NOON, 2],
        [NOON + 10 * MINUTE, 2],
      ],
    );
  });

  it("phase 2 regression: validateLoadedBuckets drops a bucket off a 5-minute boundary", () => {
    const now = NOON + 2 * MINUTE;
    const loaded = validateLoadedBuckets(
      [bucketAt(NOON - BUCKET_MS), bucketAt(NOON - BUCKET_MS + MINUTE), bucketAt(NOON + 1)],
      now,
    );

    assert.deepStrictEqual(
      loaded.map((bucket) => bucket.start),
      [NOON - BUCKET_MS],
    );
  });

  it("phase 2 regression: GPU busy uses the busiest active GPU; sleeping and unmeasured GPUs add nothing", () => {
    const gpu = (
      id: string,
      state: "active" | "sleeping" | "unavailable",
      busyPercent: number | null,
    ) => ({
      id,
      vendor: "other" as const,
      state,
      busyPercent,
      vramUsedBytes: null,
      vramTotalBytes: null,
    });
    const buckets = foldAll([
      sampleAt(NOON, {
        gpus: [
          gpu("igpu", "active", 30),
          gpu("dgpu", "active", 80),
          gpu("asleep", "sleeping", null),
          gpu("unread", "active", null),
        ],
      }),
      // Nothing measured: this sample must not pull the average down.
      sampleAt(NOON + MINUTE, {
        gpus: [gpu("asleep", "sleeping", null), gpu("gone", "unavailable", null)],
      }),
      sampleAt(NOON + 2 * MINUTE, { gpus: [] }),
      sampleAt(NOON + 3 * MINUTE, { gpus: null }),
      sampleAt(NOON + 4 * MINUTE, { gpus: [gpu("igpu", "active", 20), gpu("dgpu", "active", 10)] }),
    ]);

    assert.deepStrictEqual(
      buckets.map((bucket) => [bucket.sampleCount, bucket.gpuBusyAvg, bucket.gpuBusyMax]),
      [[5, 50, 80]],
    );
  });
});
