import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  fromHostStatsBucketColumns,
  type HostStatsBucket,
  HostStatsBucketColumns,
  toHostStatsBucketColumns,
} from "./hostStats.ts";

const BUCKET_MS = 300_000;
const START = Date.parse("2026-09-28T12:00:00.000Z");

const bucketAt = (start: number, sampleCount: number): HostStatsBucket => ({
  start,
  sampleCount,
  cpuAvg: 25.5,
  cpuMax: 30,
  memUsedAvg: 4_000,
  swapUsedAvg: null,
  diskUsedAvg: 100_000,
  gpuBusyAvg: null,
  gpuBusyMax: null,
  cpuTempMax: 45.1,
  netRxAvg: 1_000,
  netTxAvg: 100,
  agentsRunningMax: 0,
});

const decodeColumns = Schema.decodeUnknownExit(HostStatsBucketColumns);

describe("host stats bucket columns", () => {
  it("phase 3 rework: buckets survive the columnar round trip with their gaps", () => {
    const buckets = [bucketAt(START, 5), bucketAt(START + 2 * BUCKET_MS, 3)];
    const encoded = toHostStatsBucketColumns(buckets, BUCKET_MS);
    expect(encoded.slots).toEqual([0, 2]);
    expect(Exit.isSuccess(decodeColumns(encoded))).toBe(true);
    expect(fromHostStatsBucketColumns(encoded)).toEqual(buckets);
  });

  it("phase 3 rework: decoding rejects a column with fewer values than slots", () => {
    const encoded = toHostStatsBucketColumns(
      [bucketAt(START, 5), bucketAt(START + BUCKET_MS, 4)],
      BUCKET_MS,
    );
    const short = { ...encoded, columns: { ...encoded.columns, sampleCount: [5] } };
    expect(Exit.isFailure(decodeColumns(short))).toBe(true);
    expect(() => fromHostStatsBucketColumns(short)).toThrow(/one value per ordered slot/);
  });

  it("phase 3 rework: decoding rejects slots that repeat or go backwards", () => {
    const encoded = toHostStatsBucketColumns(
      [bucketAt(START, 5), bucketAt(START + BUCKET_MS, 4)],
      BUCKET_MS,
    );
    expect(Exit.isFailure(decodeColumns({ ...encoded, slots: [1, 0] }))).toBe(true);
    expect(Exit.isFailure(decodeColumns({ ...encoded, slots: [0, 0] }))).toBe(true);
  });

  it("phase 3 rework: no buckets encode and decode as an empty history", () => {
    const encoded = toHostStatsBucketColumns([], BUCKET_MS);
    expect(Exit.isSuccess(decodeColumns(encoded))).toBe(true);
    expect(fromHostStatsBucketColumns(encoded)).toEqual([]);
  });
});
